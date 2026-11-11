import type { Server as HttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";

// Which network cards Blue Vue answers on. The web server itself never binds a
// port: one small listener per address hands its connections to it. That lets
// the admin switch network cards live, and keeps 127.0.0.1 working so the PC
// itself can always reach Blue Vue (the installer's health check, a browser
// on the server).

export interface Nic {
  name: string; // e.g. "Ethernet 2"
  addresses: string[]; // IPv4
}

/** This machine's network cards that have an IPv4 address (loopback left out). */
export function listNics(): Nic[] {
  return Object.entries(networkInterfaces())
    .map(([name, list]) => ({ name, addresses: (list ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address) }))
    .filter((n) => n.addresses.length);
}

/** Network card names or IPv4 addresses -> the addresses they currently have. */
export function resolveInterfaces(entries: string[]): { addresses: string[]; missing: string[] } {
  const nics = listNics();
  const addresses = new Set<string>();
  const missing: string[] = [];
  for (const raw of entries) {
    const e = raw.trim();
    const byName = nics.find((n) => n.name.toLowerCase() === e.toLowerCase());
    if (byName) byName.addresses.forEach((a) => addresses.add(a));
    else if (nics.some((n) => n.addresses.includes(e))) addresses.add(e);
    else missing.push(e);
  }
  return { addresses: [...addresses], missing };
}

export interface ListenStatus {
  port: number;
  interfaces: string[]; // as configured; empty means every network
  listening: string[]; // addresses actually answering
  problems: string[]; // cards not found right now, ports in use
}

export class InterfaceListener {
  private servers = new Map<string, Server>();
  private sockets = new Set<Socket>(); // handed to the web server; closed with the listener
  private problems = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private interfaces: string[] = [];

  constructor(private http: HttpServer, private port: number, private log = (m: string) => console.log(m)) {}

  /** Starts answering on these cards (empty: all of them). Rejects only if nothing could listen at all. */
  async apply(interfaces: string[]) {
    this.interfaces = interfaces.map((s) => s.trim()).filter(Boolean);
    await this.sync();
    clearInterval(this.timer);
    // A card that's unplugged or still getting its address at boot is picked up when it appears.
    if (this.interfaces.length) this.timer = setInterval(() => void this.sync(), 10_000);
    if (!this.servers.size) throw new Error(`Couldn't listen on port ${this.port}: ${[...this.problems.values()].join("; ")}`);
  }

  status(): ListenStatus {
    return { port: this.port, interfaces: this.interfaces, listening: [...this.servers.keys()], problems: [...this.problems.values()] };
  }

  close() {
    clearInterval(this.timer);
    for (const s of this.servers.values()) s.close();
    this.servers.clear();
    // The web server never listened itself, so it can't close these on its own.
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  private async sync() {
    let wanted: string[];
    this.problems.clear();
    if (!this.interfaces.length) wanted = ["0.0.0.0"];
    else {
      const { addresses, missing } = resolveInterfaces(this.interfaces);
      wanted = ["127.0.0.1", ...addresses];
      for (const m of missing) this.problems.set(m, `network card "${m}" isn't connected or has no address`);
    }
    for (const [addr, s] of this.servers) {
      if (wanted.includes(addr)) continue;
      s.close();
      this.servers.delete(addr);
      this.log(`[server] stopped answering on ${addr}:${this.port}`);
    }
    for (const addr of wanted) {
      if (this.servers.has(addr)) continue;
      try {
        this.servers.set(addr, await this.bind(addr));
        this.log(`[server] answering on ${addr === "0.0.0.0" ? "every network" : addr}, port ${this.port}`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        this.problems.set(addr, code === "EADDRINUSE" ? `port ${this.port} on ${addr} is used by another program` : `${addr}: ${(err as Error).message}`);
      }
    }
  }

  private bind(addr: string) {
    return new Promise<Server>((resolve, reject) => {
      const s = createServer((sock) => {
        this.sockets.add(sock);
        sock.once("close", () => this.sockets.delete(sock));
        this.http.emit("connection", sock);
      });
      s.once("error", reject);
      s.listen(this.port, addr, () => {
        s.off("error", reject);
        s.on("error", (err) => this.log(`[server] ${addr}: ${err.message}`));
        resolve(s);
      });
    });
  }
}
