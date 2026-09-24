import { execFile } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { cpus, homedir, release, totalmem } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { InputMode, Session } from "./domain/model.ts";

// What a --benchmark run records, as it happens and summed up at exit: startup, each imsg
// request, how long each key takes to reach the screen, the bytes sent to the terminal,
// picture decoding, event-loop stalls, and memory. It never holds message text, names,
// numbers or addresses, nor the keys typed into a text field.

type Key = { label: string; at: number; handled?: number };
type Picture = { width: number; height: number; columns: number; rows: number; protocol: string; ms: number; bytes: number; sixel: number };

const TEXT_FIELDS = new Set<InputMode["kind"]>(["composer", "search", "new-chat"]);
// A key whose update has not reached the screen by then changed nothing there.
const KEY_EXPIRY_MS = 1_000;
// Ink holds a frame back at most this long (30 frames a second), so a key still waiting when
// a later one arrives this much after it changed nothing, and the later key's frame is not
// its own.
const FRAME_HOLD_MS = 50;
const LAG_INTERVAL_MS = 100;
const STALL_MS = 100;
const SLOWEST = 10;

export class Benchmark {
  on = false;
  file = "";
  private buffer: { at: number; text: string }[] = [];
  private readonly milestones = new Map<string, number>();
  private readonly series = new Map<string, number[]>();
  private readonly totals = new Map<string, number>();
  private reading: Key[] = [];
  private waiting: Key[] = [];
  private slowest: { label: string; at: number; ms: number }[] = [];
  private frame = { ink: 0, diff: 0 };
  private window = { start: 0, bytes: 0 };
  private memory = { rss: [0, 0, 0], heap: [0, 0, 0], logged: 0 };
  private expected = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private finished = false;

  start(file: string, header: string[]): void {
    writeFileSync(file, `${header.join("\n")}\n\n`, { mode: 0o600 });
    this.file = file;
    this.on = true;
    this.expected = performance.now() + LAG_INTERVAL_MS;
    this.timers = [
      setInterval(() => this.tick(), LAG_INTERVAL_MS),
      setInterval(() => this.sample(), 5_000),
      setInterval(() => this.flush(), 1_000),
    ];
    for (const timer of this.timers) timer.unref?.();
    this.sample();
  }

  // One line of the timeline, stamped in seconds since the process started.
  note(text: string, at = performance.now()): void {
    if (this.on) this.buffer.push({ at, text: `${(at / 1000).toFixed(3).padStart(9)}  ${text}` });
  }

  // Keeps the first time something happened, for the summary's startup line. True that time.
  reached(name: string): boolean {
    if (!this.on || this.milestones.has(name)) return false;
    this.milestones.set(name, performance.now());
    return true;
  }

  add(name: string, value: number): void {
    const values = this.series.get(name);
    if (values) values.push(value); else this.series.set(name, [value]);
  }

  count(name: string, by = 1): void {
    this.totals.set(name, (this.totals.get(name) ?? 0) + by);
  }

  // Everything Ink reads from the terminal passes here; null ends one read of it, by which
  // time Ink has handled the keys in it.
  input(chunk: string | null, mode: InputMode["kind"]): void {
    const now = performance.now();
    if (chunk === null) {
      for (const key of this.reading) key.handled = now - key.at;
      this.waiting.push(...this.reading);
      this.reading = [];
      return;
    }
    const names = keyNames(chunk, mode);
    if (names.includes("f12")) this.mark();
    const label = summarize(names.filter((name) => name !== "f12"));
    if (!label) return;
    this.expire(FRAME_HOLD_MS);
    this.reading.push({ label: `${label} · ${mode}`, at: now });
  }

  mark(): void {
    this.count("marks");
    this.note("──── MARK (F12) ────");
  }

  inkRendered(ms: number): void {
    this.add("ink", ms);
    this.frame.ink = ms;
  }

  diffed(ms: number, bytes: number, whole: boolean): void {
    this.add("diff", ms);
    this.count("frame bytes", bytes);
    if (whole) this.count("whole redraws");
    this.frame.diff = ms;
  }

