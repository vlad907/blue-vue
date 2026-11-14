import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityStore, resetIdentity } from "../../agent/src/transports/androidtv/cert.ts";
import { finishPairing, startPairing } from "../../agent/src/transports/androidtv/remote.ts";
import { appleTvStore, helper as appleTvHelper, pairAppleTv, scanAppleTvs } from "../../agent/src/transports/appletv/helper.ts";
import { FakeTv } from "../../agent/test/fake-android-tv.ts";
import { FakeFireTv } from "../../agent/test/fake-adb-device.ts";
import { resetAdbKey } from "../../agent/src/transports/adb/client.ts";
import { DeviceManager, type PowerOnTiming } from "../../src/engine/device-manager.ts";
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

function setup(customProfiles: Record<string, unknown>[] = [], simulate = false, timing?: Partial<PowerOnTiming>) {
  const custom = mkdtempSync(join(tmpdir(), "bv-profiles-"));
  const lib = new ProfileLibrary(BUILTIN, custom).load();
  for (const p of customProfiles) assert.deepEqual(lib.saveCustom(p), []);
  const state = new StateStore();
  const manager = new DeviceManager(lib, state, { simulate, timing });
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

test("Roku TV profile: discrete keypresses, polled power, model and app on screen", async () => {
  const hits: string[] = [];
  let mode = "DisplayOff";
  const tv = createHttpServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/keypress/PowerOn") mode = "PowerOn";
    if (req.url === "/query/active-app") return res.end(`<active-app><app id="12" type="appl" version="5.0">Netflix</app></active-app>`);
    res.end(req.url === "/query/device-info" ? `<device-info><model-name>55S455</model-name><power-mode>${mode}</power-mode><network-type>ethernet</network-type></device-info>` : "");
  });
  await new Promise<void>((r) => tv.listen(0, "127.0.0.1", r));
  const { manager, state, cleanup } = setup();
  try {
    manager.apply(site({ devices: [{ id: "tv", name: "TV", profile: "tcl-roku-tv", settings: { host: "127.0.0.1", port: (tv.address() as { port: number }).port } }] }));
    await until(() => state.state.devices.tv.state.model === "55S455" && state.state.devices.tv.state.app === "Netflix");
    assert.equal(state.state.devices.tv.state.power, "off");
    assert.equal(state.state.devices.tv.online, true);

    await manager.capability("tv", "power", "on");
    await manager.execute("tv", "input", { input: "hdmi2" });
    await manager.execute("tv", "launch", { app: "837" });
    assert.deepEqual(hits.filter((h) => h.startsWith("POST")), ["POST /keypress/PowerOn", "POST /keypress/InputHDMI2", "POST /launch/837"]);
    assert.equal(state.state.devices.tv.state.power, "on");
    assert.equal(state.state.devices.tv.state.input, "hdmi2");
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

test("TCL Google TV remote profile: pairs, reads power from the TV, presses POWER only when needed", async () => {
  identityStore.dir = mkdtempSync(join(tmpdir(), "bv-atv-"));
  resetIdentity();
  const tv = new FakeTv();
  await tv.start();
  const { manager, state, cleanup } = setup();
  try {
    await startPairing("127.0.0.1", tv.pairingPort);
    await finishPairing("127.0.0.1", tv.code);
    manager.apply(site({ devices: [{ id: "tv", name: "TV", profile: "tcl-google-tv-remote", settings: { host: "127.0.0.1", port: tv.remotePort } }] }));
    await until(() => state.state.devices.tv.state.power === "off", 5000);
    assert.equal(state.state.devices.tv.state.model, "98QM7L");
    assert.equal(state.state.devices.tv.online, true);

    await manager.capability("tv", "power", "on");
    assert.equal(state.state.devices.tv.state.power, "on");
    await manager.capability("tv", "power", "on"); // already on: nothing pressed
    await manager.execute("tv", "input", { input: "hdmi1" });
    await manager.execute("tv", "home");
    await until(() => tv.keys.length === 3);
    assert.deepEqual(tv.keys, [26, 243, 3]);
    assert.equal(state.state.devices.tv.state.input, "hdmi1");
    await manager.capability("tv", "power", "off");
    assert.equal(state.state.devices.tv.state.power, "off");
  } finally {
    cleanup();
    tv.stop();
  }
});

test("Fire TV profile over built-in ADB: asks to be allowed once, discrete power, reads what's on screen", async () => {
  identityStore.dir = mkdtempSync(join(tmpdir(), "bv-adb-"));
  resetAdbKey();
  const tv = await new FakeFireTv().start();
  const { manager, state, cleanup } = setup();
  try {
    manager.apply(site({ devices: [{ id: "tv", name: "TV", profile: "fire-tv", settings: { host: "127.0.0.1", port: tv.port } }] }));
    await until(() => state.state.devices.tv.state.model === "AFTKRT", 5000);
    assert.equal(tv.prompts, 1);
    assert.equal(state.state.devices.tv.state.power, "off");
    assert.equal(state.state.devices.tv.state.app, "com.amazon.tv.launcher");
    assert.equal(state.state.devices.tv.online, true);

    await manager.capability("tv", "power", "on");
    await manager.execute("tv", "input", { input: "hdmi3" });
    await manager.execute("tv", "launch", { app: "com.netflix.ninja" });
    assert.equal(tv.awake, true);
    assert.deepEqual(tv.commands.filter((c) => !c.startsWith("dumpsys")), [
      "input keyevent KEYCODE_WAKEUP",
      "input keyevent KEYCODE_TV_INPUT_HDMI_3",
      "monkey -p com.netflix.ninja -c android.intent.category.LAUNCHER 1",
    ]);
    assert.equal(state.state.devices.tv.state.input, "hdmi3");
    await manager.capability("tv", "power", "off");
    assert.equal(tv.awake, false);
    assert.equal(state.state.devices.tv.state.power, "off");
  } finally {
    cleanup();
    tv.stop();
  }
});

test("turning a wall on wakes a TV that keeps dropping its connection, then selects the wall's input", async () => {
  identityStore.dir = mkdtempSync(join(tmpdir(), "bv-adb-"));
  resetAdbKey();
  const tv = await new FakeFireTv().start();
  const { manager, state, cleanup } = setup([], false, { powerOnRetryMs: 300, inputAfterOnMs: 50, inputAgainMs: 50 });
  try {
    manager.apply(site({
      devices: [{ id: "tv", name: "TV", profile: "fire-tv", settings: { host: "127.0.0.1", port: tv.port } }],
      groups: [{ id: "bar", name: "Bar", kind: "wall", devices: ["tv"], powerOnInput: "hdmi2" }],
    }));
    await until(() => state.state.devices.tv.state.model === "AFTKRT", 5000);
    tv.dropNext = 2; // asleep: the TV hangs up on the next two tries
    await manager.groupCapability("bar", "power", "on");
    assert.equal(tv.awake, true);
    await until(() => tv.commands.filter((c) => c.includes("HDMI")).length === 2);
    assert.deepEqual(tv.commands.filter((c) => c.startsWith("input")), [
      "input keyevent KEYCODE_WAKEUP",
      "input keyevent KEYCODE_TV_INPUT_HDMI_2",
      "input keyevent KEYCODE_TV_INPUT_HDMI_2",
    ]);
    assert.equal(state.state.devices.tv.state.input, "hdmi2");
    // A TV's own setting wins over its wall's.
    manager.apply(site({
      devices: [{ id: "tv", name: "TV", profile: "fire-tv", settings: { host: "127.0.0.1", port: tv.port, powerOnInput: "hdmi4" } }],
      groups: [{ id: "bar", name: "Bar", kind: "wall", devices: ["tv"], powerOnInput: "hdmi2" }],
    }));
    assert.equal(manager.powerOnInput("tv"), "hdmi4");
  } finally {
    cleanup();
    tv.stop();
  }
});

test("Apple TV profile: pairs in two steps, then keys, power and apps go through the helper, and a helper that dies is reported", async () => {
  // A stand-in helper with the protocol of bluevue_atv.py; the real one needs an Apple TV.
  process.env.BLUEVUE_ATV_HELPER = JSON.stringify([process.execPath, join(import.meta.dirname, "../fixtures/fake-atv-helper.mjs")]);
  appleTvStore.dir = mkdtempSync(join(tmpdir(), "bv-atv-"));
  const { manager, state, cleanup } = setup();
  try {
    manager.apply(site({ devices: [
      { id: "bar", name: "Bar Apple TV", profile: "apple-tv", settings: { host: "192.168.5.40" } },
      { id: "new", name: "New Apple TV", profile: "apple-tv", settings: { host: "192.168.5.99" } },
    ] }));
    const bar = () => state.state.devices.bar;
    const fresh = () => state.state.devices.new;
    await until(() => bar().online && fresh().state.paired === false);
    assert.equal(bar().state.power, "off");
    assert.equal(bar().state.model, "Apple TV 4K");
    assert.deepEqual((bar().state.apps as { id: string }[]).map((a) => a.id), ["com.netflix.Netflix", "com.espn.ScoreCenter"]);

    // An unpaired box is offline and says why; commands to it are refused.
    assert.equal(fresh().online, false);
    await assert.rejects(manager.execute("new", "home"), /paired/);

    // Pairing: the first code, then a second one, and the box comes online by itself.
    assert.deepEqual(await pairAppleTv("192.168.5.99", "start"), { done: false, more: false, message: undefined });
    const first = await pairAppleTv("192.168.5.99", "finish", "1111");
    assert.equal(first.done, false);
    assert.equal(first.more, true);
    assert.match(first.message!, /second code/);
    assert.equal((await pairAppleTv("192.168.5.99", "finish", "2222")).done, true);
    await until(() => fresh().online);
    await pairAppleTv("192.168.5.99", "start");
    await assert.rejects(pairAppleTv("192.168.5.99", "finish", "0000"), /doesn't match/);

    // Power is discrete and the box's own report sets the state.
    await manager.capability("bar", "power", "on");
    assert.equal(bar().state.power, "on");
    await manager.execute("bar", "key", { key: "select" });
    await manager.execute("bar", "play_pause");
    await assert.rejects(manager.execute("bar", "key", { key: "sideways" }), /key/);
    await manager.execute("bar", "open_app", { app: "com.netflix.Netflix" });
    await until(() => bar().state.app === "Netflix");
    assert.equal(bar().state.appId, "com.netflix.Netflix");

    assert.deepEqual(await scanAppleTvs(["192.168.5"]), [{ host: "192.168.5.40", name: "Bar Apple TV", model: "Apple TV 4K", mac: "AA:BB:CC:00:00:01" }]);
    await assert.rejects(scanAppleTvs(["nope"]), /isn't a network/);

    // The helper dying takes the boxes offline with a reason, not silently.
    const runtime = (manager as unknown as { runtimes: Map<string, { conn: { send: (p: unknown) => Promise<unknown> } }> }).runtimes.get("bar")!;
    await assert.rejects(runtime.conn.send({ kind: "appletv", key: "crash" }), /helper stopped/);
    await until(() => !bar().online);
    assert.match(bar().error ?? "", /helper stopped/);
  } finally {
    cleanup();
    appleTvHelper.stop();
    delete process.env.BLUEVUE_ATV_HELPER;
  }
});

test("TCL Google TV remote profile in simulation follows on/off", async () => {
  const { manager, state, cleanup } = setup([], true);
  try {
    manager.apply(site({ devices: [{ id: "tv", name: "TV", profile: "tcl-google-tv-remote", settings: { host: "10.0.0.9" } }] }));
    await until(() => state.state.devices.tv?.online === true);
    await manager.capability("tv", "power", "off");
    assert.equal(state.state.devices.tv.state.power, "off");
    await manager.capability("tv", "power", "on");
    assert.equal(state.state.devices.tv.state.power, "on");
  } finally {
    cleanup();
  }
});

test("group commands start panels one after another but don't wait for each to finish", async () => {
  const slow = { id: "slow-tv", name: "Slow TV", transport: { type: "tcp", port: 1 }, settings: [{ key: "host", label: "IP", type: "string" }], commands: { power_on: { steps: [{ delay: 400 }] }, power_off: { steps: [{ delay: 400 }] } }, capabilities: { power: { on: "power_on", off: "power_off" } } };
  const { manager, cleanup } = setup([slow], true);
  try {
    const devices = [1, 2, 3, 4, 5].map((n) => ({ id: `tv${n}`, name: `TV ${n}`, profile: "slow-tv", settings: { host: "10.0.0.1" } }));
    manager.apply(site({ devices, groups: [{ id: "wall", name: "Wall", kind: "wall", devices: devices.map((d) => d.id), staggerMs: 50, columns: 5 }] }));
    const t0 = Date.now();
    await manager.groupCapability("wall", "power", "on");
    const took = Date.now() - t0;
    // One at a time would take 5 x 400ms plus gaps; staggered starts take about 400 + 4 x 50.
    assert.ok(took < 1200, `took ${took}ms`);
    assert.ok(took >= 550, `took ${took}ms`);
  } finally {
    cleanup();
  }
});

test("a wall's mosaic link must name a saved device", () => {
  const s = SiteSchema.parse({ devices: [{ id: "tv1", name: "TV", profile: "tcl-google-tv-remote", settings: { host: "1.2.3.4" } }], groups: [{ id: "w", name: "W", kind: "wall", devices: ["tv1"], mosaic: { device: "nope", group: "main" } }] });
  assert.deepEqual(checkSite(s), ['group w: unknown mosaic device "nope"']);
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
  // A fake mosaic engine following CONTROL_API.md: two canvases, each with its own walls and sound outputs.
  const requests: { method: string; path: string; canvas: string; key?: string; type?: string; body: string }[] = [];
  const canvasState = (wall: string) => ({
    groups: [
      { id: wall, name: "Main wall", displays: 16, activePreset: "camera-1-full", presets: [{ id: "camera-1-full", name: "Camera 1 full" }, { id: "camera-slides", name: "Camera + slides" }], showing: [{ name: "Camera 1", type: "ndi", ndiName: "CAM (1)", signal: "ok" }], noSignal: [] as string[] },
      { id: "double-wide", name: "Double wide", displays: 1, activePreset: "", presets: [] as { id: string; name: string }[], showing: [], noSignal: ["GFX-PC (Slides)"] },
    ],
    endpoints: [{ id: "wall-pc-1", name: "Wall PC 1", online: true, displays: 4, displaysOk: 4 }],
    scenes: [{ id: "opening", name: "Opening" }],
    layouts: [{ id: "venue", name: "Venue", active: true }],
    layout: { id: "venue", name: wall === "main-wall" ? "Venue" : "Bar tower" },
    ndi: { available: true, streams: ["ZOWIEBOXPRO-54447 (ZowieBox-54447)", "GFX-PC (Slides)"] },
    audioOutputs: [
      { id: "bar", name: "Bar speakers", source: "GFX-PC (Slides)", device: "", channelPair: 0, volumeDb: 0, mute: false, matchWall: true, delayMs: 0, enabled: true },
      { id: "patio", name: "Patio", source: "", device: "", channelPair: 1, volumeDb: -10, mute: false, matchWall: true, delayMs: 0, enabled: true },
    ],
  });
  const canvases: Record<string, ReturnType<typeof canvasState>> = { "canvas-1": canvasState("main-wall"), "canvas-2": canvasState("tower") };
  const engine = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const canvasId = req.headers["x-mosaic-canvas"] ?? url.searchParams.get("canvas") ?? "";
      requests.push({ method: req.method!, path: url.pathname, canvas: String(canvasId), key: req.headers["x-api-key"] as string, type: req.headers["content-type"], body });
      const send = (status: number, data: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      const c = canvases[String(canvasId || "canvas-1")];
      if (!c) return send(req.method === "GET" ? 500 : 409, { error: `canvas '${canvasId}' isn't running any more` });
      const { audioOutputs, ...control } = c;
      if (req.method === "GET" && url.pathname === "/api/control") return send(200, control);
      if (req.method === "GET" && url.pathname === "/api/layout") return send(200, { id: "venue", outputs: [], audioOutputs });
      if (req.method === "GET" && url.pathname === "/api/audio") return send(200, { outputs: audioOutputs.map((o) => ({ id: o.id, levelDb: [-20, -20], error: "", sourceError: o.source ? "" : "no such stream" })) });
      if (req.method !== "GET") {
        if (!body && req.headers["content-length"] !== "0") return send(400, { error: "body or Content-Length: 0 required" });
        if (req.headers["x-api-key"] !== "secret") return send(401, { error: "API key required" });
        if (req.method === "PUT" && url.pathname === "/api/layout") {
          c.audioOutputs = JSON.parse(body).audioOutputs; // the whole list replaces the old one
          return send(200, {});
        }
        const m = /^\/api\/walls\/([^/]+)\/(presets\/([^/]+)\/recall|show|clear|restart)$/.exec(url.pathname);
        const group = m && c.groups.find((g) => g.id === m[1]);
        if (!group) return send(404, { error: "no such wall group" });
        if (m[2] === "restart") return send(200, { group: group.id, restarted: [`${group.id}--video`] });
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
    manager.apply(site({ devices: [
      { id: "mosaic", name: "Mosaic", profile: "mosaic-engine", settings: { host: "127.0.0.1", port, apiKey: "secret" } },
      { id: "tower", name: "Bar tower", profile: "mosaic-engine", settings: { host: "127.0.0.1", port, apiKey: "secret", canvas: "canvas-2" } },
    ] }));
    const st = () => state.state.devices.mosaic.state;
    const tw = () => state.state.devices.tower.state;

    // Everything comes from GET /api/control, per canvas.
    await until(() => Array.isArray(st().groupList) && Array.isArray(tw().groupList) && Array.isArray(st().audioOutputs) && st()["audio.patio.problem"] !== undefined);
    assert.deepEqual((st().groupList as { id: string }[]).map((g) => g.id), ["main-wall", "double-wide"]);
    assert.deepEqual((tw().groupList as { id: string }[]).map((g) => g.id), ["tower", "double-wide"]);
    assert.equal(tw().layout, "Bar tower");
    assert.equal(st()["groups.main-wall.activePreset"], "camera-1-full");
    assert.deepEqual((st()["groups.main-wall.presets"] as { id: string }[]).map((p) => p.id), ["camera-1-full", "camera-slides"]);
    assert.deepEqual((st()["groups.main-wall.showing"] as { name: string }[]).map((x) => x.name), ["Camera 1"]);
    assert.deepEqual(st()["groups.double-wide.noSignal"], ["GFX-PC (Slides)"]);
    assert.deepEqual(st().streams, canvases["canvas-1"].ndi.streams);
    assert.equal(st()["endpoints.wall-pc-1.online"], true);
    assert.equal(st().layout, "Venue");
    assert.equal(st()["audio.patio.volumeDb"], -10);
    assert.equal(st()["audio.patio.problem"], "no such stream");
    assert.equal(st()["audio.bar.problem"], "");

    await manager.execute("mosaic", "recall_preset", { group: "main-wall", preset: "camera-slides", transitionMs: 800 });
    const recall = requests.find((r) => r.path === "/api/walls/main-wall/presets/camera-slides/recall")!;
    assert.deepEqual({ canvas: recall.canvas, key: recall.key, type: recall.type, body: JSON.parse(recall.body) }, { canvas: "", key: "secret", type: "application/json", body: { transitionMs: 800 } });
    assert.equal(st()["groups.main-wall.activePreset"], "camera-slides");

    // The second device controls only its own canvas.
    await manager.execute("tower", "recall_preset", { group: "tower", preset: "camera-slides" });
    assert.equal(canvases["canvas-2"].groups[0].activePreset, "camera-slides");
    assert.equal(requests.find((r) => r.path === "/api/walls/tower/presets/camera-slides/recall")!.canvas, "canvas-2");
    await manager.execute("tower", "restart_videos", { group: "tower" });
    assert.equal(requests.find((r) => r.path === "/api/walls/tower/restart")!.canvas, "canvas-2");

    // Stream names with spaces and parentheses are sent as proper JSON.
    await manager.execute("mosaic", "show_stream", { group: "double-wide", ndiName: 'GFX-PC (Slides) "B"' });
    assert.deepEqual(JSON.parse(requests.find((r) => r.path === "/api/walls/double-wide/show")!.body), { ndiName: 'GFX-PC (Slides) "B"', transitionMs: 500 });

    await assert.rejects(manager.execute("mosaic", "recall_preset", { group: "main-wall", preset: "nope" }), /HTTP 404/);

    // Sound: one value of one output changes; the rest of the list goes back as it was, including
    // a change someone made in the editor a moment ago.
    canvases["canvas-1"].audioOutputs[1].delayMs = 40;
    await manager.execute("mosaic", "audio_volume", { output: "bar", volumeDb: -12 });
    await manager.execute("mosaic", "audio_mute", { output: "patio", mute: true });
    await manager.execute("mosaic", "audio_source", { output: "patio", source: "ZOWIEBOXPRO-54447 (ZowieBox-54447)" });
    const outs = canvases["canvas-1"].audioOutputs;
    assert.deepEqual(outs.map((o) => [o.id, o.volumeDb, o.mute, o.source, o.delayMs]), [
      ["bar", -12, false, "GFX-PC (Slides)", 0],
      ["patio", -10, true, "ZOWIEBOXPRO-54447 (ZowieBox-54447)", 40],
    ]);
    assert.equal(st()["audio.bar.volumeDb"], -12);
    assert.equal(canvases["canvas-2"].audioOutputs[0].volumeDb, 0);
    // An output that isn't there is refused before anything is sent, so no list gets wiped.
    const puts = requests.filter((r) => r.method === "PUT").length;
    await assert.rejects(manager.execute("mosaic", "audio_mute", { output: "lobby", mute: true }), /no item with id "lobby"/);
    assert.equal(requests.filter((r) => r.method === "PUT").length, puts);
    assert.equal(canvases["canvas-1"].audioOutputs.length, 2);

    // A change made in the mosaic editor shows up on the next poll.
    canvases["canvas-1"].groups[0].activePreset = "camera-1-full";
    await until(() => st()["groups.main-wall.activePreset"] === "camera-1-full", 5000);

    // A stopped canvas is refused (409), not applied to another wall.
    delete canvases["canvas-2"];
    await assert.rejects(manager.execute("tower", "clear", { group: "tower" }), /HTTP 409/);
    assert.equal(canvases["canvas-1"].groups[0].activePreset, "camera-1-full");
  } finally {
    cleanup();
    engine.close();
  }
});

test("mosaic engine profile: splits a wall, fills its slots, switches content and the background, and reads the result back", async () => {
  // A fake engine with the arrangement, background and playlist requests of CONTROL_API.md.
  const requests: { method: string; path: string; body: any }[] = [];
  const names: Record<string, string[]> = { full: ["Whole"], two: ["Left", "Right"], quad: ["Top left", "Top right", "Bottom left", "Bottom right"] };
  const wall = { id: "ultrawide", name: "Ultrawide", on: true, arrangement: "full", content: [{ ndiName: "PC (Cam 1)", playlist: "" }] as { ndiName: string; playlist: string }[], presets: [] as { id: string; name: string }[] };
  const background = { on: false, chosen: false, ndiName: "", playlist: "", video: "", signal: "empty" };
  const identify: unknown[] = [];
  const control = () => ({
    groups: [{
      id: wall.id, name: wall.name, activePreset: "", presets: wall.presets, showing: [], noSignal: [],
      on: wall.on, arrangement: wall.on ? wall.arrangement : "",
      slots: wall.on ? names[wall.arrangement].map((name, i) => ({ slot: i + 1, name, ndiName: wall.content[i]?.ndiName ?? "", playlist: wall.content[i]?.playlist ?? "", video: "", signal: "ok" })) : [],
      arrangements: [{ id: "full", name: "One stream", slots: 1 }, { id: "two", name: "Two side by side", slots: 2 }, { id: "quad", name: "Four", slots: 4 }],
    }],
    endpoints: [{ id: "wall-pc-1", name: "Wall PC 1", online: true, displays: 4, displaysOk: 4 }],
    scenes: [], layouts: [], layout: { id: "venue", name: "Venue" },
    ndi: { available: true, streams: ["PC (Cam 1)", "PC (Cam 2)"] },
    playlists: [{ id: "Game day", name: "Game day", videos: 2 }],
    background,
  });
  const engine = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const send = (status: number, data: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      if (req.method === "GET") {
        if (url.pathname === "/api/control") return send(200, control());
        if (url.pathname === "/api/canvases") return send(200, { canvases: [{ id: "canvas-1", name: "Inside bar", running: true, error: "" }, { id: "canvas-2", name: "Bar tower", running: false, error: "lost its GPU" }] });
        if (url.pathname === "/api/layout") return send(200, { audioOutputs: [] });
        if (url.pathname === "/api/audio") return send(200, { outputs: [] });
        return send(404, { error: "not found" });
      }
      const body = JSON.parse(raw || "{}");
      requests.push({ method: req.method!, path: url.pathname, body });
      const fill = (b: any) => ({ ndiName: b.ndiName ?? "", playlist: b.playlist ?? "" });
      let m;
      if (url.pathname === "/api/walls/ultrawide/arrange") {
        if (!names[body.arrangement]) return send(400, { error: "no such arrangement" });
        wall.arrangement = body.arrangement;
        wall.on = true;
        return send(200, {});
      }
      if ((m = /^\/api\/walls\/ultrawide\/slots\/(\d+)$/.exec(url.pathname))) {
        if (Number(m[1]) > names[wall.arrangement].length) return send(400, { error: `no slot ${m[1]}` });
        wall.content[Number(m[1]) - 1] = fill(body);
        return send(200, {});
      }
      if (url.pathname === "/api/walls/ultrawide/content") { wall.on = body.on; return send(200, {}); }
      if (url.pathname === "/api/walls/ultrawide/presets") { wall.presets.push({ id: String(body.name).toLowerCase().replace(/ /g, "-"), name: body.name }); return send(201, {}); }
      if (url.pathname === "/api/background") {
        if (body.ndiName || body.playlist) Object.assign(background, fill(body), { chosen: true, signal: "ok" });
        background.on = body.on ?? true;
        return send(200, background);
      }
      if (url.pathname === "/api/endpoints/wall-pc-1/identify") { identify.push(body); return send(200, {}); }
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  const { manager, state, cleanup } = setup();
  try {
    manager.apply(site({ devices: [{ id: "m", name: "M", profile: "mosaic-engine", settings: { host: "127.0.0.1", port: (engine.address() as { port: number }).port } }] }));
    const st = () => state.state.devices.m.state;
    const slots = () => (st().groupList as { slots: { slot: number; name: string; ndiName: string; playlist: string }[] }[])[0].slots;
    await until(() => Array.isArray(st().groupList) && Array.isArray(st().canvasList));
    assert.equal(st()["groups.ultrawide.arrangement"], "full");
    assert.equal(st()["groups.ultrawide.on"], true);
    assert.deepEqual((st()["groups.ultrawide.arrangements"] as { id: string }[]).map((a) => a.id), ["full", "two", "quad"]);
    assert.deepEqual(st().playlists, [{ id: "Game day", name: "Game day", videos: 2 }]);
    assert.equal(st()["background.signal"], "empty");
    assert.equal(st()["canvases.canvas-2.running"], false);
    assert.equal(st()["canvases.canvas-2.error"], "lost its GPU");

    // Each change is followed by a fresh read, so the state is right without waiting for the poll.
    await manager.execute("m", "arrange", { group: "ultrawide", arrangement: "two" });
    assert.deepEqual(requests.at(-1), { method: "POST", path: "/api/walls/ultrawide/arrange", body: { arrangement: "two", transitionMs: 500 } });
    assert.equal(st()["groups.ultrawide.arrangement"], "two");
    assert.deepEqual(slots().map((s) => [s.slot, s.name, s.ndiName]), [[1, "Left", "PC (Cam 1)"], [2, "Right", ""]]);

    await manager.execute("m", "slot_stream", { group: "ultrawide", slot: 2, ndiName: "PC (Cam 2)", transitionMs: 300 });
    assert.deepEqual(requests.at(-1), { method: "POST", path: "/api/walls/ultrawide/slots/2", body: { ndiName: "PC (Cam 2)", transitionMs: 300 } });
    assert.equal(slots()[1].ndiName, "PC (Cam 2)");
    await manager.execute("m", "slot_playlist", { group: "ultrawide", slot: 1, playlist: "Game day" });
    assert.deepEqual(slots().map((s) => [s.ndiName, s.playlist]), [["", "Game day"], ["PC (Cam 2)", ""]]);
    await manager.execute("m", "slot_empty", { group: "ultrawide", slot: 2 });
    assert.deepEqual(requests.at(-1)!.body, { transitionMs: 500 });
    assert.equal(slots()[1].ndiName, "");
    await assert.rejects(manager.execute("m", "slot_stream", { group: "ultrawide", slot: 3, ndiName: "PC (Cam 2)" }), /HTTP 400/);

    await manager.execute("m", "content", { group: "ultrawide", on: false });
    assert.deepEqual(requests.at(-1)!.body, { on: false, transitionMs: 500 });
    assert.equal(st()["groups.ultrawide.on"], false);
    await manager.execute("m", "content", { group: "ultrawide", on: true });
    assert.equal(st()["groups.ultrawide.on"], true);

    await manager.execute("m", "save_preset", { group: "ultrawide", name: "Game day split" });
    assert.deepEqual((st()["groups.ultrawide.presets"] as { id: string }[]).map((p) => p.id), ["game-day-split"]);

    await manager.execute("m", "background_playlist", { playlist: "Game day" });
    assert.deepEqual(requests.at(-1)!.body, { on: true, playlist: "Game day", transitionMs: 1000 });
    assert.deepEqual([st()["background.on"], st()["background.playlist"], st()["background.signal"]], [true, "Game day", "ok"]);
    await manager.execute("m", "background_on", { on: false });
    assert.equal(st()["background.on"], false);
    assert.equal(st()["background.playlist"], "Game day");
    await manager.execute("m", "background_stream", { ndiName: "PC (Cam 1)" });
    assert.equal(st()["background.ndiName"], "PC (Cam 1)");

    await manager.execute("m", "identify_screens", { endpoint: "wall-pc-1" });
    assert.deepEqual(identify, [{ on: true }]);
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
