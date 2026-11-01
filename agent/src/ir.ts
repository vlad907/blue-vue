import { execFile } from "node:child_process";
import { Socket } from "node:net";
import { promisify } from "node:util";
import type { IrConfig } from "./config.ts";
import { log } from "./log.ts";

const execFileAsync = promisify(execFile);
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ProntoCode {
  freqHz: number;
  /** Carrier-cycle on/off durations: the once part followed by the repeat part. */
  pulses: number[];
  /** Index into `pulses` where the repeat part starts. */
  repeatStart: number;
}

/**
 * Parses a raw (learned) Pronto hex code: 0000 FREQ ONCE_PAIRS REPEAT_PAIRS ...
 * Pronto durations are already in carrier cycles, which is what Global Caché
 * sendir expects, so no time conversion is needed.
 */
export function parsePronto(hex: string): ProntoCode {
  const words = hex.trim().split(/\s+/).map((w) => parseInt(w, 16));
  if (words.length < 4 || words.some(Number.isNaN)) throw new Error("Invalid Pronto code");
  const [type, freqCode, once, repeat] = words;
  if (type !== 0) throw new Error("Only raw Pronto codes (starting 0000) are supported");
  const pulses = words.slice(4);
  if (pulses.length !== (once + repeat) * 2) throw new Error(`Pronto length mismatch: expected ${(once + repeat) * 2} durations, got ${pulses.length}`);
  return { freqHz: Math.round(1_000_000 / (freqCode * 0.241246)), pulses, repeatStart: once * 2 };
}

export interface IrTransmitter {
  send(port: number, code: ProntoCode, repeat: number, meta: { remote?: string; key?: string; pronto: string }): Promise<void>;
}

/** Global Caché iTach IP2IR / GC-100 over TCP port 4998. */
export class GlobalCacheTransmitter implements IrTransmitter {
  host: string;
  module: number;
  tcpPort: number;
  private seq = 1;

  constructor(host: string, module = 1, tcpPort = 4998) {
    this.host = host;
    this.module = module;
    this.tcpPort = tcpPort;
  }

  send(port: number, code: ProntoCode, repeat: number) {
    const id = (this.seq = (this.seq % 65535) + 1);
    const cmd = ["sendir", `${this.module}:${port}`, id, code.freqHz, repeat, code.repeatStart + 1, ...code.pulses].join(",");

    return new Promise<void>((resolve, reject) => {
      const sock = new Socket();
      let buf = "";
      const fail = (err: Error) => { sock.destroy(); reject(err); };
      sock.setTimeout(4000, () => fail(new Error(`Global Caché ${this.host} timed out`)));
      sock.on("error", fail);
      sock.on("data", (d) => {
        buf += d.toString();
        if (buf.includes(`completeir,${this.module}:${port},${id}`)) {
          sock.end();
          resolve();
        } else if (/ERR|busyIR/.test(buf)) {
          fail(new Error(`Global Caché error: ${buf.trim()}`));
        }
      });
      sock.connect(this.tcpPort, this.host, () => sock.write(cmd + "\r"));
    });
  }
}

/**
 * Runs a command-line tool for USB IR blasters (USB-UIRT, IguanaIR, etc.).
 * Arguments support {port} {pronto} {freq} {remote} {key} placeholders.
 */
export class CommandTransmitter implements IrTransmitter {
  command: string;
  args: string[];

  constructor(command: string, args: string[]) {
    this.command = command;
    this.args = args;
  }

  async send(port: number, code: ProntoCode, repeat: number, meta: { remote?: string; key?: string; pronto: string }) {
    const vars: Record<string, string> = {
      port: String(port), pronto: meta.pronto, freq: String(code.freqHz), remote: meta.remote ?? "", key: meta.key ?? "",
    };
    const args = this.args.map((a) => a.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ""));
    for (let i = 0; i < repeat; i++) await execFileAsync(this.command, args, { timeout: 5000 });
  }
}

export class SimulatedTransmitter implements IrTransmitter {
  readonly sent: string[] = [];
  async send(port: number, _code: ProntoCode, _repeat: number, meta: { remote?: string; key?: string }) {
    const line = `port ${port}: ${meta.remote ?? "raw"} ${meta.key ?? ""}`.trim();
    this.sent.push(line);
    log(`[ir:sim] ${line}`);
    await sleep(10);
  }
}

export function createTransmitter(cfg: IrConfig, simulate: boolean): IrTransmitter {
  if (simulate || cfg.driver === "simulated") return new SimulatedTransmitter();
  if (cfg.driver === "globalcache") return new GlobalCacheTransmitter(cfg.host!, cfg.module ?? 1);
  return new CommandTransmitter(cfg.command!, cfg.args ?? ["{pronto}"]);
}

/** Looks up named codes and serializes sends: IR hardware emits one code at a time. */
export class IrService {
  private tail: Promise<unknown> = Promise.resolve();
  tx: IrTransmitter;
  codes: Record<string, Record<string, string>>;

  constructor(tx: IrTransmitter, codes: Record<string, Record<string, string>>) {
    this.tx = tx;
    this.codes = codes;
  }

  sendKey(port: number, remote: string, key: string, repeat = 1) {
    const pronto = this.codes[remote]?.[key];
    if (!pronto) throw new Error(`No IR code for ${remote} ${key}`);
    return this.sendPronto(port, pronto, repeat, remote, key);
  }

  sendPronto(port: number, pronto: string, repeat = 1, remote?: string, key?: string) {
    const code = parsePronto(pronto);
    const job = this.tail.then(async () => {
      await this.tx.send(port, code, repeat, { remote, key, pronto });
      await sleep(80);
    });
    this.tail = job.catch(() => {});
    return job;
  }
}
