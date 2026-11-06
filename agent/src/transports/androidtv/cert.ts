import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The TV remembers a remote by its TLS client certificate: pairing teaches the
// TV this certificate, and later connections present it. One certificate per
// machine (control server or wall PC) is enough for any number of TVs. It's
// kept in the data folder, never in the repo.

export interface Identity {
  cert: string; // PEM
  key: string; // PEM
}

/** Where the certificate lives. The server sets its data folder; the agent its config folder. */
export const identityStore = { dir: process.cwd() };

const FILE = "androidtv-remote.pem";
let cached: Identity | undefined;

export function loadIdentity(): Identity {
  if (cached) return cached;
  const path = join(identityStore.dir, FILE);
  if (existsSync(path)) {
    const pem = readFileSync(path, "utf8");
    const key = pem.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/)?.[0];
    const cert = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
    if (key && cert) return (cached = { key: key + "\n", cert: cert + "\n" });
  }
  const id = createIdentity("Blue Vue");
  mkdirSync(identityStore.dir, { recursive: true });
  writeFileSync(path, id.key + id.cert, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores Unix modes; the data folder's own permissions apply.
  }
  return (cached = id);
}

/** For tests: forget the loaded certificate so a new folder takes effect. */
export function resetIdentity() {
  cached = undefined;
}

/** Makes an RSA key and a self-signed certificate for it, using only node:crypto. */
export function createIdentity(commonName: string): Identity {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sha256WithRsa = der(0x30, oid("1.2.840.113549.1.1.11"), der(0x05));
  const name = der(0x30, der(0x31, der(0x30, oid("2.5.4.3"), der(0x0c, Buffer.from(commonName, "utf8")))));
  const now = Date.now();
  const serial = randomBytes(8);
  serial[0] &= 0x7f; // keep it positive
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))), // v3
    der(0x02, serial),
    sha256WithRsa,
    name,
    der(0x30, utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 20 * 365 * 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", tbs, privateKey);
  const cert = der(0x30, tbs, sha256WithRsa, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END CERTIFICATE-----\n`;
  new X509Certificate(certPem); // throws if we built something malformed
  return { cert: certPem, key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

/** RSA modulus and exponent as unsigned big-endian bytes, as the pairing hash wants them. */
export function rsaNumbers(key: KeyObject): { n: Buffer; e: Buffer } {
  const jwk = key.export({ format: "jwk" });
  if (!jwk.n || !jwk.e) throw new Error("not an RSA key");
  return { n: stripZeros(Buffer.from(jwk.n, "base64url")), e: stripZeros(Buffer.from(jwk.e, "base64url")) };
}

export function publicKeyOf(id: Identity): KeyObject {
  return createPublicKey(createPrivateKey(id.key));
}

function stripZeros(b: Buffer) {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
}

// --- DER --------------------------------------------------------------------

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a + b];
  for (const v of rest) {
    const chunk = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return der(0x06, Buffer.from(out));
}

function utcTime(d: Date): Buffer {
  const s = d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"; // YYMMDDHHMMSSZ
  return der(0x17, Buffer.from(s, "ascii"));
}
