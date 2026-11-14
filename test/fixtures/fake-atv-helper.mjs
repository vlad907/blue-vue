// Stands in for bluevue_atv.py in tests: same JSON-lines protocol, one pretend Apple TV per host.
import { createInterface } from "node:readline";

const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const tvs = new Map(); // host -> { open, paired, power }
const tv = (host) => tvs.get(host) ?? tvs.set(host, { open: false, paired: host.endsWith(".99") ? 0 : 2, power: false, pairing: 0 }).get(host);
const report = (host) => {
  const t = tv(host);
  if (!t.open) return;
  if (t.paired === 0) {
    out({ event: "data", host, data: { paired: false, name: "Bar Apple TV" } });
    return out({ event: "log", host, level: "error", text: "not paired yet: pair it from the admin's TV pairing page" });
  }
  out({ event: "data", host, data: { paired: true, name: "Bar Apple TV", model: "Apple TV 4K", os: "tvOS 26.1" } });
  out({ event: "data", host, data: { power: t.power } });
  out({ event: "data", host, data: { apps: [{ id: "com.netflix.Netflix", name: "Netflix" }, { id: "com.espn.ScoreCenter", name: "ESPN" }] } });
  out({ event: "status", host, online: true });
};

out({ event: "ready", pyatv: "fake" });
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  const reply = (extra = {}) => out({ id: m.id, ok: true, ...extra });
  const fail = (error) => out({ id: m.id, error });
  const t = m.host ? tv(m.host) : undefined;
  if (m.op === "open") { t.open = true; reply(); return report(m.host); }
  if (m.op === "close") { t.open = false; return reply(); }
  if (m.op === "scan") return reply({ found: [{ host: "192.168.5.40", name: "Bar Apple TV", model: "Apple TV 4K", mac: "AA:BB:CC:00:00:01" }], asked: m.hosts?.length ?? 0 });
  if (m.op === "pair") {
    if (m.step === "start") { t.pairing = t.paired + 1; return reply({ done: false }); }
    if (m.step === "cancel") { t.pairing = 0; return reply(); }
    if (!t.pairing) return fail("No pairing in progress for this Apple TV (or it timed out). Start pairing again.");
    if (m.code !== (t.pairing === 1 ? "1111" : "2222")) { t.pairing = 0; return fail("That code doesn't match the one on the Apple TV. Start pairing again."); }
    t.paired = t.pairing;
    if (t.paired === 1) { t.pairing = 2; return reply({ done: false, more: true, message: "The Apple TV now shows a second code. Type that one in too." }); }
    t.pairing = 0;
    reply({ done: true });
    return report(m.host);
  }
  if (m.op === "send") {
    if (!t.open || t.paired === 0) return fail(`No connection to the Apple TV at ${m.host}. Check it's on the network and paired.`);
    if (m.power) {
      const on = m.power === "on";
      if (t.power === on) return reply({ power: on, result: `already ${m.power}` });
      t.power = on;
      out({ event: "data", host: m.host, data: { power: on } });
      return reply({ power: on, result: `${m.power}, reported by the Apple TV` });
    }
    if (m.app) { out({ event: "data", host: m.host, data: { app: m.app === "com.netflix.Netflix" ? "Netflix" : m.app, appId: m.app, title: "", playback: "idle" } }); return reply(); }
    if (m.key === "crash") process.exit(1);
    if (!["up", "down", "select", "menu", "home", "play_pause"].includes(m.key)) return fail(`Unknown Apple TV key "${m.key}"`);
    out({ event: "log", host: m.host, level: "info", text: `pressed ${m.key}` });
    return reply();
  }
  fail(`Unknown request "${m.op}"`);
});