  sixel(bytes: number): void {
    this.count("sixel bytes", bytes);
  }

  // Every byte written to the terminal, and how long the write held the program: a write to
  // a terminal can wait for the SSH link to take it.
  sent(bytes: number, elapsed = 0): void {
    const now = performance.now();
    this.count("sent", bytes);
    this.add("write", elapsed);
    if (elapsed > 20) this.note(`write · ${size(bytes)} held the program for ${ms(elapsed)}`, now - elapsed);
    if (now - this.window.start >= 1_000) {
      this.window = { start: now, bytes: 0 };
    }
    this.window.bytes += bytes;
    this.totals.set("busiest second", Math.max(this.totals.get("busiest second") ?? 0, this.window.bytes));
  }

  // A batch of output left for the terminal; with a frame in it, the keys before it are on
  // screen.
  flushed(bytes: number, frame: boolean): void {
    if (!frame) return;
    const now = performance.now();
    this.count("frames");
    if (this.reached("first frame")) this.note("first frame on screen");
    const { ink, diff } = this.frame;
    this.frame = { ink: 0, diff: 0 };
    if (!this.waiting.length) {
      if (ink + diff > 20 || bytes > 16_384) this.note(`frame · Ink ${ms(ink)} · diff ${ms(diff)} · ${size(bytes)}`);
      return;
    }
    for (const key of this.waiting) {
      const latency = now - key.at;
      this.add("screen", latency);
      this.add(`screen\u0000${key.label}`, latency);
      this.slowest.push({ label: key.label, at: key.at, ms: latency });
      this.note(`key ${key.label} · on screen ${ms(latency)} · handled ${ms(key.handled ?? latency)} · Ink ${ms(ink)} · diff ${ms(diff)} · ${size(bytes)}`, key.at);
    }
    this.slowest = this.slowest.sort((a, b) => b.ms - a.ms).slice(0, SLOWEST);
    this.waiting = [];
  }

  request(method: string, elapsed: number, bytes: number, outcome?: string): void {
    this.add(`imsg\u0000${method}`, elapsed);
    this.count(`imsg bytes\u0000${method}`, bytes);
    if (outcome) this.count(`imsg ${outcome}`);
    this.note(`imsg ${method} · ${ms(elapsed)} · ${size(bytes)}${outcome ? ` · ${outcome}` : ""}`);
  }

  event(method: string, bytes: number): void {
    this.count(`event\u0000${method}`);
    this.count("event bytes", bytes);
    this.note(`imsg event ${method} · ${size(bytes)}`);
  }

  picture(picture: Picture): void {
    this.add("decode", picture.ms);
    this.note(`picture ${picture.width}×${picture.height} px → ${picture.columns}×${picture.rows} cells · ${picture.protocol} · decoded in ${ms(picture.ms)} from ${size(picture.bytes)}${picture.sixel ? ` · sixel ${size(picture.sixel)}` : ""}`);
  }

  attachment(elapsed: number, bytes: number, failed: boolean): void {
    this.add("attachment", elapsed);
    this.count("attachment bytes", bytes);
    this.note(`attachment · ${failed ? "failed" : size(bytes)} · ${ms(elapsed)}`);
  }

  intent(type: string, elapsed: number): void {
    this.add(`intent\u0000${type}`, elapsed);
    if (elapsed > 16) this.note(`intent ${type} · ${ms(elapsed)}`);
  }

  flush(): void {
    if (!this.buffer.length || !this.file) return;
    // A key's line is stamped when it was pressed but written once its frame is out.
    const lines = this.buffer.sort((a, b) => a.at - b.at).map((line) => line.text);
    this.buffer = [];
    try { appendFileSync(this.file, `${lines.join("\n")}\n`); } catch { this.on = false; }
  }

