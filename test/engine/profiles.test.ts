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

test("built-in PJLink profile: queries power and input, reads replies", async () => {
  const got: string[] = [];
  const projector = createTcpServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\r")) >= 0; buf = buf.slice(i + 1)) {
        const cmd = buf.slice(0, i);
        got.push(cmd);
        if (cmd === "%1POWR ?") sock.write("%1POWR=3\r");
        if (cmd === "%1INPT ?") sock.write("%1INPT=32\r");
        if (cmd === "%1AVMT 31") sock.write("%1AVMT=OK\r%1AVMT=31\r");
      }
    });
  });
  await new Promise<void>((r) => projector.listen(0, "127.0.0.1", r));
  const { manager, state, cleanup } = setup();
  try {
    manager.apply(site({ devices: [{ id: "pj", name: "PJ", profile: "pjlink", settings: { host: "127.0.0.1", port: (projector.address() as { port: number }).port } }] }));
    await until(() => state.state.devices.pj.state.power === "warming" && state.state.devices.pj.state.input === "32");
    await manager.execute("pj", "av_mute", { mute: true });
    await until(() => state.state.devices.pj.state.muted === true);
    assert.ok(got.includes("%1AVMT 31"));
  } finally {
    cleanup();
    projector.close();
  }
});

test("mosaic engine profile: reads walls and presets live, recalls with the API key, follows the engine", async () => {
  // A fake mosaic engine following CONTROL_API.md.
  const requests: { method: string; url: string; key?: string; type?: string; body: string }[] = [];
  const engineState = {
    groups: [
      { id: "main-wall", name: "Main wall", displays: 16, activePreset: "camera-1-full", presets: [{ id: "camera-1-full", name: "Camera 1 full" }, { id: "camera-slides", name: "Camera + slides" }], showing: [], noSignal: [] },
      { id: "double-wide", name: "Double wide", displays: 1, activePreset: "", presets: [], showing: [], noSignal: [] },
    ],
    endpoints: [{ id: "wall-pc-1", name: "Wall PC 1", online: true, displays: 4, displaysOk: 4 }],
    scenes: [{ id: "opening", name: "Opening" }],
    layouts: [{ id: "venue", name: "Venue", active: true }],
    layout: { id: "venue", name: "Venue" },
    ndi: { available: true, streams: ["ZOWIEBOXPRO-54447 (ZowieBox-54447)", "GFX-PC (Slides)"] },
  };
  const engine = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ method: req.method!, url: req.url!, key: req.headers["x-api-key"] as string, type: req.headers["content-type"], body });
      const send = (status: number, data: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      if (req.method === "GET" && req.url === "/api/control") return send(200, engineState);
      if (req.method === "POST") {
        if (!body && req.headers["content-length"] !== "0") return send(400, { error: "body or Content-Length: 0 required" });
        if (req.headers["x-api-key"] !== "secret") return send(401, { error: "API key required" });
        const m = /^\/api\/walls\/([^/]+)\/(presets\/([^/]+)\/recall|show|clear)$/.exec(req.url!);
        const group = m && engineState.groups.find((g) => g.id === m[1]);
        if (!group) return send(404, { error: "no such wall group" });
        if (m[3]) {
          if (!group.presets.some((p) => p.id === m[3])) return send(404, { error: `no such preset in group '${group.id}'` });
          group.activePreset = m[3];
          return send(200, { group: group.id, recalled: m[3], transitionMs: JSON.parse(body).transitionMs });
        }
        group.activePreset = "";
        return send(200, { group: group.id });
      }
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  const { manager, state, cleanup } = setup();
  try {
    const port = (engine.address() as { port: number }).port;
    manager.apply(site({ devices: [{ id: "mosaic", name: "Mosaic", profile: "mosaic-engine", settings: { host: "127.0.0.1", port, apiKey: "secret" } }] }));
    const st = () => state.state.devices.mosaic.state;

    // Everything comes from GET /api/control.
    await until(() => Array.isArray(st().groupList));
    assert.deepEqual((st().groupList as { id: string }[]).map((g) => g.id), ["main-wall", "double-wide"]);
    assert.equal(st()["groups.main-wall.activePreset"], "camera-1-full");
    assert.deepEqual((st()["groups.main-wall.presets"] as { id: string }[]).map((p) => p.id), ["camera-1-full", "camera-slides"]);
    assert.deepEqual(st().streams, engineState.ndi.streams);
    assert.equal(st()["endpoints.wall-pc-1.online"], true);
    assert.equal(st().layout, "Venue");

    await manager.execute("mosaic", "recall_preset", { group: "main-wall", preset: "camera-slides", transitionMs: 800 });
    const recall = requests.find((r) => r.url === "/api/walls/main-wall/presets/camera-slides/recall")!;
    assert.deepEqual({ key: recall.key, type: recall.type, body: JSON.parse(recall.body) }, { key: "secret", type: "application/json", body: { transitionMs: 800 } });
    assert.equal(st()["groups.main-wall.activePreset"], "camera-slides");

    // Stream names with spaces and parentheses are sent as proper JSON.
    await manager.execute("mosaic", "show_stream", { group: "double-wide", ndiName: 'GFX-PC (Slides) "B"' });
    assert.deepEqual(JSON.parse(requests.find((r) => r.url === "/api/walls/double-wide/show")!.body), { ndiName: 'GFX-PC (Slides) "B"', transitionMs: 500 });

    await assert.rejects(manager.execute("mosaic", "recall_preset", { group: "main-wall", preset: "nope" }), /HTTP 404/);

    // A change made in the mosaic editor shows up on the next poll.
    engineState.groups[0].activePreset = "camera-1-full";
    await until(() => st()["groups.main-wall.activePreset"] === "camera-1-full", 5000);
  } finally {
    cleanup();
    engine.close();
  }
});

test("mosaic engine without the API key is refused (401) and says so", async () => {
  const engine = createHttpServer((req, res) => {
    res.writeHead(req.headers["x-api-key"] ? 200 : 401, { "content-type": "application/json" });
    res.end(req.method === "GET" ? JSON.stringify({ groups: [] }) : '{"error":"API key required"}');
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  const { manager, cleanup } = setup();
  try {
    manager.apply(site({ devices: [{ id: "m", name: "M", profile: "mosaic-engine", settings: { host: "127.0.0.1", port: (engine.address() as { port: number }).port } }] }));
    await assert.rejects(manager.execute("m", "clear", { group: "main-wall" }), /HTTP 401/);
  } finally {
    cleanup();
    engine.close();
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
