import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updater } from "../../src/admin/update.ts";

test("the updater sees a newer package, downloads and checks it, and hands it to the installer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bv-update-"));
  const root = join(dir, "app");
  mkdirSync(root);
  writeFileSync(join(root, "build.json"), JSON.stringify({ built: "2026-11-01T10:00:00.000Z" }));
  const pkg = Buffer.from("pretend this is the zip");
  let latest: Record<string, unknown> = {};
  const web = createServer((req, res) => {
    if (req.url!.startsWith("/latest.json")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(latest));
    if (req.url === "/package.zip") return void res.writeHead(200).end(pkg);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
  const describe = (built: string, sha256 = createHash("sha256").update(pkg).digest("hex")) =>
    (latest = { built, package: "p.zip", url: `${base}/package.zip`, sha256, size: pkg.length });
  const installed: string[] = [];
  const updater = new Updater({ root, dataDir: join(dir, "data"), latestUrl: `${base}/latest.json`, cannot: () => undefined, install: async (zip) => void installed.push(readFileSync(zip, "utf8")) });
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      const s = await updater.status();
      if (s.phase === "installing" || s.phase === "failed") return s;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("the update never finished");
  };

  try {
    // The same build on GitHub: nothing to do.
    describe("2026-11-01T10:00:00.000Z");
    let s = await updater.status(true);
    assert.equal(s.available, false);
    assert.deepEqual(s.current, { built: "2026-11-01T10:00:00.000Z" });

    // A newer one whose download doesn't match its checksum is refused, and nothing is installed.
    describe("2026-11-19T10:00:00.000Z", "0".repeat(64));
    assert.equal((await updater.status(true)).available, true);
    await updater.start();
    s = await settle();
    assert.equal(s.phase, "failed");
    assert.match(s.error!, /doesn't match/);
    assert.deepEqual(installed, []);

    // The real one goes to the installer; a second start while it runs is refused.
    describe("2026-11-19T10:00:00.000Z");
    await updater.start();
    s = await settle();
    assert.equal(s.phase, "installing");
    assert.deepEqual(installed, ["pretend this is the zip"]);
    await assert.rejects(updater.start(), /already running/);
  } finally {
    web.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server running from source says it can't update itself", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bv-update-"));
  try {
    const updater = new Updater({ root: dir, dataDir: dir, latestUrl: "http://127.0.0.1:1/latest.json" });
    const s = await updater.status();
    assert.equal(s.current, null);
    assert.match(s.cannot!, /git pull/);
    assert.ok(s.checkError);
    await assert.rejects(updater.start(), /git pull/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
