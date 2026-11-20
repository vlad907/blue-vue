import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { APP_ROOT } from "../paths.ts";

// The admin's Update button. Every server package carries build.json (when it
// was built); the repository carries latest.json describing the newest
// package. A newer one is downloaded, checked against its SHA-256, unpacked,
// and installed by the package's own installer, which restarts the server.
// Only an installed Windows server can do this; from source it's `git pull`.

const run = promisify(execFile);

export interface Build { built: string }
export interface Latest extends Build { package: string; url: string; sha256: string; size: number }
export type UpdatePhase = "idle" | "downloading" | "unpacking" | "installing" | "failed";

export interface UpdateStatus {
  /** This server's build, or null when it runs from source. */
  current: Build | null;
  /** Why this server can't update itself, if it can't. */
  cannot?: string;
  latest?: Latest;
  available: boolean;
  /** Why the newest version couldn't be looked up. */
  checkError?: string;
  phase: UpdatePhase;
  /** 0 to 1 while downloading. */
  progress?: number;
  error?: string;
}

const LATEST_URL = "https://raw.githubusercontent.com/vlad907/blue-vue/main/packaging/windows/latest.json";
const TASK = "BlueVueUpdate";

export interface UpdaterOptions {
  /** The folder the server is installed in (holds build.json and install-server.ps1). */
  root?: string;
  /** The folder with system.json, logs and the update work folder. */
  dataDir: string;
  latestUrl?: string;
  /** Unpacks the package and starts its installer. Tests pass their own. */
  install?: (zip: string, work: string) => Promise<void>;
  /** Whether this server can update itself; tests say yes. */
  cannot?: () => string | undefined;
}

export class Updater {
  private root: string;
  private phase: UpdatePhase = "idle";
  private progress?: number;
  private error?: string;
  private checked?: { at: number; latest?: Latest; error?: string };

  constructor(private opts: UpdaterOptions) {
    this.root = opts.root ?? APP_ROOT;
  }

  current(): Build | null {
    try {
      const b = JSON.parse(readFileSync(join(this.root, "build.json"), "utf8"));
      return typeof b.built === "string" ? { built: b.built } : null;
    } catch {
      return null;
    }
  }

  private cannot(): string | undefined {
    if (this.opts.cannot) return this.opts.cannot();
    if (!this.current()) return "This server runs from the source code, not from an installed package. Update it with git pull.";
    if (process.platform !== "win32" || !existsSync(join(this.root, "install-server.ps1"))) return "Only a server installed on Windows can update itself.";
    return undefined;
  }

  private async check(fresh: boolean) {
    if (!fresh && this.checked && Date.now() - this.checked.at < 60_000) return this.checked;
    try {
      const res = await fetch(`${this.opts.latestUrl ?? process.env.BLUEVUE_UPDATE_URL ?? LATEST_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const l = (await res.json()) as Latest;
      if (typeof l.built !== "string" || typeof l.url !== "string" || !/^[0-9a-f]{64}$/.test(String(l.sha256))) throw new Error("The update description on GitHub isn't readable");
      this.checked = { at: Date.now(), latest: l };
    } catch (err) {
      const why = (err as Error).name === "TimeoutError" || (err as Error).message === "fetch failed" ? "This server can't reach GitHub. Check its internet connection." : (err as Error).message;
      this.checked = { at: Date.now(), error: why };
    }
    return this.checked;
  }

  async status(fresh = false): Promise<UpdateStatus> {
    const current = this.current();
    const { latest, error: checkError } = await this.check(fresh);
    return {
      current,
      cannot: this.cannot(),
      latest,
      available: !!latest && (!current || Date.parse(latest.built) > Date.parse(current.built)),
      checkError,
      phase: this.phase,
      progress: this.progress,
      error: this.error,
    };
  }

  /** Starts the update and returns at once; follow it with status(). The server restarts at the end. */
  async start(): Promise<void> {
    if (this.phase !== "idle" && this.phase !== "failed") throw new Error("An update is already running");
    const cannot = this.cannot();
    if (cannot) throw new Error(cannot);
    const { latest, error } = await this.check(true);
    if (!latest) throw new Error(error ?? "Couldn't look up the newest version");
    this.phase = "downloading";
    this.progress = 0;
    this.error = undefined;
    void this.work(latest).catch((err) => {
      this.phase = "failed";
      this.progress = undefined;
      this.error = (err as Error).message;
    });
  }

  private async work(latest: Latest) {
    const work = join(this.opts.dataDir, "update");
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const zip = join(work, "package.zip");

    const res = await fetch(latest.url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`Downloading the update failed (GitHub answered ${res.status})`);
    const hash = createHash("sha256");
    let got = 0;
    const counted = Readable.fromWeb(res.body as never).on("data", (chunk: Buffer) => {
      hash.update(chunk);
      got += chunk.length;
      this.progress = latest.size ? Math.min(1, got / latest.size) : undefined;
    });
    await pipeline(counted, createWriteStream(zip));
    if (hash.digest("hex") !== latest.sha256) throw new Error("The downloaded update doesn't match what GitHub describes (it may have changed while downloading). Try again.");

    this.phase = "unpacking";
    this.progress = undefined;
    await (this.opts.install ?? ((z, w) => this.installOnWindows(z, w)))(zip, work);
    this.phase = "installing"; // the installer stops this server and starts the new one
  }

  /**
   * Unpacks the package and runs its installer from a one-off scheduled task:
   * the installer stops this server's own task, so it can't be this server's child.
   */
  private async installOnWindows(zip: string, work: string) {
    await run("tar", ["-xf", zip, "-C", work], { windowsHide: true });
    const installer = join(work, "BlueVue-Server", "install-server.ps1");
    if (!existsSync(installer)) throw new Error("The downloaded update has no installer in it");
    const logs = join(this.opts.dataDir, "logs");
    mkdirSync(logs, { recursive: true });
    const script = join(work, "run-update.cmd");
    writeFileSync(
      script,
      [
        "@echo off",
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${installer}" -InstallDir "${this.root}" -DataDir "${this.opts.dataDir}" > "${join(logs, "update.log")}" 2>&1`,
        `schtasks /Delete /TN ${TASK} /F >nul 2>&1`,
        "",
      ].join("\r\n"),
    );
    try {
      await run("schtasks", ["/Create", "/TN", TASK, "/TR", `cmd.exe /c "${script}"`, "/SC", "ONCE", "/ST", "00:00", "/RU", "SYSTEM", "/RL", "HIGHEST", "/F"], { windowsHide: true });
      await run("schtasks", ["/Run", "/TN", TASK], { windowsHide: true });
    } catch (err) {
      throw new Error(`Windows wouldn't start the installer. The server has to be the installed one (running as the BlueVueServer task). ${String((err as { stderr?: string }).stderr ?? (err as Error).message).trim()}`);
    }
  }
}

/** The data folder of an installed server: where its settings file is. */
export const updateDataDir = (configFile: string) => dirname(configFile);
