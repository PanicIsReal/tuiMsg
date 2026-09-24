// Message text, names, and filenames come from other people and reach the terminal.
// Strip control characters so they cannot ring the bell, move the cursor, or smuggle
// escape sequences such as OSC 8 hyperlinks whose visible text hides their target.
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function cleanText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(CONTROLS, "");
}

export function cleanLine(value: string): string {
  return cleanText(value).replace(/\s*\n\s*/g, " ");
}
