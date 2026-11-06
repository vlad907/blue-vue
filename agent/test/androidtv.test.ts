import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { identityStore, resetIdentity } from "../src/transports/androidtv/cert.ts";
import { keyCode } from "../src/transports/androidtv/keycodes.ts";
import { Deframer, decode, encode, frame, msg, num } from "../src/transports/androidtv/protobuf.ts";
import { AndroidTvConnection, finishPairing, startPairing } from "../src/transports/androidtv/remote.ts";
import { FakeTv } from "./fake-android-tv.ts";

const until = async (ok: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("protobuf round trip, varints and framing", () => {
  const body = encode([[1, 622], [2, "hi"], [3, true], [4, -1], [5, undefined]]);
  const f = decode(body);
  assert.equal(num(f, 1), 622);
  assert.equal(f.get(2)![0].toString(), "hi");
  assert.equal(num(f, 3), 1);
  assert.equal(num(f, 4), -1);
  assert.equal(f.has(5), false);
  const big = Buffer.alloc(300, 1);
  const framed = Buffer.concat([frame(big), frame(body)]);
  const d = new Deframer();
  // Split mid-length-prefix to check partial reads.
  const parts = [...d.push(framed.subarray(0, 1)), ...d.push(framed.subarray(1, 200)), ...d.push(framed.subarray(200))];
  assert.equal(parts.length, 2);
  assert.equal(parts[0].length, 300);
  assert.deepEqual(parts[1], body);
});

test("key names resolve to Android key codes", () => {
  assert.equal(keyCode("HOME"), 3);
  assert.equal(keyCode("KEYCODE_POWER"), 26);
  assert.equal(keyCode("tv_input_hdmi_1"), 243);
  assert.equal(keyCode("5"), 12); // the digit key, not key code 5
  assert.equal(keyCode("177"), 177);
  assert.equal(keyCode(224), 224);
  assert.throws(() => keyCode("HDMI_9"), /Unknown key/);
});

test("pairs with a TV, then controls it with discrete power", async () => {
  identityStore.dir = mkdtempSync(join(tmpdir(), "atv-"));
  resetIdentity();
  const tv = new FakeTv();
  await tv.start();
  const conn = new AndroidTvConnection({ type: "androidtv" }, { host: "127.0.0.1", port: tv.remotePort });
  const data: Record<string, unknown>[] = [];
  const logs: string[] = [];
  conn.on("data", (m: string) => data.push(JSON.parse(m)));
  conn.on("log", (dir: string, text: string) => logs.push(`${dir} ${text}`));
  try {
    // Not paired yet: the TV drops the connection and nothing gets sent.
    conn.open();
    await until(() => logs.some((l) => l.startsWith("info disconnected")));
    assert.equal(conn.online, false);
    await assert.rejects(conn.send({ kind: "androidtv", key: "HOME" }), /No remote session/);

    await startPairing("127.0.0.1", tv.pairingPort);
    assert.match(tv.code, /^[0-9A-F]{6}$/);
    const wrong = tv.code.slice(0, 2) + (tv.code.slice(2) === "0000" ? "0001" : "0000");
    await assert.rejects(finishPairing("127.0.0.1", wrong), /doesn't match|wrong code/);
    await finishPairing("127.0.0.1", tv.code.toLowerCase());
    assert.equal(tv.paired.size, 1);

    // Pairing makes the connection retry at once rather than after its backoff.
    await until(() => conn.online && conn.power !== undefined);
    assert.equal(conn.power, false);
    assert.ok(data.some((d) => d.model === "98QM7L" && d.vendor === "TCL"));
    await until(() => tv.pongs.includes(7));

    // On: the TV reported off, so POWER is pressed and the TV's report confirms it.
    assert.deepEqual(JSON.parse((await conn.send({ kind: "androidtv", power: "on" }))!), { power: true, result: "on, reported by the TV" });
    assert.deepEqual(tv.keys, [26]);
    // On again: already on, so nothing is pressed (POWER would turn it off).
    assert.equal(JSON.parse((await conn.send({ kind: "androidtv", power: "on" }))!).result, "already on");
    assert.deepEqual(tv.keys, [26]);
    await conn.send({ kind: "androidtv", power: "off" });
    assert.equal(tv.power, false);

    await conn.send({ kind: "androidtv", key: "TV_INPUT_HDMI_2" });
    await conn.send({ kind: "androidtv", appLink: "https://www.youtube.com" });
    await until(() => tv.keys.length === 3 && tv.links.length === 1);
    assert.deepEqual(tv.keys, [26, 26, 244]);

    // A dropped session comes back by itself.
    for (const c of tv.clients) c.destroy();
    await until(() => !conn.online);
    await until(() => conn.online, 6000);
  } finally {
    conn.close();
    tv.stop();
  }
});

test("refuses to toggle when the TV never reported its power", async () => {
  identityStore.dir = mkdtempSync(join(tmpdir(), "atv-"));
  resetIdentity();
  const tv = new FakeTv();
  await tv.start();
  await startPairing("127.0.0.1", tv.pairingPort);
  await finishPairing("127.0.0.1", tv.code);
  // This TV configures the session but never says whether it's on.
  tv.remote.removeAllListeners("secureConnection");
  tv.remote.on("secureConnection", (s: TLSSocket) => {
    s.on("error", () => {});
    tv.clients.add(s);
    const d = new Deframer();
    s.write(frame(encode([[1, encode([[1, 622]])]])));
    s.on("data", (chunk) => {
      for (const raw of d.push(chunk)) if (msg(decode(raw), 1)) s.write(frame(encode([[2, Buffer.alloc(0)]])));
    });
  });
  const conn = new AndroidTvConnection({ type: "androidtv" }, { host: "127.0.0.1", port: tv.remotePort });
  try {
    conn.open();
    await until(() => conn.online);
    await assert.rejects(conn.send({ kind: "androidtv", power: "off" }), /hasn't reported whether it's on/);
    assert.deepEqual(tv.keys, []);
  } finally {
    conn.close();
    tv.stop();
  }
});
