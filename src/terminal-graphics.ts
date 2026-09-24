// Picks how pictures are drawn. Kitty-protocol terminals are recognised from the
// environment; others are asked whether they speak sixel (DA1 attribute 4) and how many
// pixels a cell holds (CSI 16 t, or CSI 14 t divided by the grid). Anything else, and any
// terminal that stays silent, gets half-block cells.

export type GraphicsProtocol = "kitty" | "sixel" | "blocks";
export type CellSize = { width: number; height: number };
export type Graphics = { protocol: GraphicsProtocol; cell: CellSize };
export type ProbeReplies = { attributes?: number[]; cell?: CellSize; textArea?: CellSize };

// Windows Terminal and the VT340 lay sixels out on 10×20 pixel cells.
const VT340_CELL: CellSize = { width: 10, height: 20 };
const QUERY = "\x1b[16t\x1b[14t\x1b[c";
// Windows Terminal 1.22 previews before 1.22.2702 dropped the ESC from replies relayed through
// ConPTY (microsoft/terminal#17813), so it is optional; otherwise the rest would reach Ink as keys.
const REPLY = /\x1b?\[\?[\d;]*c|\x1b?\[[46];\d+;\d+t/g;
const ATTRIBUTES = /\x1b?\[\?([\d;]*)c/;

export function kittyFromEnvironment(env: NodeJS.ProcessEnv): boolean {
  // TERM survives SSH; the TERM_PROGRAM and KITTY_* variables usually do not.
  return !env.TMUX && (Boolean(env.KITTY_WINDOW_ID) || env.TERM === "xterm-kitty" || env.TERM === "xterm-ghostty" || env.TERM_PROGRAM === "WezTerm" || env.TERM_PROGRAM === "ghostty");
}

export function parseProbeReplies(text: string): ProbeReplies {
  const replies: ProbeReplies = {};
  const attributes = ATTRIBUTES.exec(text);
  if (attributes) replies.attributes = attributes[1]!.split(";").filter(Boolean).map(Number);
  const cell = /\x1b?\[6;(\d+);(\d+)t/.exec(text);
  if (cell) replies.cell = { height: Number(cell[1]), width: Number(cell[2]) };
  const area = /\x1b?\[4;(\d+);(\d+)t/.exec(text);
  if (area) replies.textArea = { height: Number(area[1]), width: Number(area[2]) };
  return replies;
}

// A sixel is sized in pixels but must cover its placeholder cells exactly, so an unknown
// cell size means no sixel at all.
export function chooseGraphics(env: NodeJS.ProcessEnv, replies: ProbeReplies, grid: { columns: number; rows: number }): Graphics {
  const forced = env.TUIMSG_IMAGES?.toLowerCase();
  const measured = usableCell(replies.cell) ?? usableCell(replies.textArea && grid.columns > 0 && grid.rows > 0
    ? { width: Math.floor(replies.textArea.width / grid.columns), height: Math.floor(replies.textArea.height / grid.rows) }
    : undefined);
  if (forced === "blocks") return { protocol: "blocks", cell: VT340_CELL };
  if (forced === "kitty" || (forced !== "sixel" && kittyFromEnvironment(env))) return { protocol: "kitty", cell: measured ?? VT340_CELL };
  if (forced === "sixel") return { protocol: "sixel", cell: measured ?? VT340_CELL };
  if (replies.attributes?.includes(4) && measured) return { protocol: "sixel", cell: measured };
  return { protocol: "blocks", cell: measured ?? VT340_CELL };
}

function usableCell(cell: CellSize | undefined): CellSize | undefined {
  return cell && cell.width >= 2 && cell.height >= 2 && cell.width <= 200 && cell.height <= 400 ? cell : undefined;
}

// Asks the terminal before Ink owns stdin. Keys typed meanwhile go back to the stream.
export function probeTerminal(input: NodeJS.ReadStream, output: NodeJS.WriteStream, timeoutMs = 1_500): Promise<ProbeReplies> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") return Promise.resolve({});
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  let received = "";
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      input.removeListener("readable", onReadable);
      const typed = received.replace(REPLY, "");
      try { if (typed) input.unshift(Buffer.from(typed, "latin1")); } catch { /* the keys are lost, nothing else */ }
      if (!wasRaw) input.setRawMode(false);
      resolve(parseProbeReplies(received));
    };
    const onReadable = () => {
      for (let chunk: Buffer | string | null = input.read(); chunk !== null; chunk = input.read()) {
        received += typeof chunk === "string" ? chunk : chunk.toString("latin1");
      }
      // Terminals answer in order, so DA1 arrives last.
      if (ATTRIBUTES.test(received)) finish();
    };
    timer = setTimeout(finish, timeoutMs);
    input.on("readable", onReadable);
    output.write(QUERY);
  });
}

export async function detectGraphics(input: NodeJS.ReadStream, output: NodeJS.WriteStream, env: NodeJS.ProcessEnv = process.env): Promise<Graphics> {
  const forced = env.TUIMSG_IMAGES?.toLowerCase();
  const needsProbe = forced !== "blocks" && forced !== "kitty" && !(forced !== "sixel" && kittyFromEnvironment(env));
  const replies = needsProbe ? await probeTerminal(input, output) : {};
  return chooseGraphics(env, replies, { columns: output.columns ?? 0, rows: output.rows ?? 0 });
}
