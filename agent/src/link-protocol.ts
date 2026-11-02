import type { TransportConfig } from "./transports/types.ts";

// Messages between the control server and a wall agent over the agent's
// outbound WebSocket (ws://server:8080/agent). The agent opens the socket, so
// wall PCs need no inbound firewall rule. The server owns all device logic;
// the agent only hosts connections (TCP, serial, IR, ...) on its network.

/** Payloads cross the wire as JSON; bytes are base64. */
export type WirePayload =
  | { kind: "text"; text: string }
  | { kind: "bytes"; base64: string }
  | { kind: "http"; method: string; path: string; body?: string; headers?: Record<string, string> }
  | { kind: "ir"; pronto: string; repeat: number; label?: string }
  | { kind: "adb"; args: string[] }
  | { kind: "wol" };

export interface AgentAppStatus {
  name: string;
  running: boolean | null;
  autoRestart: boolean;
  lastRestartAt?: string;
  error?: string;
}

export type AgentToServer =
  | { type: "hello"; id: string; token: string; version: string; host: string }
  | { type: "status"; apps: AgentAppStatus[]; uptimeSec: number }
  | { type: "conn.status"; connId: string; online: boolean }
  | { type: "conn.data"; connId: string; message: string }
  | { type: "conn.log"; connId: string; dir: "tx" | "rx" | "info" | "error"; text: string }
  | { type: "reply"; reqId: number; ok: true; text?: string }
  | { type: "reply"; reqId: number; ok: false; error: string };

export type ServerToAgent =
  | { type: "welcome" }
  | { type: "conn.open"; connId: string; transport: TransportConfig; settings: Record<string, unknown> }
  | { type: "conn.close"; connId: string }
  | { type: "conn.send"; connId: string; reqId: number; payload: WirePayload }
  | { type: "app.restart"; reqId: number; name: string }
  // Puts an iTach near this wall into learning mode; the reply text is the learned sendir code.
  | { type: "ir.learn"; reqId: number; host: string; port?: number; timeoutMs: number };

export const PROTOCOL_VERSION = "1";
