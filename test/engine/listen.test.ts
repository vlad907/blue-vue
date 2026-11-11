import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { InterfaceListener, listNics, resolveInterfaces } from "../../src/listen.ts";

const lan = listNics()[0];

async function freePort() {
  const s = createNetServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

const reachable = (host: string, port: number) =>
  fetch(`http://${host}:${port}/hi`, { signal: AbortSignal.timeout(1500) }).then((r) => r.text(), () => "unreachable");

test("answers on every network, one network card, or none but this PC", { skip: !lan && "no network card with an IPv4 address" }, async () => {
  const app = Fastify();
  await app.register(fastifyWebsocket);
  app.get("/hi", async () => "hi");
  app.get("/ws", { websocket: true }, (socket) => socket.send("hello"));
  await app.ready();
  const port = await freePort();
  const logs: string[] = [];
  const listener = new InterfaceListener(app.server, port, (m) => logs.push(m));
  const ip = lan.addresses[0];
  try {
    await listener.apply([]);
    assert.equal(await reachable("127.0.0.1", port), "hi");
    assert.equal(await reachable(ip, port), "hi");

    // By card name: that card and this PC only.
    await listener.apply([lan.name]);
    assert.deepEqual(listener.status().listening.sort(), ["127.0.0.1", ...lan.addresses].sort());
    assert.equal(await reachable(ip, port), "hi");
    // WebSockets work through the hand-off too (panels and wall agents use them).
    const ws = new WebSocket(`ws://${ip}:${port}/ws`);
    assert.equal(await new Promise((r) => ws.addEventListener("message", (e) => r(e.data))), "hello");
    ws.close();

    // A card that isn't there: only this PC can connect, and the admin is told why.
    await listener.apply(["Ethernet 9"]);
    assert.equal(await reachable("127.0.0.1", port), "hi");
    assert.equal(await reachable(ip, port), "unreachable");
    assert.match(listener.status().problems.join(), /"Ethernet 9" isn't connected/);
    assert.deepEqual(resolveInterfaces([ip, "nope"]), { addresses: [ip], missing: ["nope"] });
  } finally {
    listener.close();
    await app.close().catch(() => {});
  }
});

test("a port taken by another program is reported, not silently ignored", async () => {
  const app = Fastify();
  await app.ready();
  const port = await freePort();
  const squatter = createNetServer();
  await new Promise<void>((r) => squatter.listen(port, "0.0.0.0", r));
  const listener = new InterfaceListener(app.server, port, () => {});
  try {
    await assert.rejects(listener.apply([]), /used by another program/);
  } finally {
    listener.close();
    squatter.close();
    await app.close().catch(() => {});
  }
});
