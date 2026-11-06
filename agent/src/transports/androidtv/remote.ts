import { createHash, X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import { connect, type TLSSocket } from "node:tls";
import { WolConnection } from "../others.ts";
import { Connection, type ConnectionSettings, type RenderedPayload, type TransportConfig, requireSetting } from "../types.ts";
import { loadIdentity, publicKeyOf, rsaNumbers } from "./cert.ts";
import { keyCode, keyName } from "./keycodes.ts";
import { Deframer, type Fields, decode, encode, frame, msg, num, str } from "./protobuf.ts";

// Android TV Remote protocol v2, the one the Google TV phone app uses.
// Port 6467 pairs once (the TV shows a code); port 6466 then takes key
// presses over TLS with the paired client certificate and reports power,
// the current app and volume. Field numbers follow the protocol's .proto
// files (polo.proto for pairing, remotemessage.proto for control).

export const REMOTE_PORT = 6466;
export const PAIRING_PORT = 6467;
const CLIENT_NAME = "Blue Vue";

// Feature bits sent in RemoteConfigure: ping, key, IME, power, volume, app links.
const FEATURES = 622;
const SHORT_PRESS = 3;

/** Fires "paired" with the host, so connections retry right away instead of waiting out their backoff. */
export const pairingEvents = new EventEmitter();

/**
 * Persistent control connection to one TV. It reconnects on its own, answers
 * the TV's pings, and turns the TV's reports into JSON messages ("data") that
 * the profile's feedback rules read: {"power":true}, {"app":"..."}, ...
 */
export class AndroidTvConnection extends Connection {
  host: string;
  port: number;
  mac?: string;
  /** What the TV last said about its power; undefined until it reports. */
  power: boolean | undefined;
  private socket?: TLSSocket;
  private stopped = true;
  private backoffMs = 2000;
  private timer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private onPaired = (host: string) => {
    if (host === this.host && !this.online && !this.stopped) this.reconnectNow();
  };

  constructor(cfg: TransportConfig, settings: ConnectionSettings) {
    super();
    this.host = requireSetting(settings.host, "host");
    this.port = Number(settings.port ?? cfg.port ?? REMOTE_PORT);
    this.mac = typeof settings.mac === "string" && settings.mac ? settings.mac : undefined;
  }

  open() {
    this.stopped = false;
    pairingEvents.on("paired", this.onPaired);
    this.connect();
  }

  close() {
    this.stopped = true;
    pairingEvents.off("paired", this.onPaired);
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
    this.socket?.destroy();
    this.setOnline(false);
  }

  private reconnectNow() {
    clearTimeout(this.timer);
    this.backoffMs = 2000;
    this.socket?.destroy();
    if (!this.socket || this.socket.destroyed) this.connect();
  }

  private connect() {
    let id;
    try {
      id = loadIdentity();
    } catch (err) {
      this.log("error", `can't load the remote certificate: ${(err as Error).message}`);
      return;
    }
    let handshook = false;
    const sock = connect({ host: this.host, port: this.port, cert: id.cert, key: id.key, rejectUnauthorized: false, timeout: 8000 });
    this.socket = sock;
    const deframer = new Deframer();
    sock.on("secureConnect", () => {
      handshook = true;
      this.log("info", `TLS connected to ${this.host}:${this.port}; waiting for the TV to configure`);
    });
    sock.on("timeout", () => {
      if (!this.online) sock.destroy(new Error("timed out"));
    });
    sock.on("data", (chunk: Buffer) => {
      try {
        for (const m of deframer.push(chunk)) this.onMessage(decode(m));
      } catch (err) {
        this.log("error", `bad message from TV: ${(err as Error).message}`);
        sock.destroy();
      }
    });
    sock.on("error", (err) => {
      // A TV that doesn't know our certificate drops the TLS handshake.
      const hint = handshook ? "" : " (if this TV hasn't been paired yet, pair it from the admin's Test panel)";
      this.log("error", `${err.message}${hint}`);
    });
    sock.on("close", () => {
      clearTimeout(this.watchdog);
      const wasOnline = this.online;
      this.setOnline(false);
      if (!handshook) this.emit("data", JSON.stringify({ reachable: false }));
      if (this.stopped || this.socket !== sock) return;
      if (wasOnline) this.backoffMs = 2000;
      this.log("info", `disconnected; retrying in ${this.backoffMs / 1000}s`);
      this.timer = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
  }

  private onMessage(m: Fields) {
    this.kick();
    const configure = msg(m, 1);
    if (configure) {
      const info = msg(configure, 2);
      this.log("rx", `configure from ${str(info, 2) ?? "?"} ${str(info, 1) ?? ""}`.trim());
      this.emit("data", JSON.stringify({ model: str(info, 1), vendor: str(info, 2), appVersion: str(info, 6), paired: true }));
      const deviceInfo = encode([[1, "Blue Vue"], [2, "Blue Vue"], [3, 1], [4, "1"], [5, "atvremote"], [6, "1.0.0"]]);
      this.write(encode([[1, encode([[1, FEATURES], [2, deviceInfo]])]]));
      return;
    }
    if (msg(m, 2)) {
      this.write(encode([[2, encode([[1, FEATURES]])]]));
      this.backoffMs = 2000;
      this.log("info", "remote session ready");
      this.setOnline(true);
      return;
    }
    const ping = msg(m, 8);
    if (ping) {
      this.write(encode([[9, encode([[1, num(ping, 1)]])]]));
      return;
    }
    const start = msg(m, 40);
    if (start) {
      // An unset bool is false, so an empty message means "off".
      this.power = num(start, 1) === 1;
      this.log("rx", `TV reports power ${this.power ? "on" : "off"}`);
      this.emit("data", JSON.stringify({ power: this.power }));
      this.emit("power", this.power);
      return;
    }
    const ime = msg(m, 20);
    if (ime) {
      const app = str(msg(ime, 1), 12);
      if (app) {
        this.log("rx", `current app ${app}`);
        this.emit("data", JSON.stringify({ app }));
      }
      return;
    }
    const volume = msg(m, 50);
    if (volume) {
      const v = { volume: num(volume, 7) ?? 0, volumeMax: num(volume, 6) ?? 0, muted: num(volume, 8) === 1 };
      this.log("rx", `volume ${v.volume}/${v.volumeMax}${v.muted ? " muted" : ""}`);
      this.emit("data", JSON.stringify(v));
      return;
    }
    if (msg(m, 3)) this.log("error", "TV rejected the last message");
  }

  /** Drops a session that has gone quiet; the TV pings every few seconds while connected. */
  private kick() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.log("info", "TV stopped answering; reconnecting");
      this.socket?.destroy();
    }, 30_000);
  }

  private write(body: Buffer) {
    this.socket?.write(frame(body));
  }

  private sendKey(code: number) {
    this.write(encode([[10, encode([[1, code], [2, SHORT_PRESS]])]]));
    this.log("tx", keyName(code));
  }

  async send(p: RenderedPayload) {
    if (p.kind !== "androidtv") throw new Error(`Android TV remote can't send ${p.kind} payloads`);
    if (p.power) return JSON.stringify(await this.setPower(p.power === "on"));
    this.requireSession();
    if (p.key !== undefined) {
      this.sendKey(keyCode(p.key));
      return undefined;
    }
    if (p.appLink) {
      this.write(encode([[90, encode([[1, p.appLink]])]]));
      this.log("tx", `open ${p.appLink}`);
      return undefined;
    }
    throw new Error("Android TV payload needs a key, power or appLink");
  }

  private requireSession() {
    if (!this.online) throw new Error(`No remote session with ${this.host}. Check it's on the network and paired.`);
  }

  /**
   * Discrete power. The protocol only has a POWER key, which toggles, so this
   * sends it only when the TV has reported the opposite state, then waits for
   * the TV to report the change.
   */
  private async setPower(on: boolean): Promise<{ power?: boolean; result: string }> {
    const want = on ? "on" : "off";
    if (!this.online && on && this.mac) {
      await wakeOnLan(this.mac);
      this.log("tx", `wake-on-LAN to ${this.mac}`);
      await this.waitFor(() => this.online, 20_000);
    }
    this.requireSession();
    await this.waitFor(() => this.power !== undefined, 3000);
    if (this.power === undefined) throw new Error("The TV hasn't reported whether it's on, so POWER (a toggle) wasn't sent");
    if (this.power === on) {
      this.log("info", `already ${want}; nothing sent`);
      return { power: this.power, result: `already ${want}` };
    }
    this.sendKey(keyCode("POWER"));
    await this.waitFor(() => this.power === on, 8000);
    if (this.power === on) {
      this.log("info", `TV reports ${want}`);
      return { power: on, result: `${want}, reported by the TV` };
    }
    this.log("error", `sent POWER but the TV hasn't reported ${want}`);
    return { power: this.power, result: `sent POWER; TV hasn't reported ${want}` };
  }

  private waitFor(done: () => boolean, ms: number) {
    return new Promise<void>((resolve) => {
      if (done()) return resolve();
      const check = () => {
        if (!done()) return;
        cleanup();
        resolve();
      };
      const t = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const cleanup = () => {
        clearTimeout(t);
        this.off("power", check);
        this.off("status", check);
      };
      this.on("power", check);
      this.on("status", check);
    });
  }
}

