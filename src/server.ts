import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { z } from "zod";
import type { Config } from "./config.ts";
import { REMOTE_KEYS } from "./devices/cableBox.ts";
import type { EndpointManager } from "./drivers/endpoints.ts";
import type { Engine } from "./engine/index.ts";
import type { GracenoteGuide } from "./guide/gracenote.ts";
import type { Devices, SceneRunner } from "./scenes.ts";
import type { StateStore } from "./state.ts";

interface Deps {
  cfg: Config;
  state: StateStore;
  devices: Devices;
  scenes: SceneRunner;
  guide: GracenoteGuide;
  endpoints: EndpointManager;
  engine?: Engine;
}

export async function buildServer({ cfg, state, devices, scenes, guide, endpoints, engine }: Deps) {
  const app = Fastify({ logger: { level: "warn" } });
  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, { root: join(dirname(fileURLToPath(import.meta.url)), "..", "web") });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof z.ZodError ? 400 : (err.statusCode ?? 500);
    const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err.message;
    reply.status(status).send({ error: message });
  });

  // Static system description for building the UI.
  app.get("/api/config", async () => ({
    site: cfg.site,
    simulate: cfg.simulate,
    walls: cfg.endpoints.map(({ id, name }) => ({ id, name })),
    cableBoxes: cfg.cableBoxes.map(({ id, name, favorites, atlasSource }) => ({ id, name, favorites, atlasSource })),
    channels: cfg.channels,
    zones: cfg.atlas.zones,
    sources: cfg.atlas.sources,
    atlasScenes: cfg.atlas.scenes,
    gainRange: { min: cfg.atlas.minGainDb, max: cfg.atlas.maxGainDb },
    wallPresets: cfg.videoWall.presets,
    scenes: cfg.scenes.map(({ id, name, description }) => ({ id, name, description })),
    remoteKeys: REMOTE_KEYS,
  }));

  app.get("/api/state", async () => state.state);

  // --- Video wall TV panels (via each wall's endpoint agent) ---
  // Omit `wall` for every wall; omit `panels` for every panel on the wall.
  const WallTarget = z.object({ wall: z.string().optional(), panels: z.array(z.string()).optional() });

  app.post("/api/wall/power", async (req) => {
    const { on, wall, panels } = WallTarget.extend({ on: z.boolean() }).parse(req.body);
    await devices.tvWall.power(on, wall, panels);
    return { ok: true };
  });

  app.post("/api/wall/input", async (req) => {
    const { input, wall, panels } = WallTarget.extend({ input: z.string() }).parse(req.body);
    await devices.tvWall.input(input, wall, panels);
    return { ok: true };
  });

  app.post("/api/walls/:wall/apps/:name/restart", async (req) => {
    const { wall, name } = z.object({ wall: z.string(), name: z.string() }).parse(req.params);
    await endpoints.get(wall).restartApp(name);
    await endpoints.poll(wall);
    return { ok: true };
  });

  // --- Video wall processor presets (API) ---
  app.post("/api/wall/preset/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await devices.videoWall.recallPreset(id);
    return { ok: true };
  });

  // --- Cable boxes (IR) ---
  app.post("/api/boxes/:id/tune", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { channel } = z.object({ channel: z.number().int().positive() }).parse(req.body);
    await devices.boxes.tune(id, channel);
    return { ok: true };
  });

  app.post("/api/boxes/:id/key", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { key } = z.object({ key: z.string() }).parse(req.body);
    await devices.boxes.key(id, key);
    return { ok: true };
  });

  // --- Atlas DSP ---
  app.post("/api/audio/zones/:zone", async (req) => {
    const { zone } = z.object({ zone: z.coerce.number().int() }).parse(req.params);
    const body = z
      .object({ gainDb: z.number().optional(), mute: z.boolean().optional(), source: z.number().int().optional() })
      .parse(req.body);
    if (body.source !== undefined) await devices.atlas.setZoneSource(zone, body.source);
    if (body.gainDb !== undefined) await devices.atlas.setZoneGain(zone, body.gainDb);
    if (body.mute !== undefined) await devices.atlas.setZoneMute(zone, body.mute);
    return { ok: true };
  });

  app.post("/api/audio/scenes/:scene", async (req) => {
    const { scene } = z.object({ scene: z.coerce.number().int() }).parse(req.params);
    await devices.atlas.recallScene(scene);
    return { ok: true };
  });

  // --- Scenes (macros across all systems) ---
  app.post("/api/scenes/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return scenes.run(id);
  });

  // --- TV guide ---
  app.get("/api/guide", async () => ({ rows: guide.grid(), ...state.state.guide }));
  app.post("/api/guide/refresh", async () => {
    await guide.refresh();
    return { ok: true };
  });

  if (engine) registerEngineRoutes(app, engine, state);

  // Live state push to every connected panel.
  app.get("/ws", { websocket: true }, (socket) => {
    const push = (s: unknown) => socket.send(JSON.stringify({ type: "state", state: s }));
    push(state.state);
    state.on("change", push);
    socket.on("close", () => state.off("change", push));
  });

  return app;
}

/** v2 API over the profile-driven engine. Admin writes arrive with the admin UI (they need a login). */
function registerEngineRoutes(app: FastifyInstance, engine: Engine, state: StateStore) {
  const Params = z.object({ params: z.record(z.unknown()).default({}) });

  app.get("/api/v2/profiles", async () =>
    engine.profiles.list().map((e) => ({
      id: e.profile?.id, name: e.profile?.name, category: e.profile?.category, manufacturer: e.profile?.manufacturer,
      source: e.source, file: e.file, errors: e.errors,
    })),
  );

  app.get("/api/v2/profiles/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const profile = engine.profiles.get(id);
    return profile ?? reply.status(404).send({ error: `Unknown profile "${id}"` });
  });

  app.get("/api/v2/site", async () => engine.site());
  app.get("/api/v2/devices", async () => state.state.devices);

  app.get("/api/v2/devices/:id/log", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return engine.devices.runtime(id).log;
  });

  app.post("/api/v2/devices/:id/commands/:command", async (req) => {
    const { id, command } = z.object({ id: z.string(), command: z.string() }).parse(req.params);
    await engine.devices.execute(id, command, Params.parse(req.body ?? {}).params);
    return { ok: true };
  });

  app.post("/api/v2/groups/:id/commands/:command", async (req) => {
    const { id, command } = z.object({ id: z.string(), command: z.string() }).parse(req.params);
    await engine.devices.executeGroup(id, command, Params.parse(req.body ?? {}).params);
    return { ok: true };
  });

  app.post("/api/v2/scenes/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return engine.scenes.run(id);
  });
}
