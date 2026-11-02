import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../../src/config.ts";
import { ensureSite } from "../../src/engine/bootstrap.ts";
import { startEngine } from "../../src/engine/index.ts";
import { GracenoteGuide } from "../../src/guide/gracenote.ts";
import { buildServer } from "../../src/server.ts";
import { StateStore } from "../../src/state.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(20);
  }
}

// What the profile editor produces for a PJLink projector: written as data, no code.
const PJLINK = {
  id: "pjlink-projector",
  name: "PJLink projector",
  category: "projector",
  transport: { type: "tcp", port: 4352, terminator: "\r", delimiter: "\r", minGapMs: 50 },
  settings: [{ key: "host", label: "IP address", type: "string", required: true }],
  commands: {
    power_on: { label: "Power on", steps: [{ send: "%1POWR 1" }] },
    power_off: { label: "Power off", steps: [{ send: "%1POWR 0" }] },
    input: {
      label: "Input",
      params: { input: { type: "enum", values: ["11", "31", "32"], labels: { "11": "VGA", "31": "HDMI 1", "32": "HDMI 2" } } },
      steps: [{ send: "%1INPT {{input}}" }],
    },
  },
  state: { power: { type: "enum", values: ["on", "off", "cooling", "warming"] } },
  feedback: [{ regex: "%1POWR=(\\d)", set: { power: "{{value | map:0=off,1=on,2=cooling,3=warming}}" } }],
  polls: [{ every: 1, steps: [{ send: "%1POWR ?" }] }],
  capabilities: { power: { on: "power_on", off: "power_off", state: "power" } },
  controls: [
    { type: "toggle", label: "Power", on: "power_on", off: "power_off", state: "power" },
    { type: "select", label: "Input", command: "input", param: "input" },
  ],
};

