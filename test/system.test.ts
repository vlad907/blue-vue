import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { ConfigSchema } from "../src/config.ts";
import { CableBoxController } from "../src/devices/cableBox.ts";
import { TvWallController } from "../src/devices/tvWall.ts";
import { AtlasTcpClient, SimulatedAtlas } from "../src/drivers/atlas.ts";
import { IrQueue, SimulatedTransmitter, sleep } from "../src/drivers/ir/transmitter.ts";
import { SimulatedVideoWall } from "../src/drivers/videoWall.ts";
import { SceneRunner } from "../src/scenes.ts";
import { StateStore } from "../src/state.ts";

const baseConfig = (overrides: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    simulate: true,
    ir: { interDigitDelayMs: 0, commandGapMs: 0 },
    emitters: { wall: { transmitters: [1] }, b1: { transmitters: [2] } },
    videoWallTvs: { remote: "tv", emitters: ["wall"], repeat: 2, staggerMs: 0 },
    cableBoxes: [{ id: "box1", name: "Box 1", remote: "xfinity", emitter: "b1" }],
    channels: [{ number: 206, name: "ESPN" }],
    atlas: { host: "127.0.0.1", zones: [{ index: 0, name: "Main" }], sources: [{ index: 0, name: "Box 1" }] },
    videoWall: { presets: [{ id: "quad", name: "Quad" }] },
    ...overrides,
  });

test("tuning sends each digit then the enter key on the box's emitter", async () => {
  const cfg = baseConfig();
  const tx = new SimulatedTransmitter();
  const state = new StateStore();
  await new CableBoxController(cfg, new IrQueue(tx, 0), state).tune("box1", 1206);
  assert.deepEqual(tx.log, ["xfinity KEY_1 @ 2", "xfinity KEY_2 @ 2", "xfinity KEY_0 @ 2", "xfinity KEY_6 @ 2", "xfinity KEY_OK @ 2"]);
  assert.equal(state.state.boxes.box1.channel, 1206);
});

test("remote keys outside the allow-list are rejected", async () => {
  const cfg = baseConfig();
  const boxes = new CableBoxController(cfg, new IrQueue(new SimulatedTransmitter(), 0), new StateStore());
  await assert.rejects(boxes.key("box1", "KEY_FACTORY_RESET"), /not allowed/);
});

test("concurrent IR commands do not interleave", async () => {
  const cfg = baseConfig();
  const tx = new SimulatedTransmitter();
  const state = new StateStore();
  const q = new IrQueue(tx, 0);
  const boxes = new CableBoxController(cfg, q, state);
  const wall = new TvWallController(cfg, q, state);
  await Promise.all([boxes.tune("box1", 25), wall.power(true)]);
  assert.deepEqual(tx.log, ["xfinity KEY_2 @ 2", "xfinity KEY_5 @ 2", "xfinity KEY_OK @ 2", "tv KEY_POWERON @ 1", "tv KEY_POWERON @ 1"]);
});

test("a failing scene step is reported and later steps still run", async () => {
  const cfg = baseConfig({
    scenes: [{ id: "s", name: "S", steps: [{ type: "zoneGain", zone: 0, db: -20 }, { type: "tune", box: "box1", channel: 206 }] }],
  });
  const state = new StateStore();
  const tx = new SimulatedTransmitter();
  const q = new IrQueue(tx, 0);
  const atlas = new SimulatedAtlas(cfg, state);
  atlas.setZoneGain = async () => { throw new Error("DSP offline"); };
  const runner = new SceneRunner(cfg, {
    boxes: new CableBoxController(cfg, q, state),
    tvWall: new TvWallController(cfg, q, state),
    atlas,
    videoWall: new SimulatedVideoWall(cfg, state),
  }, state);

  const result = await runner.run("s");
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["zoneGain: DSP offline"]);
  assert.equal(state.state.boxes.box1.channel, 206);
  assert.equal(state.state.busy, false);
});

test("Atlas client speaks newline-delimited JSON-RPC and applies pushed updates", async () => {
  const received: any[] = [];
  let push: (m: object) => void = () => {};
  const server = createServer((sock) => {
    push = (m) => sock.write(JSON.stringify(m) + "\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) received.push(JSON.parse(buf.slice(0, i)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const cfg = baseConfig({
    simulate: false,
    atlas: { host: "127.0.0.1", port, zones: [{ index: 0, name: "Main" }], sources: [], minGainDb: -80, maxGainDb: 0 },
  });
  const state = new StateStore();
  const client = new AtlasTcpClient(cfg, state);
  client.start();
  try {
    while (!state.state.atlas.connected) await sleep(10);

    await client.setZoneGain(0, 12); // clamped to max 0 dB
    push({ jsonrpc: "2.0", method: "update", params: { param: "ZoneMute_0", val: 1 } });
    await sleep(50);

    assert.deepEqual(received.filter((m) => m.method === "sub").map((m) => m.params.param), ["ZoneGain_0", "ZoneMute_0", "ZoneSource_0"]);
    const set = received.find((m) => m.method === "set");
    assert.deepEqual(set.params, { param: "ZoneGain_0", val: 0 });
    assert.equal(set.jsonrpc, "2.0");
    assert.equal(state.state.atlas.zones[0].gainDb, 0);
    assert.equal(state.state.atlas.zones[0].mute, true);
  } finally {
    client.stop();
    server.close();
  }
});
