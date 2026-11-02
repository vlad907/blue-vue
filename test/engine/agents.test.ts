import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { AgentLink } from "../../agent/src/link.ts";
import { AgentHub } from "../../src/engine/agents.ts";
import { DeviceManager } from "../../src/engine/device-manager.ts";
import { defaultFactory } from "../../src/engine/device-runtime.ts";
import { BUILTIN_PROFILES } from "../../src/engine/index.ts";
import { ProfileLibrary } from "../../src/engine/profiles.ts";
import { SiteSchema } from "../../src/engine/site.ts";
import { StateStore } from "../../src/state.ts";

const TOKEN = "wall1-token-0123456789";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(10);
  }
}

test("a device behind a wall agent works through the agent link, and survives the agent reconnecting", async () => {
  // A TCP device on the wall's network.
  const lines: string[] = [];
  const raw: Buffer[] = [];
  let deviceSock: Socket | undefined;
  const device = createTcpServer((sock) => {
    deviceSock = sock;
    let buf = "";
    sock.on("data", (d) => {
      raw.push(d);
      buf += d.toString("latin1");
      for (let i; (i = buf.indexOf("\r")) >= 0; buf = buf.slice(i + 1)) {
        const line = buf.slice(0, i);
        lines.push(line);
        const m = /^PING (\d+)$/.exec(line);
        if (m) sock.write(`PONG ${m[1]}\r`);
      }
    });
  });
  await new Promise<void>((r) => device.listen(0, "127.0.0.1", r));

  // Control server side: profile library, hub, devices, and the /agent socket.
  const custom = mkdtempSync(join(tmpdir(), "bv-agents-"));
  const lib = new ProfileLibrary(BUILTIN_PROFILES, custom).load();
  assert.deepEqual(lib.saveCustom({
    id: "test-pinger", name: "Pinger", transport: { type: "tcp", terminator: "\r", delimiter: "\r", minGapMs: 0 },
    settings: [{ key: "host", label: "Host", type: "string", required: true }],
    onConnect: [{ send: "HELLO" }],
    commands: {
      ping: { params: { n: { type: "integer" } }, steps: [{ send: "PING {{n}}" }] },
      raw: { steps: [{ hex: "AA 01 FF" }] },
    },
    state: { pong: { type: "number" } },
    feedback: [{ regex: "^PONG (\\d+)$", set: { pong: "{{value}}" } }],
  }), []);

  const site = SiteSchema.parse({
    agents: [{ id: "wall1", name: "Wall 1", token: TOKEN }],
    devices: [{ id: "dev", name: "Device", profile: "test-pinger", location: "wall1", settings: { host: "127.0.0.1", port: (device.address() as { port: number }).port } }],
  });
  const state = new StateStore();
  const hub = new AgentHub(() => site.agents, state);
  const manager = new DeviceManager(lib, state, {
    simulate: false,
    factory: defaultFactory(false, (agent, profile, settings) => hub.connection(agent, profile.transport, settings)),
  });
  manager.apply(site);

  const app = Fastify();
  await app.register(fastifyWebsocket);
  app.get("/agent", { websocket: true }, (socket) => hub.accept(socket));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/agent`;

  const restarts: string[] = [];
  const apps = { list: () => [{ name: "Mosaic", running: true, autoRestart: true }], restart: async (n: string) => void restarts.push(n) };
  const makeLink = (id = "wall1", token = TOKEN) => new AgentLink({ url, id, token, version: "test", simulate: false, apps, log: () => {} });

  let link = makeLink();
  const intruder = makeLink("intruder", "x".repeat(20));
  try {
    // Before the agent connects, the device waits offline.
    await sleep(100);
    assert.equal(state.state.devices.dev.online, false);

    link.start();
    await until(() => state.state.devices.dev.online);
    await until(() => lines.includes("HELLO"));
    assert.equal(state.state.agents.wall1.online, true);
    assert.deepEqual(state.state.agents.wall1.apps.map((a) => a.name), ["Mosaic"]);

    await manager.execute("dev", "ping", { n: 7 });
    await until(() => state.state.devices.dev.state.pong === 7);
    await manager.execute("dev", "raw");
    await until(() => raw.some((b) => b.includes(Buffer.from([0xaa, 0x01, 0xff]))));

    await hub.restartApp("wall1", "Mosaic");
    assert.deepEqual(restarts, ["Mosaic"]);

    // Unknown agents are turned away and recorded for pairing.
    intruder.start();
    await until(() => state.state.agents.intruder?.error === "not paired");
    assert.equal(state.state.agents.intruder.paired, false);

    // Agent goes away: device offline, commands fail clearly, device connection closed.
    link.stop();
    await until(() => !state.state.devices.dev.online && !state.state.agents.wall1.online);
    await assert.rejects(manager.execute("dev", "ping", { n: 1 }), /wall agent "wall1" is offline/);
    await until(() => deviceSock?.destroyed === true);

    // Agent comes back: the hub re-opens the connection and onConnect runs again.
    const hellos = lines.filter((l) => l === "HELLO").length;
    link = makeLink();
    link.start();
    await until(() => state.state.devices.dev.online);
    await until(() => lines.filter((l) => l === "HELLO").length === hellos + 1);
    await manager.execute("dev", "ping", { n: 9 });
    await until(() => state.state.devices.dev.state.pong === 9);
  } finally {
    link.stop();
    intruder.stop();
    manager.stopAll();
    hub.close();
    await app.close();
    device.close();
    rmSync(custom, { recursive: true, force: true });
  }
});
