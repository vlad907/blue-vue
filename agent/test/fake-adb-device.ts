import { constants, createPublicKey, publicDecrypt, randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { AUTH_RSAPUBLICKEY, AUTH_SIGNATURE, AUTH_TOKEN, CMD, packet, parseAndroidPublicKey, Reader } from "../src/transports/adb/client.ts";

// A Fire TV with ADB debugging on, written from the ADB protocol description:
// it checks the RSA signature, asks for approval for unknown keys, and runs
// a few shell commands the Fire TV profile uses.

const SHA1_PREFIX = Buffer.from("3021300906052b0e03021a05000414", "hex");
const b64url = (v: bigint) => {
  let hex = v.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex").toString("base64url");
};

export class FakeFireTv {
  server: Server;
  port = 0;
  awake = false;
  app = "com.amazon.tv.launcher";
  commands: string[] = [];
  trusted: string[] = []; // public keys (base64) the TV accepted
  prompts = 0; // "Allow debugging?" prompts shown
  allow: "yes" | "no" | "wait" = "yes"; // how the person at the TV answers

  constructor() {
    this.server = createServer((s) => this.session(s));
  }

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
    return this;
  }

  stop() {
    this.server.close();
  }

  private shell(cmd: string): string {
    this.commands.push(cmd);
    let out = "";
    for (const part of cmd.split(/\s*;\s*/)) {
      if (part === "input keyevent KEYCODE_WAKEUP") this.awake = true;
      else if (part === "input keyevent KEYCODE_SLEEP") this.awake = false;
      else if (part.startsWith("dumpsys power")) out += `  mWakefulness=${this.awake ? "Awake" : "Asleep"}\n`;
      else if (part.startsWith("dumpsys window")) out += `  mCurrentFocus=Window{4c1f2d8 u0 ${this.app}/${this.app}.Main}\n`;
      else if (part.startsWith("echo model=")) out += "model=AFTKRT\n";
      else if (part.startsWith("monkey -p ")) {
        this.app = part.split(" ")[2];
        out += "Events injected: 1\n";
      }
    }
    return out;
  }

  private session(sock: Socket) {
    const reader = new Reader();
    let token = randomBytes(20);
    const send = (cmd: number, a0: number, a1: number, data?: Buffer | string) => sock.write(packet(cmd, a0, a1, data));
    const connected = () => send(CMD.CNXN, 0x01000001, 256 * 1024, "device::ro.product.name=fire;ro.product.model=AFTKRT;\0");
    let nextId = 100;
    sock.on("error", () => {});
    sock.on("data", (chunk) => {
      for (const m of reader.push(chunk)) {
        if (m.command === CMD.CNXN) {
          token = randomBytes(20);
          send(CMD.AUTH, AUTH_TOKEN, 0, token);
        } else if (m.command === CMD.AUTH && m.arg0 === AUTH_SIGNATURE) {
          if (this.trusted.some((k) => verify(k, token, m.data))) connected();
          else {
            token = randomBytes(20);
            send(CMD.AUTH, AUTH_TOKEN, 0, token);
          }
        } else if (m.command === CMD.AUTH && m.arg0 === AUTH_RSAPUBLICKEY) {
          this.prompts++;
          const key = m.data.toString("utf8").replace(/\0+$/, "").split(" ")[0];
          if (this.allow === "yes") setTimeout(() => (this.trusted.push(key), connected()), 50);
          else if (this.allow === "no") sock.destroy();
          // "wait": the prompt stays on screen.
        } else if (m.command === CMD.OPEN) {
          const service = m.data.toString("utf8").replace(/\0+$/, "");
          const id = nextId++;
          if (!service.startsWith("shell:")) {
            send(CMD.CLSE, 0, m.arg0);
            continue;
          }
          send(CMD.OKAY, id, m.arg0);
          const out = this.shell(service.slice(6));
          if (out) send(CMD.WRTE, id, m.arg0, out);
          send(CMD.CLSE, id, m.arg0);
        }
      }
    });
  }
}

function verify(publicKey: string, token: Buffer, signature: Buffer) {
  const { n, e } = parseAndroidPublicKey(publicKey);
  const key = createPublicKey({ key: { kty: "RSA", n: b64url(n), e: b64url(BigInt(e)) }, format: "jwk" });
  try {
    return publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, signature).equals(Buffer.concat([SHA1_PREFIX, token]));
  } catch {
    return false;
  }
}
