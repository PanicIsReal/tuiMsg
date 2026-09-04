import { spawn } from "node:child_process";

const child = spawn("bun", ["src/cli.tsx", "--help"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
child.stdout.on("data", (chunk) => {
  out += String(chunk);
});
child.stderr.on("data", (chunk) => {
  out += String(chunk);
});

const code: number = await new Promise((resolve) => {
  child.on("close", (c) => resolve(c ?? 1));
});

if (!out.includes("imsg") || !out.includes("--fake")) {
  process.stderr.write(`smoke failed, output:\n${out}\n`);
  process.exit(1);
}
if (code !== 0) {
  process.stderr.write(`help exited ${code}\n`);
  process.exit(code);
}
process.stdout.write("smoke ok\n");
