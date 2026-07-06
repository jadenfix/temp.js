const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function normalizeEncoding(encoding = "utf8") {
  return String(encoding).toLowerCase().replace("_", "-");
}

function utf8ToBytes(input) {
  if (globalThis.TextEncoder) {
    return new TextEncoder().encode(String(input));
  }
  const out = [];
  const value = String(input);
  for (let i = 0; i < value.length; i++) {
    let c = value.codePointAt(i);
    if (c > 0xffff) i++;
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 63),
        0x80 | ((c >> 6) & 63),
        0x80 | (c & 63),
      );
    }
  }
  return new Uint8Array(out);
}

function replacement() {
  return String.fromCharCode(0xfffd);
}

function utf8FromBytes(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const first = bytes[i++];
    if (first < 0x80) {
      out += String.fromCharCode(first);
      continue;
    }
    if (first >= 0xc2 && first < 0xe0 && i < bytes.length) {
      const second = bytes[i++];
      if ((second & 0xc0) === 0x80) {
        out += String.fromCharCode(((first & 31) << 6) | (second & 63));
      } else {
        out += replacement();
        i--;
      }
      continue;
    }
    if (first >= 0xe0 && first < 0xf0 && i + 1 < bytes.length) {
      const second = bytes[i++];
      const third = bytes[i++];
      const valid =
        (second & 0xc0) === 0x80 &&
        (third & 0xc0) === 0x80 &&
        !(first === 0xe0 && second < 0xa0) &&
        !(first === 0xed && second >= 0xa0);
      if (valid) {
        out += String.fromCharCode(
          ((first & 15) << 12) | ((second & 63) << 6) | (third & 63),
        );
      } else {
        out += replacement();
      }
      continue;
    }
    if (first >= 0xf0 && first < 0xf5 && i + 2 < bytes.length) {
      const second = bytes[i++];
      const third = bytes[i++];
      const fourth = bytes[i++];
      const valid =
        (second & 0xc0) === 0x80 &&
        (third & 0xc0) === 0x80 &&
        (fourth & 0xc0) === 0x80 &&
        !(first === 0xf0 && second < 0x90) &&
        !(first === 0xf4 && second >= 0x90);
      if (valid) {
        let code =
          ((first & 7) << 18) |
          ((second & 63) << 12) |
          ((third & 63) << 6) |
          (fourth & 63);
        code -= 0x10000;
        out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 1023));
      } else {
        out += replacement();
      }
      continue;
    }
    out += replacement();
  }
  return out;
}

function hexToBytes(input) {
  const clean = String(input).trim();
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hexFromBytes(bytes) {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function base64ToBytes(input) {
  const clean = String(input).replace(/[\r\n\t ]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const chunk = clean.slice(i, i + 4).padEnd(4, "=");
    const values = [...chunk].map((ch) => (ch === "=" ? -1 : BASE64.indexOf(ch)));
    const bits =
      ((values[0] & 63) << 18) |
      ((values[1] & 63) << 12) |
      (((values[2] < 0 ? 0 : values[2]) & 63) << 6) |
      ((values[3] < 0 ? 0 : values[3]) & 63);
    out.push((bits >> 16) & 255);
    if (values[2] >= 0) out.push((bits >> 8) & 255);
    if (values[3] >= 0) out.push(bits & 255);
  }
  return new Uint8Array(out);
}

function base64FromBytes(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const bits = (a << 16) | (b << 8) | c;
    out += BASE64[(bits >> 18) & 63];
    out += BASE64[(bits >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(bits >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? BASE64[bits & 63] : "=";
  }
  return out;
}

function bytesFrom(input, encoding) {
  if (typeof input === "string") {
    const enc = normalizeEncoding(encoding);
    if (enc === "utf8" || enc === "utf-8") return utf8ToBytes(input);
    if (enc === "hex") return hexToBytes(input);
    if (enc === "base64" || enc === "base64url") return base64ToBytes(input);
    if (enc === "latin1" || enc === "binary") {
      return Uint8Array.from(String(input), (ch) => ch.charCodeAt(0) & 255);
    }
    if (enc === "ascii") {
      return Uint8Array.from(String(input), (ch) => ch.charCodeAt(0) & 127);
    }
    throw new TypeError(`unsupported Buffer encoding: ${encoding}`);
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input == null) throw new TypeError("Buffer.from requires a value");
  return Uint8Array.from(input);
}

export class Buffer extends Uint8Array {
  static from(input, encoding) {
    return new Buffer(bytesFrom(input, encoding));
  }

  static alloc(size, fill = 0, encoding = "utf8") {
    const buffer = new Buffer(Number(size));
    if (typeof fill === "string") {
      const bytes = bytesFrom(fill, encoding);
      if (bytes.length > 0) {
        for (let i = 0; i < buffer.length; i++) buffer[i] = bytes[i % bytes.length];
      }
    } else {
      buffer.fill(fill);
    }
    return buffer;
  }

  static byteLength(input, encoding = "utf8") {
    return bytesFrom(input, encoding).byteLength;
  }

  static concat(list, totalLength) {
    if (!Array.isArray(list)) throw new TypeError("Buffer.concat requires an array");
    const length =
      totalLength ?? list.reduce((sum, item) => sum + Buffer.from(item).byteLength, 0);
    const out = new Buffer(length);
    let offset = 0;
    for (const item of list) {
      const bytes = Buffer.from(item);
      out.set(bytes.subarray(0, Math.max(0, length - offset)), offset);
      offset += bytes.byteLength;
      if (offset >= length) break;
    }
    return out;
  }

  static isBuffer(value) {
    return value instanceof Buffer;
  }

  toString(encoding = "utf8", start = 0, end = this.length) {
    const bytes = this.subarray(start, end);
    const enc = normalizeEncoding(encoding);
    if (enc === "utf8" || enc === "utf-8") return utf8FromBytes(bytes);
    if (enc === "hex") return hexFromBytes(bytes);
    if (enc === "base64") return base64FromBytes(bytes);
    if (enc === "latin1" || enc === "binary") {
      return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    }
    if (enc === "ascii") {
      return Array.from(bytes, (byte) => String.fromCharCode(byte & 127)).join("");
    }
    throw new TypeError(`unsupported Buffer encoding: ${encoding}`);
  }

  toJSON() {
    return { type: "Buffer", data: Array.from(this) };
  }
}

globalThis.Buffer ??= Buffer;

export default { Buffer };
