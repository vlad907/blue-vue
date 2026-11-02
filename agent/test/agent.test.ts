import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { createAgent } from "../src/agent.ts";
import { AppWatcher, SimulatedProcessControl } from "../src/apps.ts";
import type { AgentConfig } from "../src/config.ts";
import { GlobalCacheTransmitter, parsePronto } from "../src/ir.ts";

const PRONTO = "0000 006D 0002 0001 0010 0020 0030 0040 0050 0060";

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "wall-test", port: 0, token: "test-token-0123456789", simulate: true, pollSeconds: 3600,
  ir: { driver: "simulated" },
  codes: {},
  apps: [],
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
  try {
    await new GlobalCacheTransmitter("127.0.0.1", 1, port).send(3, parsePronto(PRONTO), 2);
  } finally {
    gc.close();
  }
  assert.match(received, /^sendir,1:3,\d+,38029,2,5,16,32,48,64,80,96\r$/);
});

test("health endpoint answers locally and reports the link state", async () => {
  const agent = createAgent(config());
  const port = await agent.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.deepEqual(await res.json(), { ok: true, name: "wall-test", version: "0.2.0", connected: false });
    assert.equal((await fetch(`http://127.0.0.1:${port}/panels/power`, { method: "POST" })).status, 404);
  } finally {
    agent.stop();
  }
});

test("app watcher restarts stopped software, but not more than once per gap", async () => {
  const cfg = config({ apps: [{ name: "Mosaic", process: "Mosaic.exe", task: "BlueVueMosaic", autoRestart: true }] });
  const proc = new SimulatedProcessControl(cfg.apps);
  const starts: string[] = [];
  const realStart = proc.start.bind(proc);
  proc.start = async (task: string) => { starts.push(task); await realStart(task); };
  const watcher = new AppWatcher(cfg, proc);

  await watcher.check();
  assert.deepEqual(starts, []);
  assert.equal(watcher.list()[0].running, true);

  proc.running.clear(); // the app crashed
  await watcher.check();
  assert.deepEqual(starts, ["BlueVueMosaic"]);

  proc.running.clear(); // crashed again right away: wait out the gap
  await watcher.check();
  assert.deepEqual(starts, ["BlueVueMosaic"]);
  assert.equal(watcher.list()[0].running, false);

  watcher.minRestartGapMs = 0;
  await watcher.check();
  assert.deepEqual(starts, ["BlueVueMosaic", "BlueVueMosaic"]);
});
