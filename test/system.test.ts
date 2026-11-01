import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { ConfigSchema } from "../src/config.ts";
import { CableBoxController } from "../src/devices/cableBox.ts";
import { TvWallController } from "../src/devices/tvWall.ts";
import { AtlasTcpClient, SimulatedAtlas } from "../src/drivers/atlas.ts";
import { EndpointManager, SimulatedEndpoint } from "../src/drivers/endpoints.ts";
import { IrQueue, RoutingTransmitter, SimulatedTransmitter, sleep } from "../src/drivers/ir/transmitter.ts";
import { SimulatedVideoWall } from "../src/drivers/videoWall.ts";
import { SceneRunner } from "../src/scenes.ts";
import { StateStore } from "../src/state.ts";

const baseConfig = (overrides: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    simulate: true,
    ir: { interDigitDelayMs: 0, commandGapMs: 0 },
    endpoints: [
      { id: "wall1", name: "Wall 1", url: "http://10.0.0.1:8090" },
      { id: "wall2", name: "Wall 2", url: "http://10.0.0.2:8090" },
    ],
    emitters: { b1: { transmitters: [2] }, b2: { endpoint: "wall2", port: 3 } },
    cableBoxes: [
      { id: "box1", name: "Box 1", remote: "xfinity", emitter: "b1" },
      { id: "box2", name: "Box 2", remote: "xfinity", emitter: "b2" },
    ],
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

test("concurrent tunes do not interleave and endpoint emitters route to the wall agent", async () => {
  const cfg = baseConfig();
  const state = new StateStore();
  const endpoints = new EndpointManager(cfg, state);
  const order: string[] = [];
  (endpoints.get("wall2") as SimulatedEndpoint).irSend = async (port, _remote, key) => void order.push(`wall2:${port} ${key}`);
  const local = { send: async (_e: unknown, _remote: string, key: string) => void order.push(`local ${key}`) };
  const boxes = new CableBoxController(cfg, new IrQueue(new RoutingTransmitter(local, endpoints), 0), state);

  await Promise.all([boxes.tune("box1", 25), boxes.tune("box2", 7)]);
  assert.deepEqual(order, ["local KEY_2", "local KEY_5", "local KEY_OK", "wall2:3 KEY_7", "wall2:3 KEY_OK"]);
});

test("wall power targets one wall or all walls and reports panel state", async () => {
  const cfg = baseConfig();
  const state = new StateStore();
  const endpoints = new EndpointManager(cfg, state);
  const walls = new TvWallController(endpoints);

  await walls.power(true, "wall1");
  assert.ok(state.state.walls.wall1.panels.every((p) => p.power === "on"));
  assert.equal(state.state.walls.wall1.online, true);
  assert.equal(state.state.walls.wall2.panels.length, 0); // not polled yet

  await walls.power(true, undefined, ["r1c1"]);
  assert.deepEqual(state.state.walls.wall2.panels.filter((p) => p.power === "on").map((p) => p.id), ["r1c1"]);

  await assert.rejects(walls.power(true, "nope"), /Unknown wall endpoint/);
});

test("an offline wall is reported without blocking the other walls", async () => {
  const cfg = baseConfig();
  const state = new StateStore();
  const endpoints = new EndpointManager(cfg, state);
  const wall2 = endpoints.get("wall2") as SimulatedEndpoint;
  wall2.power = async () => { throw new Error("connect ECONNREFUSED"); };
  wall2.status = async () => { throw new Error("connect ECONNREFUSED"); };

  await assert.rejects(new TvWallController(endpoints).power(true), /wall2: connect ECONNREFUSED/);
  assert.ok(state.state.walls.wall1.panels.every((p) => p.power === "on"));
  assert.equal(state.state.walls.wall2.online, false);
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
    tvWall: new TvWallController(new EndpointManager(cfg, state)),
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
