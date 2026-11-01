import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentConfig, AppConfig } from "./config.ts";
import { log } from "./log.ts";

const execFileAsync = promisify(execFile);

export interface AppStatus {
  name: string;
  running: boolean | null; // null = not checked yet
  autoRestart: boolean;
  lastRestartAt?: string;
  error?: string;
}

/** How the watcher inspects and starts processes; swapped out in tests and simulation. */
export interface ProcessControl {
  isRunning(image: string): Promise<boolean>;
  start(task: string): Promise<void>;
  kill(image: string): Promise<void>;
}

/**
 * The agent runs as SYSTEM, and anything SYSTEM launches lands in session 0
 * where it is invisible on the wall. So apps are started through a scheduled
 * task that runs as the logged-in wall user (created by install-windows.ps1).
 */
export const windowsProcessControl: ProcessControl = {
  async isRunning(image) {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], { timeout: 5000 });
    return stdout.toLowerCase().includes(`"${image.toLowerCase()}"`);
  },
  async start(task) {
    await execFileAsync("schtasks", ["/Run", "/TN", task], { timeout: 5000 });
  },
  async kill(image) {
    await execFileAsync("taskkill", ["/IM", image, "/F"], { timeout: 5000 }).catch(() => {});
  },
};

export class SimulatedProcessControl implements ProcessControl {
  running = new Set<string>();
  apps: AppConfig[];
  constructor(apps: AppConfig[]) {
    this.apps = apps;
    for (const a of apps) this.running.add(a.process);
  }
  async isRunning(image: string) {
    return this.running.has(image);
  }
  async start(task: string) {
    const app = this.apps.find((a) => a.task === task);
    if (app) this.running.add(app.process);
    log(`[apps:sim] started task ${task}`);
  }
  async kill(image: string) {
    this.running.delete(image);
  }
}

/** Watches the wall's display software and restarts it if it stops. */
export class AppWatcher {
  private status = new Map<string, AppStatus>();
  private lastRestart = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  cfg: AgentConfig;
  proc: ProcessControl;
  // Don't fight an app that crashes on launch: at most one automatic restart per minute.
  minRestartGapMs = 60_000;

  constructor(cfg: AgentConfig, proc: ProcessControl) {
    this.cfg = cfg;
    this.proc = proc;
    for (const a of cfg.apps) this.status.set(a.name, { name: a.name, running: null, autoRestart: a.autoRestart });
  }

  start() {
    void this.check();
    this.timer = setInterval(() => void this.check(), this.cfg.pollSeconds * 1000);
  }

  stop() {
    clearInterval(this.timer);
  }

  list(): AppStatus[] {
    return [...this.status.values()];
  }

  async check() {
    for (const app of this.cfg.apps) {
      try {
        const running = await this.proc.isRunning(app.process);
        this.patch(app.name, { running, error: undefined });
        const last = this.lastRestart.get(app.name) ?? 0;
        if (!running && app.autoRestart && Date.now() - last >= this.minRestartGapMs) {
          log(`[apps] ${app.name} is not running; restarting`);
          await this.launch(app);
        }
      } catch (err) {
        this.patch(app.name, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** Kills and relaunches an app on request (e.g. from the control panel). */
  async restart(name: string) {
    const app = this.cfg.apps.find((a) => a.name === name);
    if (!app) throw new Error(`Unknown app "${name}"`);
    log(`[apps] restarting ${app.name} on request`);
    await this.proc.kill(app.process);
    await new Promise((r) => setTimeout(r, 1500));
    await this.launch(app);
    this.patch(app.name, { running: await this.proc.isRunning(app.process) });
  }

  private async launch(app: AppConfig) {
    this.lastRestart.set(app.name, Date.now());
    this.patch(app.name, { lastRestartAt: new Date().toISOString() });
    await this.proc.start(app.task);
  }

  private patch(name: string, update: Partial<AppStatus>) {
    this.status.set(name, { ...this.status.get(name)!, ...update });
  }
}
