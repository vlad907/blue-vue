import { Socket } from "node:net";

/**
 * Expands a Global Caché sendir code into plain pulse numbers. Learned codes
 * arrive "compressed": after the first few pulses, a letter A-O stands for a
 * previously seen on/off pair (A = first unique pair, B = second, ...).
 */
export function parseSendir(line: string) {
  const m = /^sendir,[^,]+,\d+,(\d+),(\d+),(\d+),(.+)$/.exec(line.trim());
  if (!m) throw new Error(`Not a sendir code: ${line.slice(0, 60)}`);
  const freqHz = Number(m[1]);
  const offset = Number(m[3]);

  const pulses: number[] = [];
  const pairs: [number, number][] = [];
  const tokens = m[4].match(/[A-O]|\d+/g) ?? [];
  let pending: number | undefined;
  for (const t of tokens) {
    if (/[A-O]/.test(t)) {
      const pair = pairs[t.charCodeAt(0) - 65];
      if (!pair) throw new Error(`Compressed reference ${t} before it was defined`);
      pulses.push(...pair);
    } else if (pending === undefined) {
      pending = Number(t);
    } else {
      const pair: [number, number] = [pending, Number(t)];
      pending = undefined;
      pulses.push(...pair);
      if (pairs.length < 15 && !pairs.some(([a, b]) => a === pair[0] && b === pair[1])) pairs.push(pair);
    }
  }
  if (pending !== undefined) pulses.push(pending);
  if (pulses.length % 2) throw new Error("Odd number of pulses in learned code");
  return { freqHz, offset, pulses };
}

/** Converts a Global Caché sendir code to raw Pronto hex, the format stored in agent.json. */
export function sendirToPronto(line: string): string {
  const { freqHz, offset, pulses } = parseSendir(line);
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
  const onceLen = Math.min(Math.max(offset - 1, 0), pulses.length);
  return [
    "0000",
    hex(Math.round(1_000_000 / (freqHz * 0.241246))),
    hex(onceLen / 2),
    hex((pulses.length - onceLen) / 2),
    ...pulses.map(hex),
  ].join(" ");
}

/**
 * Puts an iTach into learning mode and resolves with the next code it hears.
 * Point the original remote at the iTach's learning window (on the front)
 * from a few inches away and press the button briefly.
 */
export function learnOnce(host: string, timeoutMs = 15_000, tcpPort = 4998): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    let buf = "";
    const done = (err: Error | null, code?: string) => {
      clearTimeout(timer);
      if (sock.writable) sock.write("stop_IRL\r");
      sock.end();
      err ? reject(err) : resolve(code!);
    };
    const timer = setTimeout(() => done(new Error("No IR code received (timed out)")), timeoutMs);
    sock.on("error", (err) => done(err));
    sock.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\r");
      buf = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith("sendir")) return done(null, line);
        if (/^(ERR|unknowncommand|IR Learner Unavailable)/.test(line)) return done(new Error(`iTach: ${line}`));
      }
    });
    sock.connect(tcpPort, host, () => sock.write("get_IRL\r"));
  });
}
