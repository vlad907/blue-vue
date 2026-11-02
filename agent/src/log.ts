import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

// The agent runs as a background task with no console, so it also logs to a file.
const dir = join(import.meta.dirname, "..", "logs");
const file = join(dir, "agent.log");
const MAX_BYTES = 5 * 1024 * 1024;

let dirReady = false;

export function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    if (!dirReady) {
      mkdirSync(dir, { recursive: true });
      dirReady = true;
    }
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, file + ".1");
    appendFileSync(file, line + "\n");
  } catch {}
}