  // Writes the summary, once, and stops recording.
  finish(reason: string): void {
    if (!this.on || this.finished) return;
    this.finished = true;
    for (const timer of this.timers) clearInterval(timer);
    this.expire(Number.POSITIVE_INFINITY);
    this.sample();
    this.note(`end · ${reason}`);
    this.flush();
    try { appendFileSync(this.file, `\n${this.summary(reason).join("\n")}\n`); } catch { /* the disk is full or gone */ }
    this.on = false;
  }

  summary(reason: string): string[] {
    const lines: string[] = [`──── summary ${"─".repeat(60)}`];
    // A titled block: the title on its first line, the rest indented under it.
    const block = (title: string, items: string[]) => items.forEach((item, index) => lines.push(`${(index ? "" : title).padEnd(18)} ${item}`));
    const total = (name: string) => this.totals.get(name) ?? 0;
    const table = (groups: { name: string; values: number[] }[], extra = (_name: string) => "") => {
      const width = largest(groups.map(({ name }) => name.length));
      return groups.map(({ name, values }) => `${name.padEnd(width)}  ${String(values.length).padStart(5)} · ${spread(values)}${extra(name)}`);
    };
    block("ran for", [`${seconds(performance.now())} (${reason})`]);
    const startup = [...this.milestones].map(([name, at]) => `${name} ${seconds(at)}`);
    if (startup.length) block("startup", [startup.join(" · ")]);

    const screen = this.series.get("screen") ?? [];
    const unchanged = total("keys without a change");
    block("keys → screen", [
      screen.length ? `${screen.length} keys · ${spread(screen)}` : "no keys reached the screen",
      ...(unchanged ? [`${unchanged} changed nothing on screen`] : []),
      ...table(this.grouped("screen").sort((a, b) => b.values.length - a.values.length).slice(0, 15)),
    ]);
    block("slowest keys", this.slowest.map((key) => `${ms(key.ms).padStart(9)}  ${key.label} at ${(key.at / 1000).toFixed(3)} s`));

    block("frames", [`${total("frames")} · Ink render ${spread(this.series.get("ink") ?? [])}`, `diff ${spread(this.series.get("diff") ?? [])} · ${total("whole redraws")} whole redraws`]);
    const writes = this.series.get("write") ?? [];
    block("terminal output", [
      `${size(total("sent"))} · frames ${size(total("frame bytes"))} · sixel ${size(total("sixel bytes"))} · busiest second ${size(total("busiest second"))}`,
      `writes ${spread(writes)} · ${writes.filter((value) => value > 20).length} held the program over 20 ms`,
    ]);

    const requests = this.grouped("imsg").sort((a, b) => sum(b.values) - sum(a.values));
    const problems = ["timed out", "failed", "error"].filter((outcome) => total(`imsg ${outcome}`)).map((outcome) => `${total(`imsg ${outcome}`)} ${outcome}`);
    block("imsg requests", requests.length
      ? [...table(requests, (name) => ` · ${size(total(`imsg bytes\u0000${name}`))}`), problems.length ? problems.join(" · ") : "none timed out or failed"]
      : ["none"]);
    const events = [...this.totals].filter(([name]) => name.startsWith("event\u0000")).map(([name, count]) => `${name.slice(6)} ${count}`);
    block("imsg events", [events.length ? `${events.join(" · ")} · ${size(total("event bytes"))}` : "none"]);

    const decode = this.series.get("decode") ?? [];
    block("pictures", [decode.length ? `${decode.length} decoded · ${spread(decode)}` : "none"]);
    const attachments = this.series.get("attachment") ?? [];
    block("attachments", [attachments.length ? `${attachments.length} loaded · ${spread(attachments)} · ${size(total("attachment bytes"))}` : "none"]);
    // The intents that cost the most time in all, the work each keypress or event set off.
    block("intents", table(this.grouped("intent").sort((a, b) => sum(b.values) - sum(a.values)).slice(0, 8)));

    const lag = this.series.get("lag") ?? [];
    block("event loop", [`lag ${spread(lag)} · ${lag.filter((value) => value > STALL_MS).length} stalls over ${STALL_MS} ms`]);
    const [rssStart, rssPeak, rssEnd] = this.memory.rss;
    const [heapStart, heapPeak, heapEnd] = this.memory.heap;
    block("memory", [`rss ${size(rssStart!)} → ${size(rssEnd!)} (peak ${size(rssPeak!)}) · heap ${size(heapStart!)} → ${size(heapEnd!)} (peak ${size(heapPeak!)})`]);
    if (total("marks")) block("marks", [`${total("marks")} (search for MARK)`]);
    return lines;
  }

