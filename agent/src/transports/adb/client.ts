import { createHash, createPrivateKey, constants, generateKeyPairSync, privateEncrypt, type KeyObject } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { identityStore } from "../androidtv/cert.ts";

// The ADB wire protocol over TCP (network debugging, port 5555), written out
// so no Android platform-tools need installing on the server or a wall PC.
// The TV learns this machine's RSA key the first time someone ticks
// "Always allow" on its "Allow debugging?" prompt.

export const CMD = {
  CNXN: 0x4e584e43,
  AUTH: 0x48545541,
  OPEN: 0x4e45504f,
  OKAY: 0x59414b4f,
  CLSE: 0x45534c43,
  WRTE: 0x45545257,
} as const;
export const VERSION = 0x01000001;
export const MAX_DATA = 256 * 1024;
export const AUTH_TOKEN = 1;
export const AUTH_SIGNATURE = 2;
export const AUTH_RSAPUBLICKEY = 3;

export interface AdbMessage {
  command: number;
  arg0: number;
  arg1: number;
  data: Buffer;
}

export function packet(command: number, arg0: number, arg1: number, data: Buffer | string = Buffer.alloc(0)): Buffer {
  const body = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const head = Buffer.alloc(24);
  head.writeUInt32LE(command, 0);
  head.writeUInt32LE(arg0 >>> 0, 4);
  head.writeUInt32LE(arg1 >>> 0, 8);
  head.writeUInt32LE(body.length, 12);
  head.writeUInt32LE(body.reduce((s, b) => s + b, 0) >>> 0, 16); // only checked by old devices
  head.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([head, body]);
}

/** Splits a TCP byte stream into ADB messages. */
export class Reader {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer): AdbMessage[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: AdbMessage[] = [];
    while (this.buf.length >= 24) {
      const len = this.buf.readUInt32LE(12);
      if (this.buf.length < 24 + len) break;
      out.push({ command: this.buf.readUInt32LE(0), arg0: this.buf.readUInt32LE(4), arg1: this.buf.readUInt32LE(8), data: this.buf.subarray(24, 24 + len) });
      this.buf = this.buf.subarray(24 + len);
    }
    return out;
  }
}

// --- This machine's ADB key -------------------------------------------------------

const KEY_FILE = "adbkey.pem";
let cachedKey: KeyObject | undefined;

/** The RSA key the TVs learn. Kept next to the Android TV certificate, never in the repo. */
export function loadAdbKey(): KeyObject {
  if (cachedKey) return cachedKey;
  const path = join(identityStore.dir, KEY_FILE);
  if (existsSync(path)) return (cachedKey = createPrivateKey(readFileSync(path, "utf8")));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
  mkdirSync(identityStore.dir, { recursive: true });
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: the data folder's permissions apply.
  }
  return (cachedKey = privateKey);
}

export function resetAdbKey() {
  cachedKey = undefined;
}

const SHA1_PREFIX = Buffer.from("3021300906052b0e03021a05000414", "hex");

/** ADB signs the device's 20-byte token as if it were a SHA-1 digest. */
export function signToken(key: KeyObject, token: Buffer): Buffer {
  return privateEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA1_PREFIX, token]));
}

/** Android's own public key format (android_pubkey.c), base64, then a name. */
export function androidPublicKey(key: KeyObject, name = "bluevue@bluevue"): string {
  const jwk = key.export({ format: "jwk" }) as { n: string; e: string };
  const nBytes = Buffer.from(jwk.n, "base64url");
  const words = nBytes.length / 4;
  const n = BigInt("0x" + nBytes.toString("hex"));
  const e = Number(BigInt("0x" + Buffer.from(jwk.e, "base64url").toString("hex")));
  const m32 = 1n << 32n;
  const n0inv = (m32 - modInverse(n % m32, m32)) % m32;
  const rr = (1n << BigInt(nBytes.length * 16)) % n;
  const out = Buffer.alloc(4 + 4 + nBytes.length * 2 + 4);
  out.writeUInt32LE(words, 0);
  out.writeUInt32LE(Number(n0inv), 4);
  littleEndian(n, nBytes.length).copy(out, 8);
  littleEndian(rr, nBytes.length).copy(out, 8 + nBytes.length);
  out.writeUInt32LE(e, 8 + nBytes.length * 2);
  return `${out.toString("base64")} ${name}`;
}

/** Reverse of androidPublicKey, for the test device. */
export function parseAndroidPublicKey(text: string): { n: bigint; e: number } {
  const raw = Buffer.from(text.split(/[ \0]/)[0], "base64");
  const len = raw.readUInt32LE(0) * 4;
  const n = BigInt("0x" + Buffer.from(raw.subarray(8, 8 + len)).reverse().toString("hex"));
  return { n, e: raw.readUInt32LE(8 + len * 2) };
}

export const keyFingerprint = (key: KeyObject) => createHash("sha256").update(androidPublicKey(key).split(" ")[0]).digest("hex").slice(0, 16);

function littleEndian(v: bigint, size: number) {
  return Buffer.from(v.toString(16).padStart(size * 2, "0"), "hex").reverse();
}

function modInverse(a: bigint, m: bigint) {
  let [r0, r1, s0, s1] = [a, m, 1n, 0n];
  while (r1) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return ((s0 % m) + m) % m;
}

// --- The connection ---------------------------------------------------------------

export type AdbState = "disconnected" | "connecting" | "awaiting-approval" | "connected";

interface Stream {
  remote?: number;
  out: Buffer[];
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  opened: (ok: boolean) => void;
}

/**
 * One ADB connection to a device, kept open. Each shell command runs on its
 * own stream. While the TV shows "Allow debugging?", the connection waits;
 * the prompt stays up until someone answers it.
 */
