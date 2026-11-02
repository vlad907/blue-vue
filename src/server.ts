import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Engine } from "./engine/index.ts";
import type { Capabilities } from "./engine/profile-schema.ts";
import type { GracenoteGuide } from "./guide/gracenote.ts";
import type { StateStore } from "./state.ts";

interface Deps {
  cfg: Config;
  state: StateStore;
  engine: Engine;
  guide: GracenoteGuide;
}

export const WEB_DIST = join(import.meta.dirname, "..", "web", "dist");

export async function buildServer({ cfg, state, engine, guide }: Deps) {
  const app = Fastify({ logger: { level: "warn" } });
  await app.register(fastifyWebsocket);

  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
  } else {
    app.get("/", async (_req, reply) =>
      reply.type("text/html").send("<p>The touch panel hasn't been built yet. Run <code>npm run build</code>, or <code>npm run dev:web</code> while developing.</p>"),
    );
  }

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof z.ZodError ? 400 : (err.statusCode ?? 500);
    const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err.message;
    reply.status(status).send({ error: message });
  });

  const Params = z.object({ params: z.record(z.unknown()).default({}) });
  const Id = z.object({ id: z.string() });

  // Everything the touch panel needs to build itself: devices, their profiles' controls, and the layout.
  app.get("/api/ui", async () => {
    const site = engine.site();
    const used = new Set(site.devices.map((d) => d.profile));
    const profiles: Record<string, unknown> = {};
    for (const id of used) {
      const p = engine.profiles.get(id);
      if (!p) continue;
      profiles[id] = {
        id: p.id, name: p.name, category: p.category, capabilities: p.capabilities, controls: p.controls, state: p.state,
        commands: Object.fromEntries(Object.entries(p.commands).filter(([, c]) => !c.hidden).map(([k, c]) => [k, { label: c.label, params: c.params }])),
      };
    }
    return {
      name: site.name,
      simulate: cfg.simulate,
      rooms: site.rooms,
      groups: site.groups,
      scenes: site.scenes.map(({ id, name, description }) => ({ id, name, description })),
      channels: site.channels,
      agents: site.agents.map(({ id, name }) => ({ id, name })),
      devices: site.devices.map(({ id, name, profile, location, room, settings }) => ({ id, name, profile, location, room, settings })),
      profiles,
    };
  });

  app.get("/api/state", async () => state.state);

  app.get("/api/v2/profiles", async () =>
    engine.profiles.list().map((e) => ({
      id: e.profile?.id, name: e.profile?.name, category: e.profile?.category, manufacturer: e.profile?.manufacturer,
      source: e.source, file: e.file, errors: e.errors,
    })),
  );

  app.get("/api/v2/profiles/:id", async (req, reply) => {
    const { id } = Id.parse(req.params);
    return engine.profiles.get(id) ?? reply.status(404).send({ error: `Unknown profile "${id}"` });
  });

  // Agent tokens never leave the server.
  app.get("/api/v2/site", async () => {
    const site = engine.site();
    return { ...site, agents: site.agents.map(({ id, name }) => ({ id, name })) };
  });

  app.get("/api/v2/devices", async () => state.state.devices);

  app.get("/api/v2/devices/:id/log", async (req) => engine.devices.runtime(Id.parse(req.params).id).log);

  app.post("/api/v2/devices/:id/commands/:command", async (req) => {
    const { id, command } = z.object({ id: z.string(), command: z.string() }).parse(req.params);
    await engine.devices.execute(id, command, Params.parse(req.body ?? {}).params);
    return { ok: true };
  });

  // Standard roles (power on, tune, ...) without knowing the device's own command names.
  app.post("/api/v2/devices/:id/capabilities/:cap/:action", async (req) => {
    const { id, cap, action } = z.object({ id: z.string(), cap: z.string(), action: z.string() }).parse(req.params);
    const { value } = z.object({ value: z.unknown().optional() }).parse(req.body ?? {});
    await engine.devices.capability(id, cap as keyof Capabilities, action, value);
    return { ok: true };
  });

  app.post("/api/v2/groups/:id/commands/:command", async (req) => {
    const { id, command } = z.object({ id: z.string(), command: z.string() }).parse(req.params);
    await engine.devices.executeGroup(id, command, Params.parse(req.body ?? {}).params);
    return { ok: true };
  });

  app.post("/api/v2/groups/:id/capabilities/:cap/:action", async (req) => {
    const { id, cap, action } = z.object({ id: z.string(), cap: z.string(), action: z.string() }).parse(req.params);
    const { value } = z.object({ value: z.unknown().optional() }).parse(req.body ?? {});
    await engine.devices.groupCapability(id, cap as keyof Capabilities, action, value);
    return { ok: true };
  });

  app.post("/api/v2/scenes/:id", async (req) => engine.scenes.run(Id.parse(req.params).id));

  app.get("/api/v2/agents", async () => state.state.agents);

  app.post("/api/v2/agents/:id/apps/:name/restart", async (req) => {
    const { id, name } = z.object({ id: z.string(), name: z.string() }).parse(req.params);
    await engine.agents.restartApp(id, name);
    return { ok: true };
  });

  app.get("/api/guide", async () => ({ rows: guide.grid(), ...state.state.guide }));
  app.post("/api/guide/refresh", async () => {
    await guide.refresh();
    return { ok: true };
  });

  // Wall agents dial in here; the hub checks their token in the first message.
  app.get("/agent", { websocket: true }, (socket) => engine.agents.accept(socket));

  // Live state push to every connected panel.
  app.get("/ws", { websocket: true }, (socket) => {
    const push = (s: unknown) => socket.send(JSON.stringify({ type: "state", state: s }));
    push(state.state);
    state.on("change", push);
    socket.on("close", () => state.off("change", push));
  });

  return app;
}
