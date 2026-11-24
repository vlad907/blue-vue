import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { z } from "zod";
import { registerAdminRoutes } from "./admin/routes.ts";
import type { Updater } from "./admin/update.ts";
import type { Config } from "./config.ts";
import type { Engine } from "./engine/index.ts";
import type { Capabilities } from "./engine/profile-schema.ts";
import type { GracenoteGuide } from "./guide/gracenote.ts";
import type { InterfaceListener } from "./listen.ts";
import { NdiReader, NdiUnavailable } from "./ndi/receiver.ts";
import { APP_ROOT, VERSION } from "./paths.ts";
import type { StateStore } from "./state.ts";

interface Deps {
  cfg: Config;
  state: StateStore;
  engine: Engine;
  guide: GracenoteGuide;
  /** Controls which network cards the server answers on (absent in tests). */
  network?: () => InterfaceListener | undefined;
  /** Reads NDI streams off the network for the small live pictures (tests pass their own). */
  ndi?: NdiReader;
  /** The admin's Update button (tests pass their own). */
  updater?: Updater;
}

/** A stand-in picture for simulation mode: a moving bar, so the panel visibly refreshes. */
function simulatedPreview(name: string, stream: string) {
  const esc = (t: string) => t.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const x = Math.round(((Date.now() / 40) % 640) - 40);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="#16233d"/><rect x="${x}" width="40" height="360" fill="#2b4170"/><text x="320" y="170" fill="#e8eefb" font-family="sans-serif" font-size="30" text-anchor="middle">${esc(name)}</text><text x="320" y="208" fill="#8fa3c7" font-family="sans-serif" font-size="16" text-anchor="middle">${esc(stream)} (simulated)</text></svg>`;
}

export const WEB_DIST = join(APP_ROOT, "web", "dist");

export async function buildServer({ cfg, state, engine, guide, network, ndi = new NdiReader(), updater }: Deps) {
  const app = Fastify({ logger: { level: "warn" } });
  app.addHook("onClose", async () => ndi.stop());
  await app.register(fastifyWebsocket);

  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
    // The admin is the same single-page app, opened at /admin.
    app.get("/admin", (_req, reply) => reply.sendFile("index.html"));
    app.get("/admin/*", (_req, reply) => reply.sendFile("index.html"));
  } else {
    app.get("/", async (_req, reply) =>
      reply.type("text/html").send("<p>The touch panel hasn't been built yet. Run <code>npm run build</code>, or <code>npm run dev:web</code> while developing.</p>"),
    );
  }

  registerAdminRoutes(app, cfg, engine, network, updater);

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof z.ZodError ? 400 : (err.statusCode ?? 500);
    const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err.message;
    reply.status(status).send({ error: message });
  });

  const Params = z.object({ params: z.record(z.unknown()).default({}) });
  const Id = z.object({ id: z.string() });

  // Everything the touch panel needs to build itself: devices, their profiles' controls, and the layout.
  // Lets the desktop app find and name servers on the network. Nothing private.
  app.get("/api/hello", async () => ({ app: "blue-vue", name: engine.site().name, version: VERSION }));

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
      hiddenTabs: site.hiddenTabs ?? [],
      simulate: cfg.simulate,
      rooms: site.rooms,
      groups: site.groups,
      scenes: site.scenes.map(({ id, name, description }) => ({ id, name, description })),
      channels: site.channels,
      agents: site.agents.map(({ id, name }) => ({ id, name })),
      devices: site.devices.map(({ id, name, profile, location, room, settings, preview, streams, touch }) => ({ id, name, profile, location, room, settings, preview: !!preview, streams, touch })),
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

  /**
   * A small live picture of a device: the NDI stream linked to it, read
   * straight off the network by this server. 202 while the first frame is on
   * its way.
   */
  app.get("/api/v2/devices/:id/preview.jpg", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const site = engine.site();
    const device = site.devices.find((d) => d.id === id);
    if (!device?.preview) return reply.status(404).send({ error: "No preview stream is linked to this device" });
    return streamPicture(reply, device.preview.stream, device.name, device.preview.device);
  });

  /**
   * The same picture for any NDI stream by name: the pieces of a video wall on
   * the touch panel, and the admin checking which stream is which. `engine`
   * (optional) is a mosaic engine device to ask instead, only when this
   * machine can't read NDI itself.
   */
  app.get("/api/v2/streams/preview.jpg", async (req, reply) => {
    const { engine: via, name } = z.object({ engine: z.string().optional(), name: z.string().min(1) }).parse(req.query);
    return streamPicture(reply, name, name, via);
  });

  /** The NDI streams this server sees on the network itself. */
  app.get("/api/v2/streams", async (_req, reply) => {
    if (cfg.simulate) return { streams: [] };
    try {
      return { streams: await ndi.sources() };
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  async function streamPicture(reply: FastifyReply, stream: string, label: string, mosaicId?: string) {
    reply.header("cache-control", "no-store");
    if (cfg.simulate) return reply.header("x-signal", "ok").type("image/svg+xml").send(simulatedPreview(label, stream));
    try {
      const picture = await ndi.picture(stream);
      if ("waiting" in picture) return reply.status(202).send();
      return reply.header("x-signal", picture.signal).type("image/jpeg").send(picture.jpeg);
    } catch (err) {
      // This machine can't read NDI at all: ask the mosaic engine, if there is one. Anything else is about this stream.
      if (!(err instanceof NdiUnavailable) || !mosaicId) return reply.status(502).send({ error: (err as Error).message });
    }
    const mosaic = engine.site().devices.find((d) => d.id === mosaicId);
    const host = String(mosaic?.settings.host ?? "");
    if (!host) return reply.status(404).send({ error: "The mosaic engine for this preview isn't set up" });
    let res: Response;
    try {
      res = await fetch(`http://${host}:${Number(mosaic!.settings.port ?? 8090)}/api/streams/preview.jpg?name=${encodeURIComponent(stream)}`, { signal: AbortSignal.timeout(4000) });
    } catch {
      return reply.status(502).send({ error: "No answer from the mosaic engine" });
    }
    if (res.status === 202) return reply.status(202).send();
    if (res.status === 404) return reply.status(502).send({ error: "This mosaic engine is too old to show stream previews. Update it." });
    if (!res.ok) return reply.status(502).send({ error: ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The mosaic engine answered ${res.status}` });
    return reply.header("x-signal", res.headers.get("x-signal") ?? "ok").type("image/jpeg").send(Buffer.from(await res.arrayBuffer()));
  }

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

  // Every wall off or on, and with them every screen of every wall PC.
  app.post("/api/v2/walls/power/:action", async (req) => {
    const { action } = z.object({ action: z.enum(["on", "off"]) }).parse(req.params);
    await engine.devices.allWalls(action);
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
