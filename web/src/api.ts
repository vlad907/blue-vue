import { useEffect, useState } from "react";

// --- Shapes served by /api/ui and pushed over /ws --------------------------

export interface Param {
  type: "number" | "integer" | "boolean" | "string" | "enum";
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  values?: (string | number)[];
  labels?: Record<string, string>;
  optionsFrom?: string;
}

export interface Control {
  type: "button" | "toggle" | "slider" | "select" | "keypad" | "dpad" | "presets" | "status" | "group";
  label?: string;
  command?: string;
  params?: Record<string, unknown>;
  param?: string;
  state?: string;
  on?: string;
  off?: string;
  keys?: Record<string, string>;
  repeat?: string;
  options?: string;
  controls?: Control[];
}

export interface UiProfile {
  id: string;
  name: string;
  category: string;
  capabilities: {
    power?: { on: string; off: string; state?: string };
    tuner?: { tune: string; param: string; state?: string };
    layoutPresets?: { recall: string; param: string; optionsFrom?: string };
    [k: string]: unknown;
  };
  controls: Control[];
  commands: Record<string, { label?: string; params: Record<string, Param> }>;
}

export interface UiDevice {
  id: string;
  name: string;
  profile: string;
  location: string;
  room?: string;
  settings: Record<string, unknown>;
}

export interface Channel {
  number: number;
  name: string;
  callSign?: string;
  category?: string;
}

export interface Ui {
  name: string;
  simulate: boolean;
  rooms: { id: string; name: string }[];
  groups: { id: string; name: string; kind: string; devices: string[] }[];
  scenes: { id: string; name: string; description?: string }[];
  channels: Channel[];
  agents: { id: string; name: string }[];
  devices: UiDevice[];
  profiles: Record<string, UiProfile>;
}

export interface DeviceView {
  name: string;
  online: boolean;
  state: Record<string, unknown>;
  error?: string;
  problem?: string;
}

export interface AgentView {
  name: string;
  online: boolean;
  paired: boolean;
  host?: string;
  apps: { name: string; running: boolean | null; error?: string }[];
}

export interface LiveState {
  devices: Record<string, DeviceView>;
  agents: Record<string, AgentView>;
  guide: { lastUpdated?: string; error?: string };
  activeScene?: string;
  busy: boolean;
}

// --- Calls -------------------------------------------------------------------

async function request<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}

export const api = {
  ui: () => request<Ui>("/api/ui"),
  guide: () => request<{ rows: GuideRow[]; lastUpdated?: string; error?: string }>("/api/guide"),
  command: (device: string, command: string, params: Record<string, unknown> = {}) =>
    request(`/api/v2/devices/${device}/commands/${command}`, { params }),
  capability: (device: string, cap: string, action: string, value?: unknown) =>
    request(`/api/v2/devices/${device}/capabilities/${cap}/${action}`, { value }),
  groupCapability: (group: string, cap: string, action: string) =>
    request(`/api/v2/groups/${group}/capabilities/${cap}/${action}`, {}),
  scene: (id: string) => request<{ ok: boolean; errors: string[] }>(`/api/v2/scenes/${id}`, {}),
  restartApp: (agent: string, app: string) => request(`/api/v2/agents/${agent}/apps/${encodeURIComponent(app)}/restart`, {}),
};

export interface Airing {
  start: string;
  end: string;
  title: string;
  episodeTitle?: string;
  description?: string;
  live?: boolean;
  isNew?: boolean;
}
export interface GuideRow {
  channel: number;
  name: string;
  callSign?: string;
  airings: Airing[];
}

// --- Live state ----------------------------------------------------------------

/** Server state pushed over /ws, reconnecting if the server restarts. */
export function useLiveState() {
  const [state, setState] = useState<LiveState>();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket;
    let timer: number;
    let stopped = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "state") setState(msg.state);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) timer = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws.close();
    };
  }, []);

  return { state, connected };
}
