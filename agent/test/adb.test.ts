import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdbClient, androidPublicKey, loadAdbKey, packet, parseAndroidPublicKey, Reader, resetAdbKey } from "../src/transports/adb/client.ts";
import { identityStore } from "../src/transports/androidtv/cert.ts";
import { FakeFireTv } from "./fake-adb-device.ts";
import { learnedMac, parseMac, resetMacs } from "../src/transports/adb/macs.ts";
import { AdbConnection } from "../src/transports/others.ts";

test("ADB messages split correctly from a byte stream", () => {
  const a = packet(0x4e584e43, 1, 2, "host::\0");
  const b = packet(0x59414b4f, 3, 4);
  const all = Buffer.concat([a, b]);
  const r = new Reader();
  const got = [...r.push(all.subarray(0, 10)), ...r.push(all.subarray(10, 30)), ...r.push(all.subarray(30))];
  assert.equal(got.length, 2);
  assert.equal(got[0].data.toString(), "host::\0");
  assert.deepEqual([got[1].arg0, got[1].arg1], [3, 4]);
  assert.equal(all.readUInt32LE(20), (0x4e584e43 ^ 0xffffffff) >>> 0);
});

test("public key is in Android's format and round-trips", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const text = androidPublicKey(privateKey);
  const raw = Buffer.from(text.split(" ")[0], "base64");
  assert.equal(raw.length, 524);
  assert.equal(raw.readUInt32LE(0), 64);
  const jwk = privateKey.export({ format: "jwk" }) as { n: string };
  const { n, e } = parseAndroidPublicKey(text);
  assert.equal(n.toString(16).padStart(512, "0"), Buffer.from(jwk.n, "base64url").toString("hex"));
  assert.equal(e, 65537);
  // n0inv * n[0] == -1 (mod 2^32)
  assert.equal((BigInt(raw.readUInt32LE(4)) * (n % (1n << 32n))) % (1n << 32n), (1n << 32n) - 1n);
});

test("first connection waits for Allow on the TV, later ones go straight in", async () => {
  identityStore.dir = mkdtempSync(join(tmpdir(), "adb-"));
  resetAdbKey();
  const tv = await new FakeFireTv().start();
  try {
    tv.allow = "wait";
    const c = new AdbClient("127.0.0.1", tv.port);
    let asked = 0;
    c.on("approval", () => asked++);
    await assert.rejects(c.connect(400), /Allow debugging/);
    assert.equal(c.state, "awaiting-approval");
    assert.equal(asked, 1);
    c.close();

    tv.allow = "yes";
    const c2 = new AdbClient("127.0.0.1", tv.port);
    await c2.connect();
    assert.match(c2.banner, /ro.product.model=AFTKRT/);
    assert.equal(await c2.shell("echo model=$(getprop ro.product.model)"), "model=AFTKRT\n");
    c2.close();
    assert.deepEqual(readdirSync(identityStore.dir), ["adbkey.pem"]);

    // The key is remembered: no second prompt.
    const prompts = tv.prompts;
    const c3 = new AdbClient("127.0.0.1", tv.port);
    await c3.shell("input keyevent KEYCODE_WAKEUP");
    assert.equal(tv.awake, true);
    assert.equal(tv.prompts, prompts);
    c3.close();
    assert.ok(loadAdbKey());
  } finally {
    tv.stop();
  }
});

test("a TV with debugging off or a turned-down prompt gives a clear error", async () => {
  identityStore.dir = mkdtempSync(join(tmpdir(), "adb-"));
  resetAdbKey();
  const tv = await new FakeFireTv().start();
  tv.allow = "no";
  try {
    await assert.rejects(new AdbClient("127.0.0.1", tv.port).connect(), /turned down/);
  } finally {
    tv.stop();
  }
  await assert.rejects(new AdbClient("127.0.0.1", tv.port).connect(), /Network debugging|ADB debugging/);
});

test("picks the MAC of the network port that's up, Ethernet first", () => {
  assert.equal(parseMac("eth0 up A0:D0:DC:12:34:56\nwlan0 up 11:22:33:44:55:66\n"), "a0:d0:dc:12:34:56");
  assert.equal(parseMac("eth0 down a0:d0:dc:12:34:56\nwlan0 up 11:22:33:44:55:66\n"), "11:22:33:44:55:66");
  assert.equal(parseMac("eth0 up 00:00:00:00:00:00\nwlan0\n"), undefined);
  assert.equal(parseMac(""), undefined);
});

test("a Fire TV's MAC is learned while it's awake, and wake-on-LAN goes first when it stops answering", async () => {
  identityStore.dir = mkdtempSync(join(tmpdir(), "adb-"));
  resetAdbKey();
  resetMacs();
  const tv = await new FakeFireTv().start();
  tv.allow = "yes";
  const conn = new AdbConnection({ type: "adb" }, { host: "127.0.0.1", port: tv.port });
  const logs: string[] = [];
  conn.on("log", (_d: string, t: string) => logs.push(t));
  try {
    conn.open();
    for (let i = 0; i < 50 && !learnedMac("127.0.0.1"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(learnedMac("127.0.0.1"), "a0:d0:dc:12:34:56");
    // Kept on disk, for wake-on-LAN after a restart.
    resetMacs();
    assert.equal(learnedMac("127.0.0.1"), "a0:d0:dc:12:34:56");

    // Online: no magic packet.
    await conn.send({ kind: "adb", args: ["input", "keyevent", "KEYCODE_WAKEUP"] });
    assert.ok(!logs.some((l) => l.startsWith("wake-on-LAN")));
  } finally {
    conn.close();
    tv.stop();
  }
  // The TV has gone quiet: the wake key is preceded by a magic packet (and still fails to connect).
  await assert.rejects(conn.send({ kind: "adb", args: ["input", "keyevent", "KEYCODE_WAKEUP"] }));
  assert.ok(logs.some((l) => l === "wake-on-LAN to a0:d0:dc:12:34:56"), logs.join("\n"));
  // Other keys don't send one.
  logs.length = 0;
  await assert.rejects(conn.send({ kind: "adb", args: ["input", "keyevent", "KEYCODE_SLEEP"] }));
  assert.ok(!logs.some((l) => l.startsWith("wake-on-LAN")));
});
