import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { createIdentity, publicKeyOf, rsaNumbers } from "../src/transports/androidtv/cert.ts";
import { Deframer, decode, encode, frame, msg, num } from "../src/transports/androidtv/protobuf.ts";

/**
 * A stand-in TV speaking both halves of the protocol, written from the
 * protocol description rather than from our client, so the two meet in the
 * middle. It remembers paired client certificates like a real TV.
 */
export class FakeTv {
  id = createIdentity("fake tv");
  paired = new Set<string>();
  power = false;
  keys: number[] = [];
  links: string[] = [];
  pongs: number[] = [];
  code = "";
  pairing!: Server;
  remote!: Server;
  clients = new Set<TLSSocket>();

  async start() {
    const opts = { key: this.id.key, cert: this.id.cert, requestCert: true, rejectUnauthorized: false };
    this.pairing = createServer(opts, (s) => this.onPairing(s));
    this.remote = createServer(opts, (s) => this.onRemote(s));
    await Promise.all([this.pairing, this.remote].map((srv) => new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))));
  }
  get pairingPort() {
    return (this.pairing.address() as { port: number }).port;
  }
  get remotePort() {
    return (this.remote.address() as { port: number }).port;
  }
  stop() {
    for (const c of this.clients) c.destroy();
    this.pairing.close();
    this.remote.close();
  }

  private onPairing(s: TLSSocket) {
    const d = new Deframer();
    const reply = (status: number, field?: [number, Buffer]) => s.write(frame(encode([[1, 2], [2, status], ...(field ? [field] : [])])));
    s.on("data", (chunk) => {
      for (const raw of d.push(chunk)) {
        const m = decode(raw);
        if (msg(m, 10)) reply(200, [11, encode([[1, "fake tv"]])]);
        else if (msg(m, 20)) reply(200, [20, encode([[1, encode([[1, 3], [2, 6]])], [3, 1]])]);
        else if (msg(m, 30)) {
          // Show a code: two hex digits of the hash, then the four hashed ones.
          const tail = randomBytes(2);
          const h = this.hash(s, tail);
          this.code = (h[0].toString(16).padStart(2, "0") + tail.toString("hex")).toUpperCase();
          reply(200, [31, Buffer.alloc(0)]);
        } else if (msg(m, 40)) {
          const sent = msg(m, 40)!.get(1)![0] as Buffer;
          const expected = this.hash(s, Buffer.from(this.code.slice(2), "hex"));
          if (!sent.equals(expected)) return reply(402);
          this.paired.add(s.getPeerX509Certificate()!.fingerprint256);
          reply(200, [41, encode([[1, expected]])]);
        }
      }
    });
    s.on("error", () => {});
  }

  private hash(s: TLSSocket, tail: Buffer) {
    const c = rsaNumbers(s.getPeerX509Certificate()!.publicKey);
    const t = rsaNumbers(publicKeyOf(this.id));
    return createHash("sha256").update(c.n).update(c.e).update(t.n).update(t.e).update(tail).digest();
  }

  private onRemote(s: TLSSocket) {
    if (!this.paired.has(s.getPeerX509Certificate()?.fingerprint256 ?? "")) return s.destroy();
    this.clients.add(s);
    s.on("close", () => this.clients.delete(s));
    s.on("error", () => {});
    const send = (field: number, body: Buffer) => s.write(frame(encode([[field, body]])));
    const d = new Deframer();
    send(1, encode([[1, 622], [2, encode([[1, "98QM7L"], [2, "TCL"], [6, "5.2"]])]]));
    s.on("data", (chunk) => {
      for (const raw of d.push(chunk)) {
        const m = decode(raw);
        if (msg(m, 1)) send(2, Buffer.alloc(0));
        else if (msg(m, 2)) {
          send(40, encode([[1, this.power]]));
          send(8, encode([[1, 7], [2, 1]]));
        } else if (msg(m, 9)) this.pongs.push(num(msg(m, 9), 1)!);
        else if (msg(m, 10)) {
          const key = num(msg(m, 10), 1)!;
          this.keys.push(key);
          if (key === 26) {
            this.power = !this.power;
            send(40, encode([[1, this.power]]));
          }
        } else if (msg(m, 90)) this.links.push(msg(m, 90)!.get(1)![0].toString());
      }
    });
  }
}

