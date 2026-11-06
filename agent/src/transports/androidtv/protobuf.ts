// Just enough protobuf for the Android TV Remote protocol: varints and
// length-delimited fields, with each message framed by a varint length.

export type Value = number | boolean | string | Uint8Array;
/** Field number -> every value seen for it (varints as numbers, the rest as bytes). */
export type Fields = Map<number, (number | Buffer)[]>;

export function varint(n: number): Buffer {
  const out: number[] = [];
  let v = BigInt.asUintN(64, BigInt(Math.trunc(n)));
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

/** Reads a varint at `pos`; undefined if the buffer ends first. */
export function readVarint(buf: Buffer, pos: number): [value: number, next: number] | undefined {
  let v = 0n;
  let shift = 0n;
  for (let i = pos; i < buf.length && i < pos + 10; i++) {
    v |= BigInt(buf[i] & 0x7f) << shift;
    shift += 7n;
    if (!(buf[i] & 0x80)) return [Number(BigInt.asIntN(64, v)), i + 1];
  }
  if (buf.length - pos >= 10) throw new Error("bad varint");
  return undefined;
}

/** Encodes fields in order. Undefined values are left out, like unset proto fields. */
export function encode(fields: [number, Value | undefined][]): Buffer {
  const parts: Buffer[] = [];
  for (const [num, v] of fields) {
    if (v === undefined) continue;
    if (typeof v === "number" || typeof v === "boolean") {
      parts.push(varint(num << 3), varint(Number(v)));
    } else {
      const bytes = typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v);
      parts.push(varint((num << 3) | 2), varint(bytes.length), bytes);
    }
  }
  return Buffer.concat(parts);
}

export function decode(buf: Buffer): Fields {
  const out: Fields = new Map();
  let pos = 0;
  const add = (n: number, v: number | Buffer) => out.set(n, [...(out.get(n) ?? []), v]);
  while (pos < buf.length) {
    const key = need(readVarint(buf, pos));
    pos = key[1];
    const num = key[0] >>> 3;
    switch (key[0] & 7) {
      case 0: {
        const [v, next] = need(readVarint(buf, pos));
        add(num, v);
        pos = next;
        break;
      }
      case 2: {
        const [len, next] = need(readVarint(buf, pos));
        if (next + len > buf.length) throw new Error("truncated field");
        add(num, buf.subarray(next, next + len));
        pos = next + len;
        break;
      }
      case 1:
        pos += 8;
        break;
      case 5:
        pos += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${key[0] & 7}`);
    }
  }
  return out;
}

function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("truncated message");
  return v;
}

export const num = (f: Fields | undefined, n: number) => {
  const v = f?.get(n)?.[0];
  return typeof v === "number" ? v : undefined;
};
export const bytes = (f: Fields | undefined, n: number) => {
  const v = f?.get(n)?.[0];
  return Buffer.isBuffer(v) ? v : undefined;
};
export const str = (f: Fields | undefined, n: number) => bytes(f, n)?.toString("utf8");
/** A nested message; present-but-empty gives an empty map, so "was it sent" is `!== undefined`. */
export const msg = (f: Fields | undefined, n: number) => {
  const b = bytes(f, n);
  return b ? decode(b) : undefined;
};

/** Prefixes a message with its varint length. */
export function frame(body: Buffer): Buffer {
  return Buffer.concat([varint(body.length), body]);
}

/** Splits a byte stream into length-prefixed messages. */
export class Deframer {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      const len = readVarint(this.buf, 0);
      if (!len || this.buf.length < len[1] + len[0]) break;
      out.push(this.buf.subarray(len[1], len[1] + len[0]));
      this.buf = this.buf.subarray(len[1] + len[0]);
    }
    if (this.buf.length > 1_000_000) throw new Error("message too large");
    return out;
  }
}