  private grouped(prefix: string): { name: string; values: number[] }[] {
    return [...this.series].filter(([name]) => name.startsWith(`${prefix}\u0000`)).map(([name, values]) => ({ name: name.slice(prefix.length + 1), values }));
  }

  private tick(): void {
    const now = performance.now();
    const lag = Math.max(0, now - this.expected);
    this.expected = now + LAG_INTERVAL_MS;
    this.add("lag", lag);
    if (lag > STALL_MS) this.note(`stall · the event loop was blocked for at least ${ms(lag)}`, now - lag);
    this.expire(KEY_EXPIRY_MS);
  }

  private expire(age: number): void {
    const now = performance.now();
    const stale = this.waiting.filter((key) => now - key.at >= age);
    if (!stale.length) return;
    this.waiting = this.waiting.filter((key) => now - key.at < age);
    for (const key of stale) {
      this.count("keys without a change");
      this.note(`key ${key.label} · handled ${ms(key.handled ?? 0)} · no change on screen`, key.at);
    }
  }

  private sample(): void {
    const { rss, heapUsed } = process.memoryUsage();
    const track = (values: number[], value: number) => {
      if (!values[0]) values[0] = value;
      values[1] = Math.max(values[1]!, value);
      values[2] = value;
    };
    track(this.memory.rss, rss);
    track(this.memory.heap, heapUsed);
    const now = performance.now();
    if (now - this.memory.logged >= 60_000) {
      this.memory.logged = now;
      this.note(`memory · rss ${size(rss)} · heap ${size(heapUsed)}`);
    }
  }
}

export const benchmark = new Benchmark();

// Records keys, output, intents, attachments and the session's milestones. Only called for
// a --benchmark run.
export function instrument(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, session: Session): void {
  // Ink drains stdin with read() until it returns null.
  const read = stdin.read.bind(stdin);
  stdin.read = ((size?: number) => {
    const chunk = read(size) as string | Buffer | null;
    benchmark.input(chunk === null ? null : String(chunk), session.getSnapshot().input.kind);
    return chunk;
  }) as typeof stdin.read;
  const write = stdout.write;
  stdout.write = function (this: NodeJS.WriteStream, chunk: string | Uint8Array, ...rest: unknown[]) {
    const began = performance.now();
    const result = Reflect.apply(write, this, [chunk, ...rest]) as boolean;
    benchmark.sent(typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength, performance.now() - began);
    return result;
  } as typeof stdout.write;
  stdout.on("resize", () => benchmark.note(`resize · ${stdout.columns}×${stdout.rows}`));

  const act = session.act;
  session.act = (intent) => {
    const began = performance.now();
    try { act(intent); } finally { benchmark.intent(intent.type, performance.now() - began); }
  };
  const load = session.loadAttachment;
  session.loadAttachment = async (attachment) => {
    const began = performance.now();
    try {
      const bytes = await load(attachment);
      benchmark.attachment(performance.now() - began, bytes.byteLength, false);
      return bytes;
    } catch (error) {
      benchmark.attachment(performance.now() - began, 0, true);
      throw error;
    }
  };

  let previous = session.getSnapshot();
  session.subscribe(() => {
    const state = session.getSnapshot();
    if (state.connection !== previous.connection) {
      benchmark.note(`connection ${state.connection}`);
      if (state.connection === "online") benchmark.reached("online");
    }
    if (state.chatsStatus !== previous.chatsStatus) {
      benchmark.note(`conversations ${state.chatsStatus}${state.chatsStatus === "ready" ? ` · ${state.chats.size}` : ""}`);
      if (state.chatsStatus === "ready") benchmark.reached("conversations");
    }
    if (state.selected && state.selected !== previous.selected) benchmark.note("conversation opened");
    const history = state.selected ? state.history.get(state.selected)?.kind : undefined;
    const before = state.selected ? previous.history.get(state.selected)?.kind : undefined;
    if (state.selected && history !== before && (history === "ready" || history === "loading")) {
      benchmark.note(`transcript ${history} · ${state.messages.get(state.selected)?.length ?? 0} messages`);
    }
    // Notices can name a file or a conversation, so only their kind is kept.
    if (state.notice && state.notice !== previous.notice) benchmark.note(`notice ${state.notice.kind}`);
    previous = state;
  });
}