async function wakeOnLan(mac: string) {
  await new WolConnection({ type: "wol" }, { mac }).send({ kind: "wol" });
}

// --- Pairing ----------------------------------------------------------------

const STATUS_OK = 200;
const HEX = 3;
const ROLE_INPUT = 1;

interface PairingSession {
  socket: TLSSocket;
  serverCert: Buffer;
  next: () => Promise<Fields>;
  expires: NodeJS.Timeout;
}

const sessions = new Map<string, PairingSession>();

/** Starts pairing; resolves once the TV is showing its 6-character code. */
export async function startPairing(host: string, port = PAIRING_PORT, timeoutMs = 10_000): Promise<void> {
  cancelPairing(host);
  const id = loadIdentity();
  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const s = connect({ host, port, cert: id.cert, key: id.key, rejectUnauthorized: false, timeout: timeoutMs }, () => resolve(s));
    s.once("error", (err) => reject(new Error(`Can't reach ${host}:${port} for pairing: ${err.message}`)));
    s.once("timeout", () => s.destroy(new Error("timed out")));
  });
  socket.setTimeout(0);
  const serverCert = socket.getPeerX509Certificate()?.raw;
  if (!serverCert) {
    socket.destroy();
    throw new Error("The TV sent no certificate");
  }

  const deframer = new Deframer();
  const queue: Fields[] = [];
  let waiting: { resolve: (f: Fields) => void; reject: (e: Error) => void } | undefined;
  let failure: Error | undefined;
  const fail = (err: Error) => {
    failure ??= err;
    waiting?.reject(failure);
    waiting = undefined;
  };
  socket.on("data", (chunk: Buffer) => {
    try {
      for (const m of deframer.push(chunk)) {
        const f = decode(m);
        if (waiting) {
          waiting.resolve(f);
          waiting = undefined;
        } else queue.push(f);
      }
    } catch (err) {
      fail(err as Error);
    }
  });
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("The TV closed the pairing connection")));
  const next = () =>
    new Promise<Fields>((resolve, reject) => {
      if (queue.length) return resolve(queue.shift()!);
      if (failure) return reject(failure);
      const t = setTimeout(() => reject(new Error("The TV didn't answer")), timeoutMs);
      waiting = {
        resolve: (f) => (clearTimeout(t), resolve(f)),
        reject: (e) => (clearTimeout(t), reject(e)),
      };
    });

  try {
    await exchange(socket, next, [10, encode([[1, "atvremote"], [2, CLIENT_NAME]])], 11);
    const encoding = encode([[1, HEX], [2, 6]]);
    await exchange(socket, next, [20, encode([[1, encoding], [3, ROLE_INPUT]])], 20);
    await exchange(socket, next, [30, encode([[1, encoding], [2, ROLE_INPUT]])], 31);
  } catch (err) {
    socket.destroy();
    throw err;
  }
  // The code is on screen now. Give up if nobody types it in.
  const expires = setTimeout(() => cancelPairing(host), 120_000);
  sessions.set(host, { socket, serverCert, next, expires });
}

