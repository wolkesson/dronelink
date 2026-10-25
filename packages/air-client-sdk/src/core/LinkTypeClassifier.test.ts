import { describe, expect, it } from "vitest";
import { encodeMspV1, encodeMspV2 } from "@dronelink/fc-msp";
import { LinkTypeClassifier } from "./LinkTypeClassifier.js";

function crsfFrame(): Uint8Array {
  const body = new Uint8Array([0x16, 0x00]);
  let crc = 0;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff;
  }
  return new Uint8Array([0xc8, 3, ...body, crc]);
}

describe("LinkTypeClassifier", () => {
  it("classifies valid MSP v1 and v2 response frames, including split input", () => {
    const v1 = new LinkTypeClassifier();
    expect(v1.push(encodeMspV1("response", 1, new Uint8Array([0, 1, 48])).subarray(0, 3), 1)).toBe("unknown");
    expect(v1.push(encodeMspV1("response", 1, new Uint8Array([0, 1, 48])).subarray(3), 2)).toBe("msp-v1");

    const v2 = new LinkTypeClassifier();
    expect(v2.push(encodeMspV2("response", 1, new Uint8Array([0, 1, 48])), 1)).toBe("msp-v2");
  });

  it("classifies MAVLink v1 and v2 packets", () => {
    const classifier = new LinkTypeClassifier();
    expect(classifier.push(new Uint8Array([0xfe, 0, 1, 1, 1, 0, 0, 0]), 1)).toBe("mavlink-v1");
    expect(classifier.push(new Uint8Array([0xfd, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0]), 2)).toBe("mavlink-v2");
  });

  it("validates CRSF checksums and leaves noise unknown", () => {
    expect(new LinkTypeClassifier().push(crsfFrame(), 1)).toBe("crsf");
    const classifier = new LinkTypeClassifier();
    expect(classifier.push(new Uint8Array([1, 2, 3, 4, 5]), 1)).toBe("unknown");
    expect(classifier.tick(2_001)).toBe("silent");
  });

  it("reports silence and resets its observation state", () => {
    const classifier = new LinkTypeClassifier(20);
    expect(classifier.tick(19)).toBe("unknown");
    expect(classifier.tick(20)).toBe("silent");
    classifier.push(new Uint8Array([1]), 30);
    expect(classifier.tick(49)).toBe("unknown");
    expect(classifier.tick(50)).toBe("silent");
    classifier.reset();
    expect(classifier.detectedType).toBe("unknown");
  });

  it("measures silence from begin(), not from clock zero", () => {
    const classifier = new LinkTypeClassifier(20);
    classifier.begin(1_000_000);
    expect(classifier.tick(1_000_019)).toBe("unknown");
    expect(classifier.tick(1_000_020)).toBe("silent");
  });
});
