import { EventEmitter } from "node:events";

// Transports move already-rendered payloads to and from a device. They know
// nothing about profiles. This folder is shared by the control server and the
// wall agent, so it uses only Node built-ins and erasable TypeScript syntax.

export type RenderedPayload =
  | { kind: "text"; text: string }
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "http"; method: string; path: string; body?: string; headers?: Record<string, string> }
  | { kind: "ir"; pronto: string; repeat: number; label?: string }
  | { kind: "adb"; args: string[] }
  | { kind: "wol" };

export interface TransportConfig {
  type: "tcp" | "udp" | "http" | "serial" | "ir" | "adb" | "wol";
  port?: number;
  terminator?: string;
  delimiter?: string;
  baudRate?: number;
  https?: boolean;
}

/** Settings a transport reads from the device instance. */
export interface ConnectionSettings {
  host?: string;
  port?: number;
  mac?: string;
  serialPort?: string;
  irHost?: string;
  irPort?: number;
  irModule?: number;
  [key: string]: unknown;
}

/**
 * Events: "status" (online: boolean), "data" (message: string),
 * "log" (direction: "tx" | "rx" | "info" | "error", text: string).
 */
export abstract class Connection extends EventEmitter {
  online = false;

  abstract open(): void;
  abstract close(): void;
  /** Sends one payload. Request/response transports resolve with the reply text. */
  abstract send(payload: RenderedPayload): Promise<string | undefined>;

  protected setOnline(online: boolean) {
    if (online === this.online) return;
    this.online = online;
    this.emit("status", online);
  }

  protected log(direction: "tx" | "rx" | "info" | "error", text: string) {
    this.emit("log", direction, text);
  }
}

export function describe(p: RenderedPayload): string {
  switch (p.kind) {
    case "text": return JSON.stringify(p.text);
    case "bytes": return [...p.bytes].map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
    case "http": return `${p.method} ${p.path}${p.body ? ` ${p.body}` : ""}`;
    case "ir": return `IR ${p.label ?? "code"}${p.repeat > 1 ? ` x${p.repeat}` : ""}`;
    case "adb": return `adb shell ${p.args.join(" ")}`;
    case "wol": return "wake-on-LAN";
  }
}

export function requireSetting<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === "") throw new Error(`Device setting "${name}" is required`);
  return value;
}
