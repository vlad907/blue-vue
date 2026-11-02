import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../scripts/migrate-config.ts";
import { LegacyConfigSchema } from "../../scripts/legacy-config.ts";
import { DeviceManager } from "../../src/engine/device-manager.ts";
import { BUILTIN_PROFILES } from "../../src/engine/index.ts";
import { ProfileLibrary } from "../../src/engine/profiles.ts";
import { EngineSceneRunner } from "../../src/engine/scenes.ts";
import { SiteStore } from "../../src/engine/site.ts";
import { StateStore } from "../../src/state.ts";

const root = join(import.meta.dirname, "../..");
const PRONTO = "0000 006D 0000 0002 0155 00AA 0015 0040";

test("today's system.json and agent.json migrate to a valid site that runs the same scenes", async () => {
  const cfg = LegacyConfigSchema.parse({ ...JSON.parse(readFileSync(join(root, "test/fixtures/legacy-system.json"), "utf8")), simulate: true });
  const agent = JSON.parse(readFileSync(join(root, "test/fixtures/legacy-agent.json"), "utf8"));
  agent.codes.xfinity = { KEY_0: PRONTO, KEY_1: PRONTO, KEY_2: PRONTO, KEY_4: PRONTO, KEY_5: PRONTO, KEY_6: PRONTO, KEY_OK: PRONTO, KEY_PLACEHOLDER: "PASTE PRONTO HEX" };

  const wall2 = { name: "wall2", ir: { driver: "globalcache", host: "10.0.10.32" }, panels: [] };
  const { site, profiles, warnings } = migrate(cfg, { wall1: agent, wall2 });

  // Atlas + 3 boxes + 4 Roku panels on wall1.
  assert.deepEqual(site.devices.map((d) => `${d.id}:${d.profile}@${d.location ?? "server"}`), [
    "atlas:atlas-atmosphere@server",
    "box1:xfinity-codes@wall1", "box2:xfinity-codes@wall1", "box3:xfinity-codes@wall2",
    "wall1-r1c1:tcl-roku-tv@wall1", "wall1-r1c2:tcl-roku-tv@wall1", "wall1-r2c1:tcl-roku-tv@wall1", "wall1-r2c2:tcl-roku-tv@wall1",
  ]);
  assert.deepEqual(profiles.map((p) => p.id), ["xfinity-codes"]);
  assert.equal(Object.keys((profiles[0] as any).irCodes).length, 7, "placeholder codes are skipped");
  assert.ok(warnings.some((w) => w.includes("wall3: no agent.json")));
  assert.equal((site.devices.find((d) => d.id === "box3")!.settings as any).irHost, "10.0.10.32");
  assert.ok(warnings.some((w) => w.includes('wall preset "full" dropped')), "old presets have no wall group to map to");

  // "Open Venue": all walls on -> one group step for wall1 (the only wall with panels).
  const open = site.scenes.find((s) => s.id === "open")!;
  assert.deepEqual(open.steps.map((s) => s.type === "command" ? `${s.group ?? s.device}.${s.command}` : s.type), [
    "wall1.power_on", "delay", "box1.tune", "atlas.set_source", "atlas.set_gain", "atlas.set_mute",
  ]);

  // Save it, load it into the engine, and run the converted scene in simulation.
  const data = mkdtempSync(join(tmpdir(), "bv-migrate-"));
  const state = new StateStore();
  const lib = new ProfileLibrary(BUILTIN_PROFILES, join(data, "profiles")).load();
  const manager = new DeviceManager(lib, state, { simulate: true });
  try {
    for (const p of profiles) assert.deepEqual(lib.saveCustom(p), []);
    const store = new SiteStore(data);
    const { errors, site: saved } = store.save(site);
    assert.deepEqual(errors, []);
    manager.apply(saved!);
    assert.deepEqual(Object.entries(state.state.devices).filter(([, d]) => d.problem).map(([id, d]) => `${id}: ${d.problem}`), []);

    const result = await new EngineSceneRunner(() => saved!, manager, state).run("gameday");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(["box1", "box2", "box3"].map((b) => state.state.devices[b].state.channel), ["206", "225", "241"]);

    await new EngineSceneRunner(() => saved!, manager, state).run("close");
    assert.equal(state.state.devices["wall1-r1c1"].state.power, "off");
    assert.equal(state.state.devices.atlas.state["zones.2.mute"], true);

    // Saving again keeps the previous version as a snapshot.
    store.save(saved);
    assert.equal(store.snapshots().length, 1);
  } finally {
    manager.stopAll();
    rmSync(data, { recursive: true, force: true });
  }
});
