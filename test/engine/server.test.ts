import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../../src/config.ts";
import { EXAMPLE_SITE, ensureSite } from "../../src/engine/bootstrap.ts";
import { startEngine } from "../../src/engine/index.ts";
import { GracenoteGuide } from "../../src/guide/gracenote.ts";
import { NdiReader } from "../../src/ndi/receiver.ts";
import { buildServer } from "../../src/server.ts";
import { StateStore } from "../../src/state.ts";

test("first run creates the site from the example; the API serves the panel and hides agent tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bv-server-"));
  const configFile = join(dir, "system.json");
  writeFileSync(configFile, JSON.stringify({ simulate: true, guide: { enabled: false } }));
  const cfg = { ...ConfigSchema.parse({ simulate: true, dataDir: join(dir, "data"), guide: { enabled: false } }), file: configFile };

  ensureSite(cfg.dataDir, cfg.file);
  const state = new StateStore();
  const engine = startEngine(cfg.dataDir, state, true);
  const guide = new GracenoteGuide(cfg, state, () => engine.site().channels);
  const app = await buildServer({ cfg, state, engine, guide });
  const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const res = await app.inject({ method, url, payload: body as object });
    return { status: res.statusCode, json: res.json() };
  };

  try {
    const site = (await call("GET", "/api/v2/site")).json;
    assert.ok(site.agents.length > 0);
    assert.ok(site.agents.every((a: Record<string, unknown>) => !("token" in a)), "tokens must not be served");
    assert.ok(!JSON.stringify((await call("GET", "/api/ui")).json).includes("CHANGE-ME"), "tokens must not be in the UI bundle");

    const ui = (await call("GET", "/api/ui")).json;
    assert.equal(ui.devices.length, JSON.parse(readFileSync(EXAMPLE_SITE, "utf8")).devices.length);
    assert.ok(ui.profiles["tcl-roku-tv"].controls.length > 0);
    assert.ok(ui.profiles["xfinity-ir"].capabilities.tuner);

    // Wall power through the capability, regardless of each panel's command names.
    assert.equal((await call("POST", "/api/v2/groups/wall1/capabilities/power/on", {})).status, 200);
    assert.ok(ui.groups[0].devices.every((id: string) => state.state.devices[id].state.power === "on"));

    assert.equal((await call("POST", "/api/v2/devices/box1/capabilities/tuner/tune", { value: 206 })).status, 200);
    assert.equal(state.state.devices.box1.state.channel, "206");

    // Bad requests are 4xx with a readable message.
    const bad = await call("POST", "/api/v2/devices/atlas/commands/set_gain", { params: { zone: 0, db: 99 } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /between -80 and 0/);
    assert.equal((await call("POST", "/api/v2/devices/nope/commands/x", {})).status, 404);
    assert.equal((await call("POST", "/api/v2/devices/box1/capabilities/power/on", {})).status, 400);
  } finally {
    await app.close();
    engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pictures of NDI streams are read off the network by the server itself", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bv-ndi-"));
  const configFile = join(dir, "system.json");
  writeFileSync(configFile, JSON.stringify({ guide: { enabled: false } }));
  const cfg = { ...ConfigSchema.parse({ dataDir: join(dir, "data"), guide: { enabled: false } }), file: configFile };
  mkdirSync(cfg.dataDir, { recursive: true });
  // The mosaic engine here answers nothing: the picture must not come from it.
  writeFileSync(join(cfg.dataDir, "site.json"), JSON.stringify({
    devices: [
      { id: "mosaic", name: "Mosaic", profile: "mosaic-engine", settings: { host: "127.0.0.1", port: 1 } },
      { id: "bar-box", name: "Bar box", profile: "pjlink-projector", settings: { host: "127.0.0.1", port: 1 }, preview: { device: "mosaic", stream: "ZOWIEBOX (Bar & grill)" } },
    ],
  }));
  const state = new StateStore();
  const engine = startEngine(cfg.dataDir, state, false);
  const guide = new GracenoteGuide(cfg, state, () => engine.site().channels);
  const ndi = new NdiReader(() => [process.execPath, join(import.meta.dirname, "../fixtures/fake-ndi-helper.mjs")]);
  const app = await buildServer({ cfg, state, engine, guide, ndi });
  const get = (url: string) => app.inject({ method: "GET", url });
  try {
    // Still connecting to the stream: the panel is told to ask again.
    assert.equal((await get("/api/v2/devices/bar-box/preview.jpg")).statusCode, 202);
    const ok = await get("/api/v2/devices/bar-box/preview.jpg");
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers["content-type"], "image/jpeg");
    assert.equal(ok.headers["x-signal"], "ok");
    assert.deepEqual([...ok.rawPayload.subarray(0, 2)], [0xff, 0xd8]);

    // A wall piece asks by stream name alone; no mosaic engine is involved.
    assert.equal((await get(`/api/v2/streams/preview.jpg?name=${encodeURIComponent("ZOWIEBOX (Bar & grill)")}`)).statusCode, 200);
    const missing = await get("/api/v2/streams/preview.jpg?engine=mosaic&name=GONE");
    assert.equal(missing.statusCode, 502);
    assert.match(missing.json().error, /isn't on the network/);

    assert.deepEqual((await get("/api/v2/streams")).json(), { streams: ["ZOWIEBOX (Bar & grill)"] });
  } finally {
    await app.close();
    engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a machine that can't read NDI asks the mosaic engine for the picture instead", async () => {
  // A stand-in mosaic engine: only the stream preview request matters here.
  const asked: string[] = [];
  let mode: "wait" | "ok" | "lost" | "old" = "wait";
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const fake = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname !== "/api/streams/preview.jpg" || mode === "old") return void res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
    asked.push(url.searchParams.get("name") ?? "");
    if (mode === "wait") return void res.writeHead(202).end();
    res.writeHead(200, { "content-type": "image/jpeg", "x-signal": mode }).end(jpeg);
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const port = (fake.address() as { port: number }).port;

  const dir = mkdtempSync(join(tmpdir(), "bv-preview-"));
  const configFile = join(dir, "system.json");
  writeFileSync(configFile, JSON.stringify({ guide: { enabled: false } }));
  const cfg = { ...ConfigSchema.parse({ dataDir: join(dir, "data"), guide: { enabled: false } }), file: configFile };
  mkdirSync(cfg.dataDir, { recursive: true });
  writeFileSync(join(cfg.dataDir, "site.json"), JSON.stringify({
    devices: [
      { id: "mosaic", name: "Mosaic", profile: "mosaic-engine", settings: { host: "127.0.0.1", port } },
      { id: "bar-box", name: "Bar box", profile: "pjlink-projector", settings: { host: "127.0.0.1", port: 1 }, preview: { device: "mosaic", stream: "ZOWIEBOX (Bar & grill)" } },
      { id: "plain", name: "Plain", profile: "pjlink-projector", settings: { host: "127.0.0.1", port: 1 } },
    ],
  }));
  const state = new StateStore();
  const engine = startEngine(cfg.dataDir, state, false);
  const guide = new GracenoteGuide(cfg, state, () => engine.site().channels);
  const ndi = new NdiReader(() => [process.execPath, "-e", "process.exit(3)"]); // no NDI on this machine
  const app = await buildServer({ cfg, state, engine, guide, ndi });
  const get = (id: string) => app.inject({ method: "GET", url: `/api/v2/devices/${id}/preview.jpg` });

  try {
    const ui = (await app.inject({ method: "GET", url: "/api/ui" })).json();
    assert.deepEqual(ui.devices.map((d: { id: string; preview: boolean }) => [d.id, d.preview]), [["mosaic", false], ["bar-box", true], ["plain", false]]);

    // No picture yet: the panel is told to ask again.
    assert.equal((await get("bar-box")).statusCode, 202);
    assert.deepEqual(asked, ["ZOWIEBOX (Bar & grill)"]); // the name arrives whole, spaces and & included

    mode = "ok";
    const ok = await get("bar-box");
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers["content-type"], "image/jpeg");
    assert.equal(ok.headers["x-signal"], "ok");
    assert.deepEqual(ok.rawPayload, jpeg);

    mode = "lost";
    assert.equal((await get("bar-box")).headers["x-signal"], "lost");

    // An engine from before stream previews says so, instead of a bare 404.
    mode = "old";
    const old = await get("bar-box");
    assert.equal(old.statusCode, 502);
    assert.match(old.json().error, /too old/);

    // The admin looks at any stream by name before linking it.
    mode = "ok";
    asked.length = 0;
    const any = await app.inject({ method: "GET", url: `/api/v2/streams/preview.jpg?engine=mosaic&name=${encodeURIComponent("CAM (1)")}` });
    assert.equal(any.statusCode, 200);
    assert.deepEqual(any.rawPayload, jpeg);
    assert.deepEqual(asked, ["CAM (1)"]);
    assert.equal((await app.inject({ method: "GET", url: "/api/v2/streams/preview.jpg?engine=nope&name=X" })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/v2/streams/preview.jpg?engine=mosaic" })).statusCode, 400);

    assert.equal((await get("plain")).statusCode, 404);
    assert.equal((await get("nope")).statusCode, 404);
  } finally {
    await app.close();
    engine.stop();
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
