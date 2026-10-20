import { describe, it, expect } from "vitest";
import { MspParser, crc8DvbS2, encodeMspRequest, encodeMspV1, encodeMspV2, type MspFrame } from "./framing.js";

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)));

function parseAll(...chunks: Uint8Array[]): { frames: MspFrame[]; parser: MspParser } {
  const parser = new MspParser();
  const frames = chunks.flatMap((chunk) => parser.push(chunk));
  return { frames, parser };
}

/** Deterministic PRNG (mulberry32) so fuzz failures reproduce. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("crc8DvbS2", () => {
  it("matches the CRC-8/DVB-S2 check value", () => {
    expect(crc8DvbS2(ascii("123456789"))).toBe(0xbc);
  });
});

describe("encoders", () => {
  it("encodes a v1 request with an xor checksum", () => {
    expect([...encodeMspV1("request", 1)]).toEqual([0x24, 0x4d, 0x3c, 0, 1, 1]);
    expect([...encodeMspV1("response", 2, ascii("BTFL"))]).toEqual([
      0x24, 0x4d, 0x3e, 4, 2, ...ascii("BTFL"), 4 ^ 2 ^ 0x42 ^ 0x54 ^ 0x46 ^ 0x4c,
    ]);
  });

  it("switches to a jumbo frame for payloads of 255 bytes or more", () => {
    const frame = encodeMspV1("response", 116, new Uint8Array(300).fill(0x41));
    expect([...frame.subarray(0, 7)]).toEqual([0x24, 0x4d, 0x3e, 0xff, 116, 300 & 0xff, 300 >> 8]);
    expect(frame.length).toBe(7 + 300 + 1);
    expect(encodeMspV1("response", 116, new Uint8Array(254)).length).toBe(5 + 254 + 1);
  });

  it("encodes a v2 frame with flags and a crc8 checksum", () => {
    const frame = encodeMspV2("request", 0x1234, bytes(9), 0x01);
    expect([...frame.subarray(0, 8)]).toEqual([0x24, 0x58, 0x3c, 0x01, 0x34, 0x12, 1, 0]);
    expect(frame[frame.length - 1]).toBe(crc8DvbS2(frame.subarray(3, frame.length - 1)));
  });

  it("picks v1 for byte-sized commands and v2 above 255", () => {
    expect(encodeMspRequest(1)[1]).toBe(0x4d);
    expect(encodeMspRequest(0x1001)[1]).toBe(0x58);
    expect(encodeMspRequest(1, undefined, 2)[1]).toBe(0x58);
  });

  it("rejects out-of-range commands, flags and payloads", () => {
    expect(() => encodeMspV1("request", 256)).toThrow(RangeError);
    expect(() => encodeMspV1("request", -1)).toThrow(RangeError);
    expect(() => encodeMspV1("request", 1, new Uint8Array(0x10000))).toThrow(RangeError);
    expect(() => encodeMspV2("request", 0x10000)).toThrow(RangeError);
    expect(() => encodeMspV2("request", 1, undefined, 256)).toThrow(RangeError);
    expect(() => encodeMspV2("request", 1, new Uint8Array(0x10000))).toThrow(RangeError);
    expect(() => encodeMspV2("request", 1.5)).toThrow(RangeError);
  });
});

describe("MspParser", () => {
  it("round-trips v1, jumbo v1 and v2 frames in every direction", () => {
    const sent = [
      encodeMspV1("request", 105),
      encodeMspV1("response", 2, ascii("BTFL")),
      encodeMspV1("error", 20),
      encodeMspV1("response", 116, new Uint8Array(300).fill(0x3b)),
      encodeMspV2("response", 150, bytes(1, 2, 3), 0x01),
    ];
    const { frames, parser } = parseAll(...sent);
    expect(frames.map((f) => [f.version, f.direction, f.command, f.flags, f.payload.length])).toEqual([
      [1, "request", 105, 0, 0],
      [1, "response", 2, 0, 4],
      [1, "error", 20, 0, 0],
      [1, "response", 116, 0, 300],
      [2, "response", 150, 1, 3],
    ]);
    expect(String.fromCharCode(...frames[1].payload)).toBe("BTFL");
    expect(parser.stats).toEqual({ frames: 5, checksumErrors: 0, oversizeFrames: 0, discardedBytes: 0 });
    expect(parser.pendingBytes).toBe(0);
  });

  it("reassembles frames delivered one byte at a time", () => {
    const stream = new Uint8Array([
      ...encodeMspV1("response", 116, new Uint8Array(260)),
      ...encodeMspV2("response", 7, bytes(5)),
    ]);
    const parser = new MspParser();
    const frames: MspFrame[] = [];
    for (const byte of stream) frames.push(...parser.push(bytes(byte)));
    expect(frames.map((f) => f.command)).toEqual([116, 7]);
  });

  it("waits for the jumbo size and the v2 header before deciding", () => {
    const jumbo = encodeMspV1("response", 116, new Uint8Array(256));
    const parser = new MspParser();
    expect(parser.push(jumbo.subarray(0, 6))).toEqual([]);
    expect(parser.pendingBytes).toBe(6);
    expect(parser.push(jumbo.subarray(6))).toHaveLength(1);

    const v2 = encodeMspV2("response", 1, bytes(1));
    expect(parser.push(v2.subarray(0, 7))).toEqual([]);
    expect(parser.push(v2.subarray(7))).toHaveLength(1);
  });

  it("skips noise and other protocols between frames", () => {
    const mavlink = bytes(0xfd, 9, 0, 0, 0, 1, 1, 0, 0, 0);
    const { frames, parser } = parseAll(
      ascii("noise"),
      encodeMspV1("response", 1, bytes(0, 1, 48)),
      mavlink,
      ascii("$Q<"),
      encodeMspV1("response", 3),
    );
    expect(frames.map((f) => f.command)).toEqual([1, 3]);
    expect(parser.stats.discardedBytes).toBe(5 + mavlink.length + 3);
  });

  it("drops a frame with a bad checksum and recovers a frame hidden inside it", () => {
    const good = encodeMspV1("response", 2, ascii("BTFL"));
    // A corrupt header whose announced payload swallows the real frame that follows.
    const corrupt = bytes(0x24, 0x4d, 0x3e, good.length, 9, 0, 0);
    const { frames, parser } = parseAll(corrupt, good, bytes(0, 0, 0, 0, 0, 0, 0, 0));
    expect(frames.map((f) => f.command)).toEqual([2]);
    expect(parser.stats.checksumErrors).toBe(1);

    const badV2 = encodeMspV2("response", 1, bytes(1, 2));
    badV2[badV2.length - 1] ^= 0xff;
    const second = parseAll(badV2, encodeMspV2("response", 5));
    expect(second.frames.map((f) => f.command)).toEqual([5]);
    expect(second.parser.stats.checksumErrors).toBe(1);
  });

  it("treats frames announcing an oversize payload as garbage", () => {
    const parser = new MspParser({ maxPayloadSize: 64 });
    const frames = parser.push(
      new Uint8Array([
        ...encodeMspV1("response", 116, new Uint8Array(300)),
        ...encodeMspV2("response", 1, new Uint8Array(100)),
        ...encodeMspV1("response", 1, bytes(0, 1, 48)),
      ]),
    );
    expect(frames.map((f) => f.command)).toEqual([1]);
    expect(parser.stats.oversizeFrames).toBe(2);
  });

  it("accepts Betaflight's largest flight-control reply under the default limit", () => {
    const { frames } = parseAll(encodeMspV1("response", 116, new Uint8Array(1024)));
    expect(frames).toHaveLength(1);
    const over = parseAll(encodeMspV1("response", 116, new Uint8Array(1025)));
    expect(over.frames).toHaveLength(0);
    expect(over.parser.stats.oversizeFrames).toBe(1);
  });

  it("unwraps v2 frames tunnelled in v1", () => {
    const inner = encodeMspV2("response", 0x1003, bytes(7, 8)).slice(3);
    const { frames } = parseAll(encodeMspV1("response", 0xff, inner));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ version: 2, direction: "response", command: 0x1003, flags: 0 });
    expect([...frames[0].payload]).toEqual([7, 8]);
  });

  it("counts malformed tunnelled v2 frames as checksum errors", () => {
    const inner = encodeMspV2("response", 0x1003, bytes(7, 8)).slice(3);
    const badCrc = inner.slice();
    badCrc[badCrc.length - 1] ^= 1;
    const badLength = inner.slice();
    badLength[3] = 9;
    const { frames, parser } = parseAll(
      encodeMspV1("response", 0xff, badCrc),
      encodeMspV1("response", 0xff, badLength),
      encodeMspV1("response", 0xff, bytes(1, 2)),
      encodeMspV1("response", 1),
    );
    expect(frames.map((f) => f.command)).toEqual([1]);
    expect(parser.stats.checksumErrors).toBe(3);
  });

  it("keeps an incomplete frame across pushes and discards it on reset()", () => {
    const parser = new MspParser();
    parser.push(encodeMspV1("response", 2, ascii("BTFL")).subarray(0, 6));
    expect(parser.pendingBytes).toBe(6);
    parser.reset();
    expect(parser.pendingBytes).toBe(0);
    expect(parser.push(new Uint8Array(0))).toEqual([]);
  });

  it("never throws on random input and recovers frames spliced into it", () => {
    const random = rng(0x5eed);
    const markerBytes = [0x24, 0x4d, 0x58, 0x3c, 0x3e, 0x21, 0xff];
    for (let round = 0; round < 300; round++) {
      // Bias towards MSP marker bytes so the parser sees plenty of near-frames.
      const noise = Array.from({ length: Math.floor(random() * 400) }, () =>
        random() < 0.2 ? markerBytes[Math.floor(random() * markerBytes.length)] : Math.floor(random() * 256),
      );
      const parser = new MspParser({ maxPayloadSize: 256 });
      const frames: MspFrame[] = [];
      let offset = 0;
      while (offset < noise.length) {
        const size = 1 + Math.floor(random() * 32);
        expect(() => frames.push(...parser.push(new Uint8Array(noise.slice(offset, offset + size))))).not.toThrow();
        offset += size;
      }
      // A fake header left pending by the noise may hold the frame back, but once enough
      // bytes follow to settle it (no '$' in the filler), the frame must come out intact.
      frames.push(...parser.push(encodeMspV2("response", 0x4242, ascii(`round ${round}`))));
      frames.push(...parser.push(new Uint8Array(256 + 16)));
      const found = frames.filter((f) => f.command === 0x4242 && f.version === 2);
      expect(found).toHaveLength(1);
      expect(String.fromCharCode(...found[0].payload)).toBe(`round ${round}`);
    }
  });
});
