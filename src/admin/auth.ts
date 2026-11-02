import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SESSION_HOURS = 12;
const MIN_PASSWORD = 8;

interface Stored {
  salt: string;
  hash: string;
}

/**
 * The admin password (scrypt-hashed in data/admin.json) and login sessions.
 * The password is chosen in the browser on first visit; until then the admin
 * shows a setup screen. Sessions live in memory, so a restart signs everyone out.
 */
export class AdminAuth {
  readonly file: string;
  private sessions = new Map<string, number>(); // token -> expiry
  private failures = new Map<string, { count: number; until: number }>();

  constructor(dataDir: string) {
    this.file = join(dataDir, "admin.json");
  }

  get setupRequired() {
    return !existsSync(this.file);
  }

  setPassword(password: string) {
    if (password.length < MIN_PASSWORD) throw Object.assign(new Error(`Use at least ${MIN_PASSWORD} characters`), { statusCode: 400 });
    const salt = randomBytes(16).toString("hex");
    const stored: Stored = { salt, hash: scryptSync(password, salt, 64).toString("hex") };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(stored, null, 2), { mode: 0o600 });
    // Changing the password signs out every other session.
    this.sessions.clear();
  }

  check(password: string): boolean {
    if (this.setupRequired) return false;
    const stored: Stored = JSON.parse(readFileSync(this.file, "utf8"));
    const got = scryptSync(password, stored.salt, 64);
    return timingSafeEqual(got, Buffer.from(stored.hash, "hex"));
  }

  /** Checks a login attempt with a growing lockout after repeated failures from one address. */
  login(password: string, from: string): string {
    const f = this.failures.get(from);
    if (f && f.until > Date.now()) {
      throw Object.assign(new Error(`Too many attempts; try again in ${Math.ceil((f.until - Date.now()) / 1000)}s`), { statusCode: 429 });
    }
    if (!this.check(password)) {
      const count = (f?.count ?? 0) + 1;
      this.failures.set(from, { count, until: count >= 5 ? Date.now() + Math.min(2 ** (count - 5), 60) * 30_000 : 0 });
      throw Object.assign(new Error("Wrong password"), { statusCode: 401 });
    }
    this.failures.delete(from);
    return this.createSession();
  }

  createSession(): string {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, Date.now() + SESSION_HOURS * 3_600_000);
    return token;
  }

  valid(token: string | undefined): boolean {
    if (!token) return false;
    const exp = this.sessions.get(token);
    if (!exp) return false;
    if (exp < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  logout(token: string | undefined) {
    if (token) this.sessions.delete(token);
  }
}

export const COOKIE = "bv_admin";

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function sessionCookie(token: string, maxAgeSec = SESSION_HOURS * 3600) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`;
}
