import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { parsePronto } from "../src/ir.ts";
import { readDeviceInfo } from "../src/discover.ts";
import { learnOnce, parseSendir, sendirToPronto } from "../src/learn.ts";

test("expands Global Caché compressed codes (A-O reference earlier pairs)", () => {
  // Pairs: 341,170 = A; 21,22 = B; 21,64 = C
  const { pulses, freqHz, offset } = parseSendir("sendir,1:1,1,38000,1,1,341,170,21,22,21,64,BCCB21,1500");
  assert.equal(freqHz, 38000);
  assert.equal(offset, 1);
  assert.deepEqual(pulses, [341, 170, 21, 22, 21, 64, 21, 22, 21, 64, 21, 64, 21, 22, 21, 1500]);
});

test("learned sendir converts to Pronto that round-trips through the IR sender", () => {
  const pronto = sendirToPronto("sendir,1:1,7,38000,1,1,341,170,21,22,21,64,BCCB21,1500");
  assert.equal(pronto, "0000 006D 0000 0008 0155 00AA 0015 0016 0015 0040 0015 0016 0015 0040 0015 0040 0015 0016 0015 05DC");
  const parsed = parsePronto(pronto);
  assert.equal(parsed.pulses.length, 16);
  assert.ok(Math.abs(parsed.freqHz - 38000) < 100);
});

test("a sendir offset splits the once and repeat parts", () => {
  const pronto = sendirToPronto("sendir,1:1,1,40000,1,5,10,20,30,40,50,60");
  assert.deepEqual(pronto.split(" ").slice(2, 4), ["0002", "0001"]);
});

test("learnOnce enables the iTach learner and returns the first code", async () => {
  const seen: string[] = [];
  const itach = createTcpServer((sock) =>
    sock.on("data", (d) => {
      seen.push(...d.toString().split("\r").filter(Boolean));
      if (d.toString().includes("get_IRL")) {
        sock.write("IR Learner Enabled\r");
        setTimeout(() => sock.write("sendir,1:1,1,38000,1,1,341,170,21,1500\r"), 20);
      }
    }),
  );
  await new Promise<void>((r) => itach.listen(0, "127.0.0.1", r));
  try {
    const code = await learnOnce("127.0.0.1", 2000, (itach.address() as { port: number }).port);
    assert.equal(code, "sendir,1:1,1,38000,1,1,341,170,21,1500");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, ["get_IRL", "stop_IRL"]);
  } finally {
    itach.close();
  }
});

test("reads Roku device-info including the network type", async () => {
  const tv = createHttpServer((_req, res) =>
    res.end("<device-info><model-name>TCL 55S455</model-name><user-device-name>Bar TL</user-device-name><power-mode>PowerOn</power-mode><network-type>wifi</network-type><is-tv>true</is-tv></device-info>"),
  );
  await new Promise<void>((r) => tv.listen(8060, "127.0.0.1", r));
  try {
    const d = await readDeviceInfo("127.0.0.1");
    assert.deepEqual(d, { host: "127.0.0.1", name: "Bar TL", model: "TCL 55S455", serial: undefined, power: "PowerOn", network: "wifi", isTv: true });
  } finally {
    tv.close();
  }
});