/** Sends the code shown on the TV. Wrong codes can be retried until pairing expires. */
export async function finishPairing(host: string, code: string): Promise<void> {
  const s = sessions.get(host);
  if (!s) throw new Error("No pairing in progress for this TV (or it timed out). Start pairing again.");
  const clean = code.trim().toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(clean)) throw new Error("The code is 6 characters, using 0-9 and A-F");
  const secret = pairingSecret(loadIdentity(), s.serverCert, clean);
  // The first byte of the hash is the code's first two characters; checking it here catches typos.
  if (secret[0] !== parseInt(clean.slice(0, 2), 16)) throw new Error("That code doesn't match the one on the TV");
  try {
    await exchange(s.socket, s.next, [40, encode([[1, secret]])], 41);
  } finally {
    cancelPairing(host);
  }
  pairingEvents.emit("paired", host);
}

/** One pairing step, as the admin drives it. In simulation nothing is sent. */
export async function pairStep(host: string, step: "start" | "finish" | "cancel", code = "", simulate = false) {
  if (simulate) {
    if (step === "finish" && !/^[0-9a-f]{6}$/i.test(code.trim())) throw new Error("The code is 6 characters, using 0-9 and A-F");
    return;
  }
  if (step === "start") await startPairing(host);
  else if (step === "finish") await finishPairing(host, code);
  else cancelPairing(host);
}

export function cancelPairing(host: string) {
  const s = sessions.get(host);
  if (!s) return;
  clearTimeout(s.expires);
  s.socket.destroy();
  sessions.delete(host);
}

/** SHA-256 over both RSA keys and the code's last four characters. */
export function pairingSecret(client: { cert: string; key: string }, serverCertDer: Buffer, code: string): Buffer {
  const c = rsaNumbers(publicKeyOf(client));
  const s = rsaNumbers(new X509Certificate(serverCertDer).publicKey);
  return createHash("sha256").update(c.n).update(c.e).update(s.n).update(s.e).update(Buffer.from(code.slice(2), "hex")).digest();
}

/** Sends one pairing message and waits for the expected reply field. */
async function exchange(socket: TLSSocket, next: () => Promise<Fields>, body: [number, Buffer], expect: number) {
  socket.write(frame(encode([[1, 2], [2, STATUS_OK], body])));
  const reply = await next();
  const status = num(reply, 2);
  if (status !== STATUS_OK) {
    const why = status === 402 ? "wrong code" : status === 401 ? "bad configuration" : `status ${status}`;
    throw new Error(`The TV refused pairing (${why})`);
  }
  if (!msg(reply, expect)) throw new Error("Unexpected reply from the TV during pairing");
  return reply;
}
