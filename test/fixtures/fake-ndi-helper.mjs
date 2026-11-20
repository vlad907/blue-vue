// Stands in for bluevue_ndi.py in tests: same JSON-lines protocol, one pretend stream.
import { createInterface } from "node:readline";

const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 0xff, 0xd9]).toString("base64");
const asked = new Map();
out({ event: "ready" });
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.op === "sources") return out({ id: m.id, sources: ["ZOWIEBOX (Bar & grill)"] });
  if (m.name !== "ZOWIEBOX (Bar & grill)") return out({ id: m.id, error: "This stream isn't on the network right now" });
  const n = (asked.get(m.name) ?? 0) + 1;
  asked.set(m.name, n);
  // The first ask starts receiving; the picture is there from the second.
  out(n === 1 ? { id: m.id, waiting: true } : { id: m.id, jpeg, signal: "ok" });
});