test("no-code check: a PJLink projector made in the profile editor is added and controlled", async () => {
  // A fake projector speaking PJLink class 1.
  const got: string[] = [];
  let power = 0;
  const projector = createTcpServer((sock) => {
    sock.write("PJLINK 0\r");
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\r")) >= 0; buf = buf.slice(i + 1)) {
        const cmd = buf.slice(0, i);
        got.push(cmd);
        if (cmd === "%1POWR ?") sock.write(`%1POWR=${power}\r`);
        else if (cmd.startsWith("%1POWR ")) { power = Number(cmd.slice(7)); sock.write("%1POWR=OK\r"); }
        else if (cmd.startsWith("%1INPT ")) sock.write("%1INPT=OK\r");
      }
    });
  });
  await new Promise<void>((r) => projector.listen(0, "127.0.0.1", r));

  const dir = mkdtempSync(join(tmpdir(), "bv-editor-"));
  const configFile = join(dir, "system.json");
  writeFileSync(configFile, "{}");
  const cfg = { ...ConfigSchema.parse({ simulate: false, dataDir: join(dir, "data"), guide: { enabled: false } }), file: configFile };
  ensureSite(cfg.dataDir, cfg.file);
  const state = new StateStore();
  const engine = startEngine(cfg.dataDir, state, false);
  const app = await buildServer({ cfg, state, engine, guide: new GracenoteGuide(cfg, state, () => []) });
  let cookie = "";
  const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown) => {
    const res = await app.inject({ method, url, payload: body as object, headers: cookie ? { cookie } : {} });
    if (res.headers["set-cookie"]) cookie = String(res.headers["set-cookie"]).split(";")[0];
    return { status: res.statusCode, json: res.body ? res.json() : undefined };
  };

  try {
    assert.equal((await call("POST", "/api/admin/profiles/validate", { profile: PJLINK })).status, 401, "editor needs a login");
    await call("POST", "/api/admin/setup", { password: "correct horse" });

    // Problems are reported while editing, before anything is saved.
    const broken = { ...PJLINK, commands: { ...PJLINK.commands, power_on: { steps: [{ ir: "KEY_POWER" }] } } };
    assert.deepEqual((await call("POST", "/api/admin/profiles/validate", { profile: broken })).json.problems, ["command power_on: a ir step can't be sent over tcp"]);

    // Preview shows exactly what a command sends; the parser tester shows what a reply becomes.
    const preview = (await call("POST", "/api/admin/profiles/preview", { profile: PJLINK, command: "input", params: { input: "31" }, settings: { host: "x" } })).json;
    assert.deepEqual(preview.sent, ['"%1INPT 31"']);
    const parsed = (await call("POST", "/api/admin/profiles/parse-test", { rules: PJLINK.feedback, sample: "%1POWR=3" })).json;
    assert.deepEqual(parsed.updates, { power: "warming" });

    // Save the profile, then add a projector using it.
    assert.equal((await call("PUT", "/api/admin/profiles/pjlink-projector", { profile: PJLINK })).status, 200);
    const { site, hash } = (await call("GET", "/api/admin/site")).json;
    const port = (projector.address() as { port: number }).port;
    site.devices.push({ id: "proj", name: "Patio projector", profile: "pjlink-projector", settings: { host: "127.0.0.1", port } });
    assert.equal((await call("PUT", "/api/admin/site", { site, baseHash: hash })).status, 200);

    await until(() => state.state.devices.proj?.online && state.state.devices.proj.state.power === "off");
    assert.equal((await call("POST", "/api/v2/devices/proj/capabilities/power/on", {})).status, 200);
    await until(() => state.state.devices.proj.state.power === "on");
    assert.equal((await call("POST", "/api/v2/devices/proj/commands/input", { params: { input: "32" } })).status, 200);
    await until(() => got.includes("%1INPT 32"));
    assert.ok(got.includes("%1POWR 1"));

    // It shows up on the touch panel with the controls from the profile.
    const ui = (await call("GET", "/api/ui")).json;
    assert.deepEqual(ui.profiles["pjlink-projector"].controls.map((c: { type: string }) => c.type), ["toggle", "select"]);

    // Editing the profile restarts the projector with the new version.
    const renamed = { ...PJLINK, commands: { ...PJLINK.commands, power_on: { label: "Lamp on", steps: [{ send: "%1POWR 1" }] } } };
    assert.equal((await call("PUT", "/api/admin/profiles/pjlink-projector", { profile: renamed })).status, 200);
    assert.equal(engine.profiles.get("pjlink-projector")!.commands.power_on.label, "Lamp on");
    await until(() => state.state.devices.proj.online);

    // Guard rails.
    assert.equal((await call("DELETE", "/api/admin/profiles/pjlink-projector")).status, 409, "in use");
    assert.equal((await call("PUT", "/api/admin/profiles/tcl-roku-tv", { profile: { ...PJLINK, id: "tcl-roku-tv" } })).status, 400, "built-ins are read-only");
    assert.equal((await call("PUT", "/api/admin/profiles/other-id", { profile: PJLINK })).status, 400, "id must match");
  } finally {
    await app.close();
    engine.stop();
    projector.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("IR learning through the admin returns a Pronto code", async () => {
  const itach = createTcpServer((sock) =>
    sock.on("data", (d) => {
      if (d.toString().includes("get_IRL")) setTimeout(() => sock.write("sendir,1:1,1,38000,1,1,341,170,21,22,21,64,BCCB21,1500\r"), 20);
    }),
  );
  await new Promise<void>((r) => itach.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "bv-learn-"));
  writeFileSync(join(dir, "system.json"), "{}");
  const cfg = { ...ConfigSchema.parse({ simulate: true, dataDir: join(dir, "data"), guide: { enabled: false } }), file: join(dir, "system.json") };
  ensureSite(cfg.dataDir, cfg.file);
  const state = new StateStore();
  const engine = startEngine(cfg.dataDir, state, true);
  const app = await buildServer({ cfg, state, engine, guide: new GracenoteGuide(cfg, state, () => []) });
  try {
    const setup = await app.inject({ method: "POST", url: "/api/admin/setup", payload: { password: "correct horse" } });
    const cookie = String(setup.headers["set-cookie"]).split(";")[0];
    const res = await app.inject({
      method: "POST", url: "/api/admin/ir/learn", headers: { cookie },
      payload: { location: "server", irHost: "127.0.0.1", irTcpPort: (itach.address() as { port: number }).port },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().pronto, "0000 006D 0000 0008 0155 00AA 0015 0016 0015 0040 0015 0016 0015 0040 0015 0040 0015 0016 0015 05DC");
  } finally {
    await app.close();
    engine.stop();
    itach.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
