import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// Small pictures of NDI streams, read straight off the network by this server
// (not through the mosaic engine). The reading is done by one helper process,
// bluevue_ndi.py, started the first time a picture is asked for; it gets one
// JSON message per line and answers the same way (see the script's header).

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The command that runs the helper. BLUEVUE_NDI_HELPER replaces the whole
 * command (JSON list); BLUEVUE_PYTHON only the Python to use. Otherwise the
 * Python packed next to the server's Node, then whatever is on the PATH.
 */
export function ndiHelperCommand(): string[] {
  if (process.env.BLUEVUE_NDI_HELPER) return JSON.parse(process.env.BLUEVUE_NDI_HELPER);
  const script = [join(HERE, "bluevue_ndi.py"), join(HERE, "ndi", "bluevue_ndi.py")].find(existsSync) ?? join(HERE, "bluevue_ndi.py");
  const packed = join(dirname(process.execPath), "python", process.platform === "win32" ? "python.exe" : "bin/python3");
  const python = process.env.BLUEVUE_PYTHON ?? (existsSync(packed) ? packed : process.platform === "win32" ? "python" : "python3");
  return [python, script];
}

type Reply = { id?: number; event?: string; error?: string; sources?: string[]; jpeg?: string; signal?: string; waiting?: boolean };
export type NdiPicture = { waiting: true } | { jpeg: Buffer; signal: "ok" | "lost" };

/** Thrown when this machine can't read NDI at all (no helper), as opposed to one stream being missing. */
export class NdiUnavailable extends Error {}

const RETRY_MS = 30_000;

export class NdiReader {
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private problem?: string;
  private failedAt = 0;

  constructor(private command: () => string[] = ndiHelperCommand) {}

  private start() {
    if (this.child) return;
    // A helper that can't run isn't started again on every picture request.
    if (this.problem && Date.now() - this.failedAt < RETRY_MS) throw new NdiUnavailable(this.problem);
    const [cmd, ...args] = this.command();
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.problem = undefined;
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    child.stdin!.on("error", () => {});
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let m: Reply;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.event === "fatal") this.problem = String(m.error);
      if (typeof m.id !== "number") return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve(m);
    });
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.problem ??= why;
      this.failedAt = Date.now();
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new NdiUnavailable(this.problem));
      }
      this.pending.clear();
    };
    child.on("error", (err) =>
      gone((err as NodeJS.ErrnoException).code === "ENOENT" ? `Reading NDI needs Python with the cyndilib package, and "${cmd}" wasn't found on this machine` : `The NDI reader couldn't start: ${err.message}`),
    );
    child.on("exit", (code) => gone(`The NDI reader stopped (exit ${code})${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`));
  }

  private request(msg: Record<string, unknown>, timeoutMs = 8000): Promise<Reply> {
    this.start();
    const child = this.child!;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The NDI reader didn't answer in time"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(JSON.stringify({ id, ...msg }) + "\n");
    });
  }

  /** The NDI streams this machine sees on the network. */
  async sources(): Promise<string[]> {
    const r = await this.request({ op: "sources" });
    if (r.error) throw new Error(r.error);
    return r.sources ?? [];
  }

  /** The latest picture of a stream, by its full NDI name. "waiting" while the first frame is on its way. */
  async picture(name: string, width = 480): Promise<NdiPicture> {
    const r = await this.request({ op: "frame", name, width });
    if (r.error) throw new Error(r.error);
    if (!r.jpeg) return { waiting: true };
    return { jpeg: Buffer.from(r.jpeg, "base64"), signal: r.signal === "lost" ? "lost" : "ok" };
  }

  stop() {
    const child = this.child;
    this.child = undefined;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    child?.stdin?.end();
    child?.kill();
  }
}
