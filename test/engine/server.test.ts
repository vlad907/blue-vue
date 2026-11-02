import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../../src/config.ts";
import { EXAMPLE_SITE, ensureSite } from "../../src/engine/bootstrap.ts";
import { startEngine } from "../../src/engine/index.ts";
import { GracenoteGuide } from "../../src/guide/gracenote.ts";
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
