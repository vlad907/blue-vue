import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "../../config.ts";

const execFileAsync = promisify(execFile);
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Emitter {
  socket?: string;
  transmitters?: number[];
}

export interface IrTransmitter {
  send(emitter: Emitter, remote: string, key: string): Promise<void>;
}

/**
 * Sends IR through LIRC's irsend, which works with most USB IR blasters
 * (Iguanaworks, USB-UIRT, IRDroid, mceusb, etc.). Codes come from lircd.conf
 * remote definitions, learned with `irrecord` or taken from the LIRC remotes DB.
 */
export class LircTransmitter implements IrTransmitter {
  constructor(private irsendPath: string, private defaultSocket?: string) {}

  async send(emitter: Emitter, remote: string, key: string) {
    const socket = emitter.socket ?? this.defaultSocket;
    const base = socket ? ["-d", socket] : [];
    if (emitter.transmitters?.length) {
      await execFileAsync(this.irsendPath, [...base, "SET_TRANSMITTERS", ...emitter.transmitters.map(String)]);
    }
    await execFileAsync(this.irsendPath, [...base, "SEND_ONCE", remote, key]);
  }
}

export class SimulatedTransmitter implements IrTransmitter {
  readonly log: string[] = [];
  async send(emitter: Emitter, remote: string, key: string) {
    const where = [emitter.socket, emitter.transmitters?.join(",")].filter(Boolean).join(" tx ");
    const line = `${remote} ${key}${where ? ` @ ${where}` : ""}`;
    this.log.push(line);
    console.log(`[ir:sim] ${line}`);
    await sleep(20);
  }
}

/**
 * Serializes all IR sends: a blaster can only emit one code at a time, and
 * SET_TRANSMITTERS + SEND_ONCE must not interleave between callers.
 */
export class IrQueue {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private tx: IrTransmitter, private gapMs: number) {}

  /** Runs `fn` exclusively; `fn` receives a send function bound to the transmitter. */
  run<T>(fn: (send: (e: Emitter, remote: string, key: string) => Promise<void>) => Promise<T>): Promise<T> {
    const job = this.tail.then(() =>
      fn(async (e, remote, key) => {
        await this.tx.send(e, remote, key);
        await sleep(this.gapMs);
      }),
    );
    this.tail = job.catch(() => {});
    return job;
  }
}

export function createTransmitter(cfg: Config): IrTransmitter {
  if (cfg.simulate || cfg.ir.driver === "simulated") return new SimulatedTransmitter();
  return new LircTransmitter(cfg.ir.irsendPath, cfg.ir.defaultSocket);
}
