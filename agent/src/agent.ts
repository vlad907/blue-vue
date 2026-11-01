import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { type AgentConfig, loadConfig } from "./config.ts";
import { IrService, createTransmitter } from "./ir.ts";
import { log } from "./log.ts";
import { PanelManager } from "./panels.ts";

const VERSION = "0.1.0";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function authorized(req: IncomingMessage, token: string) {
  const got = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readJson(req: IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64_000) throw new HttpError(413, "Body too large");
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

const panelIds = (v: unknown, cfg: AgentConfig): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new HttpError(400, "panels must be an array of panel ids");
  const unknown = v.filter((id) => !cfg.panels.some((p) => p.id === id));
  if (unknown.length) throw new HttpError(400, `Unknown panel(s): ${unknown.join(", ")}`);
  return v;
};

export function createAgent(cfg: AgentConfig) {
  const ir = new IrService(createTransmitter(cfg.ir, cfg.simulate), cfg.codes);
  const panels = new PanelManager(cfg, ir);
  const startedAt = Date.now();

  async function route(req: IncomingMessage, url: URL) {
    const { method } = req;
    const path = url.pathname;

    if (method === "GET" && path === "/status") {
      return {
        name: cfg.name, host: hostname(), version: VERSION, simulate: cfg.simulate,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        panels: panels.list(),
        irRemotes: Object.keys(cfg.codes),
      };
    }

    // { on: boolean, panels?: string[] }
    if (method === "POST" && path === "/panels/power") {
      const body = await readJson(req);
      if (typeof body.on !== "boolean") throw new HttpError(400, "on must be a boolean");
      const errors = await panels.power(body.on, panelIds(body.panels, cfg));
      return { ok: Object.keys(errors).length === 0, errors };
    }

    // { input: "hdmi1", panels?: string[] }
    if (method === "POST" && path === "/panels/input") {
      const body = await readJson(req);
      if (typeof body.input !== "string") throw new HttpError(400, "input must be a string");
      const errors = await panels.input(body.input, panelIds(body.panels, cfg));
      return { ok: Object.keys(errors).length === 0, errors };
    }

    // { port, remote, key, repeat? } or { port, pronto, repeat? }. Used for cable boxes at this wall.
    if (method === "POST" && path === "/ir/send") {
      const body = await readJson(req);
      if (!Number.isInteger(body.port) || body.port < 1) throw new HttpError(400, "port must be a positive integer");
      const repeat = Number.isInteger(body.repeat) ? Math.min(Math.max(body.repeat, 1), 10) : 1;
      if (typeof body.pronto === "string") await ir.sendPronto(body.port, body.pronto, repeat);
      else if (typeof body.remote === "string" && typeof body.key === "string") await ir.sendKey(body.port, body.remote, body.key, repeat);
      else throw new HttpError(400, "Provide remote+key or pronto");
      return { ok: true };
    }

    throw new HttpError(404, "Not found");
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://agent");

    if (url.pathname === "/health") return send(200, { ok: true, name: cfg.name });
    if (!authorized(req, cfg.token)) return send(401, { error: "Unauthorized" });

    try {
      send(200, await route(req, url));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) log(`[http] ${req.method} ${url.pathname} failed: ${message}`);
      send(status, { error: message });
    }
  });

  return {
    server,
    panels,
    ir,
    start(port = cfg.port) {
      panels.start();
      return new Promise<number>((r) =>
        server.listen(port, () => r((server.address() as { port: number }).port)),
      );
    },
    stop() {
      panels.stop();
      server.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.argv[2] === "--check") {
    try {
      const cfg = loadConfig(resolve(process.argv[3] ?? "agent.json"));
      console.log(`Config OK: ${cfg.name}, ${cfg.panels.length} panels`);
      process.exit(0);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }
  const cfg = loadConfig(resolve(process.argv[2] ?? "agent.json"));
  const agent = createAgent(cfg);
  const port = await agent.start();
  log(`[agent] ${cfg.name} v${VERSION} listening on :${port} with ${cfg.panels.length} panels${cfg.simulate ? " (SIMULATION)" : ""}`);
  process.on("SIGINT", () => { agent.stop(); process.exit(0); });
  process.on("SIGTERM", () => { agent.stop(); process.exit(0); });
}
