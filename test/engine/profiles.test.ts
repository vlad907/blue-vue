import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceManager } from "../../src/engine/device-manager.ts";
import { ProfileLibrary } from "../../src/engine/profiles.ts";
import { EngineSceneRunner } from "../../src/engine/scenes.ts";
import { SiteSchema, checkSite, type Site } from "../../src/engine/site.ts";
import { StateStore } from "../../src/state.ts";

const BUILTIN = join(import.meta.dirname, "../../profiles/builtin");
const PRONTO = (n: number) => `0000 006D 0000 0002 0155 00AA 0015 ${n.toString(16).padStart(4, "0")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(10);
  }
}

function setup(customProfiles: Record<string, unknown>[] = [], simulate = false) {
  const custom = mkdtempSync(join(tmpdir(), "bv-profiles-"));
  const lib = new ProfileLibrary(BUILTIN, custom).load();
  for (const p of customProfiles) assert.deepEqual(lib.saveCustom(p), []);
  const state = new StateStore();
  const manager = new DeviceManager(lib, state, { simulate });
  return { lib, state, manager, cleanup: () => { manager.stopAll(); rmSync(custom, { recursive: true, force: true }); } };
}

const site = (input: unknown): Site => {
  const s = SiteSchema.parse(input);
  assert.deepEqual(checkSite(s), []);
  return s;
};

test("Atlas profile: subscribes per zone, sends JSON-RPC sets, applies pushed updates", async () => {
  const lines: string[] = [];
  let client: Socket | undefined;
  const dsp = createTcpServer((sock) => {
    client = sock;
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) lines.push(buf.slice(0, i));
    });
  });
  await new Promise<void>((r) => dsp.listen(0, "127.0.0.1", r));
  const { manager, state, cleanup } = setup();
  try {
    manager.apply(site({
      devices: [{
        id: "dsp", name: "DSP", profile: "atlas-atmosphere",
        settings: { host: "127.0.0.1", port: (dsp.address() as { port: number }).port, zones: [{ index: 0, name: "Main" }, { index: 1, name: "Bar" }] },
      }],
    }));
    await until(() => lines.length >= 6);
    assert.deepEqual(lines.slice(0, 6).map((l) => JSON.parse(l).params.param), ["ZoneGain_0", "ZoneMute_0", "ZoneSource_0", "ZoneGain_1", "ZoneMute_1", "ZoneSource_1"]);

    await manager.execute("dsp", "set_gain", { zone: 1, db: -22 });
    await manager.execute("dsp", "set_mute", { zone: 0, mute: true });
    assert.deepEqual(JSON.parse(lines[6]), { jsonrpc: "2.0", method: "set", params: { param: "ZoneGain_1", val: -22 } });
    assert.deepEqual(JSON.parse(lines[7]).params, { param: "ZoneMute_0", val: 1 });
    assert.equal(state.state.devices.dsp.state["zones.1.gain"], -22);

    client!.write('{"jsonrpc":"2.0","method":"update","params":[{"param":"ZoneGain_0","val":-35},{"param":"ZoneMute_0","val":0}]}\n');
    await until(() => state.state.devices.dsp.state["zones.0.gain"] === -35);
    assert.equal(state.state.devices.dsp.state["zones.0.mute"], false);
    assert.equal(state.state.devices.dsp.online, true);

    await assert.rejects(manager.execute("dsp", "set_gain", { zone: 0, db: 6 }), /between -80 and 0/);
  } finally {
    cleanup();
    dsp.close();
  }
});

test("TCL Roku profile: discrete keypresses, polled power and model", async () => {
  const hits: string[] = [];
  let mode = "DisplayOff";
  const tv = createHttpServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/keypress/PowerOn") mode = "PowerOn";
    res.end(req.url === "/query/device-info" ? `<device-info><model-name>55S455</model-name><power-mode>${mode}</power-mode><network-type>ethernet</network-type></device-info>` : "");
  });
  await new Promise<void>((r) => tv.listen(0, "127.0.0.1", r));
  const { manager, state, cleanup } = setup();
  try {
    manager.apply(site({ devices: [{ id: "tv", name: "TV", profile: "tcl-roku-tv", settings: { host: "127.0.0.1", port: (tv.address() as { port: number }).port } }] }));
    await until(() => state.state.devices.tv.state.model === "55S455");
    assert.equal(state.state.devices.tv.state.power, "off");
    assert.equal(state.state.devices.tv.online, true);

    await manager.capability("tv", "power", "on");
    await manager.execute("tv", "input", { input: "hdmi2" });
    assert.deepEqual(hits.slice(1), ["POST /keypress/PowerOn", "POST /keypress/InputHDMI2"]);
    assert.equal(state.state.devices.tv.state.power, "on");
    await assert.rejects(manager.execute("tv", "input", { input: "vga" }), /must be one of/);
  } finally {
    cleanup();
    tv.close();
  }
});

test("Xfinity profile extended with learned codes tunes digit by digit over the iTach", async () => {
  const sent: string[] = [];
  const itach = createTcpServer((sock) =>
    sock.on("data", (d) => {
      for (const cmd of d.toString().split("\r").filter(Boolean)) {
        sent.push(cmd);
        const [, addr, id] = cmd.split(",");
        sock.write(`completeir,${addr},${id}\r`);
      }
    }),
  );
  await new Promise<void>((r) => itach.listen(0, "127.0.0.1", r));
  const codes: Record<string, string> = { KEY_OK: PRONTO(100) };
  for (let d = 0; d <= 9; d++) codes[`KEY_${d}`] = PRONTO(d + 1);
  const { manager, state, cleanup } = setup([{ id: "xfinity-site", name: "Xfinity (our codes)", extends: "xfinity-ir", irCodes: codes }]);
  try {
    manager.apply(site({
      devices: [{
        id: "box1", name: "Box 1", profile: "xfinity-site",
        settings: { irHost: "127.0.0.1", irPort: 2, irTcpPort: (itach.address() as { port: number }).port, digitDelayMs: 0 },
      }],
    }));
    await manager.capability("box1", "tuner", "tune", 25);
    // Last pulse identifies the code: KEY_2 -> 3, KEY_5 -> 6, KEY_OK -> 100.
    assert.deepEqual(sent.map((c) => [c.split(",")[1], Number(c.split(",").at(-1))]), [["1:2", 3], ["1:2", 6], ["1:2", 100]]);
    assert.equal(state.state.devices.box1.state.channel, "25");

    await assert.rejects(manager.execute("box1", "key", { key: "KEY_RECORD" }), /No IR code "KEY_RECORD"/);
  } finally {
    cleanup();
    itach.close();
  }
});

test("hot reload restarts only changed devices; groups, capabilities and scenes work in simulation", async () => {
  const { manager, state, cleanup } = setup([], true);
  try {
    const panels = ["p1", "p2", "p3"].map((id) => ({ id, name: id.toUpperCase(), profile: "tcl-roku-tv", settings: { host: `10.0.0.${id.slice(1)}` } }));
    const base = {
      devices: panels,
      groups: [{ id: "wall", name: "Wall", kind: "wall", devices: ["p1", "p2", "p3"], staggerMs: 0 }],
      scenes: [{
        id: "open", name: "Open", steps: [
          { type: "command", group: "wall", command: "power_on" },
          { type: "waitFor", device: "p3", state: "power", equals: "on", timeoutMs: 500 },
          { type: "command", device: "p1", command: "input", params: { input: "hdmi4" } },
          { type: "command", device: "p2", command: "explode" },
        ],
      }],
    };
    let current = site(base);
    manager.apply(current);
    const p1 = manager.runtime("p1");

    const result = await new EngineSceneRunner(() => current, manager, state).run("open");
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /step 4 .*no command "explode"/);
    assert.deepEqual(["p1", "p2", "p3"].map((id) => state.state.devices[id].state.power), ["on", "on", "on"]);

    // Rename p2 only: p1's runtime must survive the reload.
    current = site({ ...base, devices: [panels[0], { ...panels[1], name: "Renamed" }, panels[2]] });
    manager.apply(current);
    assert.equal(manager.runtime("p1"), p1);
    assert.equal(state.state.devices.p2.name, "Renamed");

    // Removing a device stops it and drops its state.
    current = site({ ...base, devices: panels.slice(0, 2), groups: [], scenes: [] });
    manager.apply(current);
    assert.equal(state.state.devices.p3, undefined);
    assert.throws(() => manager.runtime("p3"), /Unknown device/);
    assert.deepEqual(manager.withCapability("power").sort(), ["p1", "p2"]);
  } finally {
    cleanup();
  }
});

test("bad profiles and devices are reported, not fatal", () => {
  const { lib, manager, state, cleanup } = setup();
  try {
    const errors = lib.saveCustom({
      id: "broken-thing", name: "Broken", transport: { type: "tcp", port: 23 },
      commands: { on: { steps: [{ ir: "KEY_POWER" }] }, again: { steps: [{ command: "nope" }] }, x: { steps: [{ send: "{{a | bogus}}" }] } },
    });
    assert.deepEqual(errors.sort(), [
      'command again: unknown command "nope"',
      "command on: a ir step can't be sent over tcp",
      'command x: unknown filter "bogus"',
    ]);
    assert.equal(lib.get("broken-thing"), undefined);

    manager.apply(site({
      devices: [
        { id: "a", name: "A", profile: "does-not-exist" },
        { id: "b", name: "B", profile: "tcl-roku-tv", settings: {} },
      ],
    }));
    assert.match(state.state.devices.a.problem!, /missing or has errors/);
    assert.match(state.state.devices.b.problem!, /"IP address" is required/);

    assert.deepEqual(checkSite(SiteSchema.parse({ groups: [{ id: "g", name: "G", devices: ["ghost"] }] })), ['group g: unknown device "ghost"']);
  } finally {
    cleanup();
  }
});