export class AdbClient extends EventEmitter {
  state: AdbState = "disconnected";
  banner = ""; // e.g. "device::ro.product.model=AFTKA;..."
  private socket?: Socket;
  private reader = new Reader();
  private streams = new Map<number, Stream>();
  private nextId = 1;
  private authTries = 0;
  private ready?: Promise<void>;

  host: string;
  port: number;
  private key: () => KeyObject;

  constructor(host: string, port = 5555, key: () => KeyObject = loadAdbKey) {
    super();
    this.host = host;
    this.port = port;
    this.key = key;
  }

  /** Connects if needed. Rejects after waitMs, but a pending approval keeps waiting in the background. */
  connect(waitMs = 8000): Promise<void> {
    if (this.state === "connected") return Promise.resolve();
    if (!this.ready) this.ready = this.open();
    const ready = this.ready;
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(this.state === "awaiting-approval" ? `Waiting for "Allow debugging" to be accepted on the TV (tick Always allow)` : `No answer from ${this.host}:${this.port}`));
      }, waitMs);
      ready.then(
        () => (clearTimeout(t), resolve()),
        (err) => (clearTimeout(t), reject(err)),
      );
    });
  }

  /** Runs a shell command and resolves with its output. */
  async shell(command: string, timeoutMs = 8000): Promise<string> {
    await this.connect();
    const local = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.streams.delete(local);
        // A TV that fell asleep leaves the connection looking open but dead. Drop it, so the
        // next command connects afresh instead of also going into the dead one.
        this.socket?.destroy();
        reject(new Error(`"${command}" didn't finish in ${timeoutMs / 1000}s`));
      }, timeoutMs);
      const done = <T>(f: (v: T) => void) => (v: T) => {
        clearTimeout(timer);
        this.streams.delete(local);
        f(v);
      };
      this.streams.set(local, {
        out: [],
        resolve: done(resolve),
        reject: done(reject),
        opened: (ok) => !ok && done(reject)(new Error(`The TV refused the command "${command}"`)),
      });
      this.write(packet(CMD.OPEN, local, 0, `shell:${command}\0`));
    });
  }

  close() {
    this.socket?.destroy();
  }

  private write(buf: Buffer) {
    this.socket?.write(buf);
  }

  private setState(s: AdbState) {
    if (s === this.state) return;
    this.state = s;
    this.emit("state", s);
  }

  private open() {
    return new Promise<void>((resolve, reject) => {
      const sock = new Socket();
      this.socket = sock;
      this.reader = new Reader();
      this.authTries = 0;
      this.setState("connecting");
      let settled = false;
      const fail = (err: Error) => {
        if (!settled) (settled = true), reject(err);
      };
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 15_000);
      sock.setTimeout(10_000, () => {
        // Only the TCP connect and the first reply are timed; an approval prompt may take minutes.
        if (this.state === "connecting") sock.destroy(new Error(`No answer from ${this.host}:${this.port}`));
      });
      sock.on("connect", () => this.write(packet(CMD.CNXN, VERSION, MAX_DATA, "host::\0")));
      sock.on("data", (chunk) => {
        for (const m of this.reader.push(chunk)) {
          if (m.command === CMD.CNXN) {
            this.banner = m.data.toString("utf8").replace(/\0+$/, "");
            sock.setTimeout(0);
            this.setState("connected");
            settled = true;
            resolve();
          } else this.handle(m);
        }
      });
      sock.on("error", (err) => fail(friendly(err, this.host, this.port)));
      sock.on("close", () => {
        fail(new Error(this.state === "awaiting-approval" ? "The TV turned down the debugging request" : `Connection to ${this.host}:${this.port} closed`));
        for (const s of this.streams.values()) s.reject(new Error("Connection to the TV closed"));
        this.streams.clear();
        this.ready = undefined;
        this.setState("disconnected");
      });
      sock.connect(this.port, this.host);
    });
  }

  private handle(m: AdbMessage) {
    switch (m.command) {
      case CMD.AUTH: {
        if (m.arg0 !== AUTH_TOKEN) return;
        this.authTries++;
        if (this.authTries === 1) {
          // First: sign with the key the TV may already trust.
          this.write(packet(CMD.AUTH, AUTH_SIGNATURE, 0, signToken(this.key(), m.data)));
        } else if (this.authTries === 2) {
          // Not trusted yet: offer the key, and the TV asks the user.
          this.write(packet(CMD.AUTH, AUTH_RSAPUBLICKEY, 0, androidPublicKey(this.key()) + "\0"));
          this.setState("awaiting-approval");
          this.emit("approval");
        }
        return;
      }
      case CMD.OKAY: {
        const s = this.streams.get(m.arg1);
        if (s && s.remote === undefined) {
          s.remote = m.arg0;
          s.opened(true);
        }
        return;
      }
      case CMD.WRTE: {
        const s = this.streams.get(m.arg1);
        this.write(packet(CMD.OKAY, m.arg1, m.arg0));
        s?.out.push(Buffer.from(m.data));
        return;
      }
      case CMD.CLSE: {
        const s = this.streams.get(m.arg1);
        if (!s) return;
        if (s.remote === undefined) return s.opened(false);
        this.write(packet(CMD.CLSE, m.arg1, m.arg0));
        s.resolve(Buffer.concat(s.out).toString("utf8"));
        return;
      }
    }
  }
}

function friendly(err: Error, host: string, port: number) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED") return new Error(`${host} refused port ${port}: turn on Network debugging (ADB debugging) in the TV's Developer options`);
  if (code === "EHOSTUNREACH" || code === "ETIMEDOUT") return new Error(`${host} isn't answering; is it on and on this network?`);
  return err;
}
