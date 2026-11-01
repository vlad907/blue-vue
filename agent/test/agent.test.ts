import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { createAgent } from "../src/agent.ts";
import type { AgentConfig } from "../src/config.ts";
import { GlobalCacheTransmitter, IrService, SimulatedTransmitter, parsePronto } from "../src/ir.ts";
import { PanelManager, RokuPanel } from "../src/panels.ts";

const PRONTO = "0000 006D 0002 0001 0010 0020 0030 0040 0050 0060";
const TOKEN = "test-token-0123456789";

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "wall-test", port: 0, token: TOKEN, simulate: false, staggerMs: 0, pollSeconds: 3600,
  ir: { driver: "simulated" },
  codes: { tcl: { KEY_POWERON: PRONTO, KEY_POWEROFF: PRONTO }, xfinity: { KEY_5: PRONTO } },
  panels: [],
  ...overrides,
});

test("parses raw Pronto into carrier frequency and cycle counts", () => {
  const code = parsePronto(PRONTO);
  assert.equal(code.freqHz, 38029);
  assert.deepEqual(code.pulses, [0x10, 0x20, 0x30, 0x40, 0x50, 0x60]);
  assert.equal(code.repeatStart, 4);
  assert.throws(() => parsePronto("0000 006D 0002 0001 0010"), /length mismatch/);
});

test("Global Caché transmitter sends sendir and waits for completeir", async () => {
  let received = "";
  const gc = createTcpServer((sock) =>
    sock.on("data", (d) => {
      received += d;
      const id = received.split(",")[2];
      sock.write(`completeir,1:3,${id}\r`);
    }),
  );
  await new Promise<void>((r) => gc.listen(0, "127.0.0.1", r));
  const port = (gc.address() as { port: number }).port;

  const tx = new GlobalCacheTransmitter("127.0.0.1", 1, port);
  try {
    await tx.send(3, parsePronto(PRONTO), 2);
  } finally {
    gc.close();
  }
  assert.match(received, /^sendir,1:3,\d+,38029,2,5,16,32,48,64,80,96\r$/);
});

test("IR panels sharing a port get one burst per wall power command", async () => {
  const tx = new SimulatedTransmitter();
  const cfg = config({
    panels: [
      { id: "a", name: "A", driver: "ir", port: 1, remote: "tcl" },
      { id: "b", name: "B", driver: "ir", port: 1, remote: "tcl" },
      { id: "c", name: "C", driver: "ir", port: 2, remote: "tcl" },
    ],
  });
  const mgr = new PanelManager(cfg, new IrService(tx, cfg.codes));
  const errors = await mgr.power(true);
  assert.deepEqual(errors, {});
  assert.deepEqual(tx.sent, ["port 1: tcl KEY_POWERON", "port 2: tcl KEY_POWERON"]);
  assert.deepEqual(mgr.list().map((p) => [p.id, p.power, p.confirmed]), [["a", "on", false], ["b", "on", false], ["c", "on", false]]);
});

test("Roku driver uses discrete ECP keypresses and reads power-mode", async () => {
  const hits: string[] = [];
  let mode = "DisplayOff";
  const tv = createHttpServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/keypress/PowerOn") mode = "PowerOn";
    res.end(req.url === "/query/device-info" ? `<device-info><power-mode>${mode}</power-mode></device-info>` : "");
  });
  await new Promise<void>((r) => tv.listen(0, "127.0.0.1", r));
  const panel = new RokuPanel("127.0.0.1");
  panel.base = `http://127.0.0.1:${(tv.address() as { port: number }).port}`;
  try {
    assert.equal(await panel.query(), "off");
    await panel.power(true);
    await panel.input("hdmi2");
    assert.equal(await panel.query(), "on");
  } finally {
    tv.close();
  }
  assert.deepEqual(hits, ["GET /query/device-info", "POST /keypress/PowerOn", "POST /keypress/InputHDMI2", "GET /query/device-info"]);
});

test("HTTP API requires the token and drives panels and IR", async () => {
  const agent = createAgent(config({
    simulate: true,
    panels: [{ id: "p1", name: "P1", driver: "simulated" }, { id: "p2", name: "P2", driver: "simulated" }],
  }));
  const port = await agent.start(0);
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await fetch(`${base}/status`, { headers: { authorization: "Bearer wrong" } })).status, 401);

    const power = await fetch(`${base}/panels/power`, { method: "POST", headers: auth, body: JSON.stringify({ on: true, panels: ["p2"] }) });
    assert.deepEqual(await power.json(), { ok: true, errors: {} });

    const status = await (await fetch(`${base}/status`, { headers: auth })).json();
    assert.deepEqual(status.panels.map((p: any) => [p.id, p.power]), [["p1", "off"], ["p2", "on"]]);

    const ir = await fetch(`${base}/ir/send`, { method: "POST", headers: auth, body: JSON.stringify({ port: 2, remote: "xfinity", key: "KEY_5" }) });
    assert.equal(ir.status, 200);
    assert.deepEqual((agent.ir.tx as SimulatedTransmitter).sent, ["port 2: xfinity KEY_5"]);

    const bad = await fetch(`${base}/panels/power`, { method: "POST", headers: auth, body: JSON.stringify({ on: true, panels: ["nope"] }) });
    assert.equal(bad.status, 400);
  } finally {
    agent.stop();
  }
});