// The facts about this machine and terminal that bear on speed; nothing that names anyone.
export function describeEnvironment(version: string, imsg: string | undefined): string[] {
  const now = new Date();
  const cpu = cpus();
  return [
    `tuiMsg benchmark · ${now.toISOString()} (local ${now.toString().slice(0, 24)})`,
    "Timings, sizes and counts only: no message text, names, numbers or addresses, and no",
    "typing: only keys that are commands are named. Press F12 to mark a moment in this log.",
    "",
    `tuimsg      ${version}`,
    `runtime     ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`} · ${process.platform} ${process.arch} · kernel ${release()}`,
    `machine     ${cpu.length} × ${cpu[0]?.model.trim() || "unknown CPU"} · ${size(totalmem())} memory`,
    `imsg        ${imsg ? redact(imsg) : "not found"}`,
    `ssh         ${process.env.SSH_CONNECTION || process.env.SSH_TTY ? "yes" : "no"}`,
    `terminal    TERM=${process.env.TERM ?? "-"} · TERM_PROGRAM=${process.env.TERM_PROGRAM ?? "-"} · COLORTERM=${process.env.COLORTERM ?? "-"} · LANG=${process.env.LANG ?? "-"}`,
  ];
}

// Details that take a child process to learn, noted when they arrive rather than holding up
// the start.
export function describeLater(imsg: string | undefined): void {
  const here = dirname(fileURLToPath(import.meta.url));
  void Promise.all([
    run("git", ["-C", here, "rev-parse", "--short", "HEAD"]),
    run("git", ["-C", here, "status", "--porcelain", "--untracked-files=no"]),
    process.platform === "darwin" ? run("sw_vers", ["-productVersion"]) : Promise.resolve(undefined),
    imsg ? run(imsg, ["--version"]) : Promise.resolve(undefined),
  ]).then(([commit, changes, macOS, imsgVersion]) => {
    benchmark.note(`details · commit ${commit ?? "unknown"}${changes ? " with local changes" : ""}${macOS ? ` · macOS ${macOS}` : ""}${imsg ? ` · imsg ${imsgVersion ? redact(imsgVersion) : "version unknown"}` : ""}`);
  });
}

// Hides what could identify someone in a crash's error: the home directory, addresses, numbers.
export function redact(text: string): string {
  const home = homedir();
  return (home ? text.split(home).join("~") : text)
    .replace(/[^\s@'"<>()]+@[^\s@'"<>()]+/g, "<address>")
    .replace(/\+?\d[\d ().-]{5,}\d/g, "<number>");
}

function run(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { encoding: "utf8", timeout: 3_000 }, (error, stdout, stderr) => {
        const text = `${stdout}`.trim() || `${stderr}`.trim();
        resolve(!error ? text.split("\n")[0]!.slice(0, 80) : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

// The keys that are commands outside a text field. Anything else typed there, as a message
// typed before the composer was open, is logged as "other", not spelled out.
const COMMAND_KEYS = new Set([..."jkgrRtyvosamixnqL?/!"]);
const REACTION_KEYS = new Set([..."jkx123456"]);

// Names the keys in one read, without the text typed into a field.
export function keyNames(chunk: string, mode: InputMode["kind"]): string[] {
  const field = TEXT_FIELDS.has(mode);
  const commands = mode === "tapback" ? REACTION_KEYS : COMMAND_KEYS;
  const names: string[] = [];
  const pattern = /\x1b\[<(\d+);\d+;\d+([Mm])|\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)|\x1b\[([\d;:?<=>]*)[ -/]*([@-~])|\x1bO([\s\S])|\x1b([\s\S])|\x1b|([\x00-\x1f\x7f])|([^\x00-\x1f\x7f\x1b]+)/g;
  for (const match of chunk.matchAll(pattern)) {
    const [whole, button, press, parameters, final, ss3, alt, control, text] = match;
    if (button !== undefined) {
      const code = Number(button);
      if (press === "m" || code & 32) continue;
      names.push(code === 64 ? "wheel up" : code === 65 ? "wheel down" : "click");
    } else if (whole.startsWith("\x1b[200~")) names.push("paste");
    else if (final !== undefined) names.push(final === "~" ? TILDE[(parameters ?? "").split(";")[0]!] ?? "sequence" : CSI[final] ?? "sequence");
    else if (ss3 !== undefined) names.push(SS3[ss3] ?? "sequence");
    else if (alt !== undefined) names.push("alt+key");
    else if (whole === "\x1b") names.push("esc");
    else if (control !== undefined) names.push(CONTROL[control] ?? `ctrl+${String.fromCharCode(control.charCodeAt(0) + 96)}`);
    else if (text !== undefined) {
      // Outside a field a key is a command, one per read. Several different ones in one read
      // are text typed just as a field opened (i, then a word), so they are not spelled out;
      // a held key's repeats are.
      const characters = [...text];
      if (field || characters.some((character) => character !== characters[0])) names.push("typing");
      else for (const character of characters) names.push(commands.has(character) ? character : "other");
    }
  }
  return names;
}

const CSI: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "shift+tab" };
const SS3: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", P: "f1", Q: "f2", R: "f3", S: "f4" };
const TILDE: Record<string, string> = {
  "1": "home", "2": "insert", "3": "delete", "4": "end", "5": "page up", "6": "page down", "7": "home", "8": "end",
  "15": "f5", "17": "f6", "18": "f7", "19": "f8", "20": "f9", "21": "f10", "23": "f11", "24": "f12",
};
const CONTROL: Record<string, string> = { "\r": "enter", "\n": "ctrl+j", "\t": "tab", "\x7f": "backspace", "\b": "backspace", "\x00": "ctrl+space", "\x1c": "ctrl+\\", "\x1d": "ctrl+]", "\x1e": "ctrl+^", "\x1f": "ctrl+_" };

// "j j j" reads as "j ×3".
function summarize(names: string[]): string {
  const parts: string[] = [];
  for (let index = 0; index < names.length;) {
    let end = index;
    while (names[end + 1] === names[index]) end++;
    parts.push(end > index ? `${names[index]} ×${end - index + 1}` : names[index]!);
    index = end + 1;
  }
  const label = parts.join(" ");
  return label.length > 40 ? `${label.slice(0, 39)}…` : label;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

function spread(values: number[]): string {
  if (!values.length) return "none";
  if (values.length === 1) return ms(values[0]!);
  const median = `median ${ms(percentile(values, 0.5))}`;
  return values.length < 20 ? `${median} · max ${ms(largest(values))}` : `${median} · p95 ${ms(percentile(values, 0.95))} · max ${ms(largest(values))}`;
}

// Math.max(...values) overflows the stack on a long run's hundred thousand samples.
function largest(values: number[]): number {
  let result = 0;
  for (const value of values) if (value > result) result = value;
  return result;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function ms(value: number): string {
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)} s`;
  if (value >= 100) return `${Math.round(value)} ms`;
  return `${value.toFixed(value < 1 ? 2 : 1)} ms`;
}

function size(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function seconds(value: number): string {
  const total = Math.round(value / 1_000);
  return total >= 60 ? `${Math.floor(total / 60)} min ${total % 60} s` : `${(value / 1_000).toFixed(2)} s`;
}
