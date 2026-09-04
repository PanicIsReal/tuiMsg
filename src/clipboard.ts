export function osc52Sequence(text: string, tmux: boolean): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  const inner = `\x1b]52;c;${b64}\x07`;
  if (!tmux) return inner;
  return `\x1bPtmux;\x1b${inner}\x1b\\`;
}

export function writeClipboard(text: string, stdout: NodeJS.WritableStream = process.stdout): void {
  const tmux = Boolean(process.env.TMUX);
  stdout.write(osc52Sequence(text, tmux));
}
