import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { AgentLink } from "../../agent/src/link.ts";
import { ConfigSchema } from "../../src/config.ts";
import { ensureSite } from "../../src/engine/bootstrap.ts";
import { startEngine } from "../../src/engine/index.ts";
import { GracenoteGuide } from "../../src/guide/gracenote.ts";
import { buildServer } from "../../src/server.ts";
import { StateStore } from "../../src/state.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bv-admin-"));
  const configFile = join(dir, "system.json");
  writeFileSync(configFile, "{}");
  const cfg = { ...ConfigSchema.parse({ simulate: true, dataDir: join(dir, "data"), guide: { enabled: false } }), file: configFile };
  ensureSite(cfg.dataDir, cfg.file);
  const state = new StateStore();
  const engine = startEngine(cfg.dataDir, state, true);
  const app = await buildServer({ cfg, state, engine, guide: new GracenoteGuide(cfg, state, () => engine.site().channels) });

  let cookie = "";
  const call = async (method: "GET" | "POST" | "PUT", url: string, body?: unknown) => {
    const res = await app.inject({ method, url, payload: body as object, headers: cookie ? { cookie } : {} });
    const set = res.headers["set-cookie"];
    if (set) cookie = String(set).split(";")[0];
    return { status: res.statusCode, json: res.body ? res.json() : undefined };
  };
  return { app, engine, state, call, signOut: () => (cookie = ""), cleanup: async () => { await app.close(); engine.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test("admin: first-run password, login, lockout and session checks", async () => {
  const { call, signOut, cleanup } = await setup();
  try {
    assert.deepEqual((await call("GET", "/api/admin/session")).json, { authenticated: false, setupRequired: true });
    assert.equal((await call("GET", "/api/admin/site")).status, 401);
    assert.equal((await call("POST", "/api/admin/setup", { password: "short" })).status, 400);
    assert.equal((await call("POST", "/api/admin/setup", { password: "correct horse" })).status, 200);
    assert.deepEqual((await call("GET", "/api/admin/session")).json, { authenticated: true, setupRequired: false });
    assert.equal((await call("POST", "/api/admin/setup", { password: "another one" })).status, 409, "setup only works once");

    signOut();
    assert.equal((await call("GET", "/api/admin/site")).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/admin/login", { password: "nope nope" })).status, 401);
    assert.equal((await call("POST", "/api/admin/login", { password: "correct horse" })).status, 429, "locked out after 5 failures");
  } finally {
    await cleanup();
  }
});

test("admin: saving the site validates it, applies it live, and refuses stale edits", async () => {
  const { call, state, cleanup } = await setup();
  try {
    await call("POST", "/api/admin/setup", { password: "correct horse" });
    const { site, hash } = (await call("GET", "/api/admin/site")).json;
    assert.ok(site.agents[0].token, "admins see agent tokens");

    // Add a projector-ish device and a room; it starts without a restart.
    const next = {
      ...site,
      rooms: [...site.rooms, { id: "patio", name: "Patio" }],
      devices: [...site.devices, { id: "patio-tv", name: "Patio TV", profile: "tcl-roku-tv", room: "patio", settings: { host: "10.0.0.99" } }],
    };
    const saved = await call("PUT", "/api/admin/site", { site: next, baseHash: hash });
    assert.equal(saved.status, 200);
    assert.ok(state.state.devices["patio-tv"]);
    assert.equal((await call("POST", "/api/v2/devices/patio-tv/capabilities/power/on", {})).status, 200);

    // Invalid sites come back with every problem listed, and nothing is saved.
    const broken = { ...next, groups: [...next.groups, { id: "g", name: "G", devices: ["ghost"] }], devices: [...next.devices, { id: "x", name: "X", profile: "tcl-roku-tv", location: "nowhere" }] };
    const bad = await call("PUT", "/api/admin/site", { site: broken, baseHash: saved.json.hash });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json.problems.sort(), ['device x: unknown location "nowhere"', 'group g: unknown device "ghost"']);

    // Scene steps are checked against the devices' profiles.
    const badScene = { ...next, scenes: [...next.scenes, { id: "s", name: "Oops", steps: [
      { type: "command", device: "atlas", command: "set_gain", params: { zone: 0, db: 40 } },
      { type: "command", group: "wall1", command: "explode", params: {} },
    ] }] };
    const lint = await call("PUT", "/api/admin/site", { site: badScene, baseHash: saved.json.hash });
    assert.equal(lint.status, 400);
    assert.equal(lint.json.problems.length, 5);
    assert.ok(lint.json.problems.includes('scene "Oops" step 1: "db" must be between -80 and 0'));
    assert.ok(lint.json.problems.some((p: string) => /step 2: Top Left has no command "explode"/.test(p)));

    // A second admin working from an old copy is stopped.
    assert.equal((await call("PUT", "/api/admin/site", { site, baseHash: hash })).status, 409);

    // Undo: restore the snapshot taken before the first save.
    const snaps = (await call("GET", "/api/admin/snapshots")).json;
    assert.equal(snaps.length, 1);
    assert.equal((await call("POST", `/api/admin/snapshots/${snaps[0]}/restore`)).status, 200);
    await sleep(10);
    assert.equal(state.state.devices["patio-tv"], undefined);
    assert.equal((await call("POST", "/api/admin/snapshots/..%2F..%2Fetc/restore")).status, 400);
  } finally {
    await cleanup();
  }
});

test("admin: export and import a backup including custom profiles", async () => {
  const { call, engine, cleanup } = await setup();
  try {
    await call("POST", "/api/admin/setup", { password: "correct horse" });
    engine.profiles.saveCustom({ id: "roku-site", name: "Roku (ours)", extends: "tcl-roku-tv" });
    const backup = (await call("GET", "/api/admin/export")).json;
    assert.equal(backup.format, "blue-vue-backup");
    assert.deepEqual(backup.profiles.map((p: { id: string }) => p.id), ["roku-site"]);

    backup.site.name = "Restored Venue";
    assert.equal((await call("POST", "/api/admin/import", backup)).status, 200);
    assert.equal(engine.site().name, "Restored Venue");
    assert.equal((await call("POST", "/api/admin/import", { format: "something-else" })).status, 400);
  } finally {
    await cleanup();
  }
});

test("admin: an unknown wall agent waits for approval, then connects with the token it offered", async () => {
  // Real (non-simulated) engine so the agent link is used.
  const dir = mkdtempSync(join(tmpdir(), "bv-pair-"));
  const configFile = join(dir, "system.json");
  writeFileSync(configFile, "{}");
  const cfg = { ...ConfigSchema.parse({ simulate: false, dataDir: join(dir, "data"), guide: { enabled: false } }), file: configFile };
  ensureSite(cfg.dataDir, cfg.file);
  const state = new StateStore();
  const engine = startEngine(cfg.dataDir, state, false);
  const app = await buildServer({ cfg, state, engine, guide: new GracenoteGuide(cfg, state, () => []) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  const link = new AgentLink({ url: `ws://127.0.0.1:${port}/agent`, id: "wall9", token: "offered-token-0123456789", version: "t", simulate: true, log: () => {} });

  let cookie = "";
  const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const res = await app.inject({ method, url, payload: body as object, headers: cookie ? { cookie } : {} });
    if (res.headers["set-cookie"]) cookie = String(res.headers["set-cookie"]).split(";")[0];
    return res.statusCode;
  };
  try {
    await call("POST", "/api/admin/setup", { password: "correct horse" });
    link.start();
    const end = Date.now() + 3000;
    while (state.state.agents.wall9?.error !== "not paired" && Date.now() < end) await sleep(20);
    assert.equal(state.state.agents.wall9.paired, false);

    assert.equal(await call("POST", "/api/admin/agents/wall9/approve", { name: "Patio wall PC" }), 200);
    assert.equal(engine.site().agents.find((a) => a.id === "wall9")?.token, "offered-token-0123456789");
    // The agent retries every 10s after a rejection; reconnect now rather than waiting.
    link.stop();
    link.start();
    const end2 = Date.now() + 3000;
    while (!state.state.agents.wall9?.online && Date.now() < end2) await sleep(20);
    assert.equal(state.state.agents.wall9.online, true);
    assert.equal(state.state.agents.wall9.name, "Patio wall PC");
  } finally {
    link.stop();
    await app.close();
    engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
