import { describe, it, expect } from "vitest";
import {
  TOKEN_PATTERN,
  generateSessionId,
  generateToken,
  createPairingBundle,
  isPairingBundle,
  isPairingRequest,
  createPairingAcceptedMessage,
  type PairingBundle,
} from "./pairing.js";

function validBundle(): PairingBundle {
  return {
    sessionId: "session-1",
    token: generateToken(),
    host: "192.168.1.10",
    port: 5761,
  };
}

describe("generateSessionId", () => {
  it("returns a valid v4-style UUID", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  });

  it("returns a different value on each call", () => {
    expect(generateSessionId()).not.toBe(generateSessionId());
  });
});

describe("generateToken", () => {
  it("returns a 22-character token matching TOKEN_PATTERN", () => {
    const token = generateToken();
    expect(token).toHaveLength(22);
    expect(TOKEN_PATTERN.test(token)).toBe(true);
  });

  it("returns a different value on each call", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("createPairingBundle", () => {
  it("returns a shallow copy with the same field values", () => {
    const input = validBundle();
    const bundle = createPairingBundle(input);
    expect(bundle).toEqual(input);
    expect(bundle).not.toBe(input);
  });
});

describe("isPairingBundle", () => {
  it("accepts a well-formed bundle", () => {
    expect(isPairingBundle(validBundle())).toBe(true);
  });

  it("rejects non-object values", () => {
    expect(isPairingBundle(null)).toBe(false);
    expect(isPairingBundle(undefined)).toBe(false);
    expect(isPairingBundle("not an object")).toBe(false);
    expect(isPairingBundle(42)).toBe(false);
  });

  it("rejects a missing field", () => {
    const { sessionId: _sessionId, ...rest } = validBundle();
    expect(isPairingBundle(rest)).toBe(false);
  });

  it("rejects an empty sessionId", () => {
    expect(isPairingBundle({ ...validBundle(), sessionId: "" })).toBe(false);
  });

  it("rejects a token that doesn't match TOKEN_PATTERN", () => {
    expect(isPairingBundle({ ...validBundle(), token: "too-short" })).toBe(false);
  });

  it("rejects an empty host", () => {
    expect(isPairingBundle({ ...validBundle(), host: "" })).toBe(false);
  });

  it("rejects a non-integer port", () => {
    expect(isPairingBundle({ ...validBundle(), port: 5761.5 })).toBe(false);
  });

  it("rejects a port below the valid range", () => {
    expect(isPairingBundle({ ...validBundle(), port: 0 })).toBe(false);
  });

  it("rejects a port above the valid range", () => {
    expect(isPairingBundle({ ...validBundle(), port: 65536 })).toBe(false);
  });

  it("accepts the boundary ports 1 and 65535", () => {
    expect(isPairingBundle({ ...validBundle(), port: 1 })).toBe(true);
    expect(isPairingBundle({ ...validBundle(), port: 65535 })).toBe(true);
  });
});

describe("isPairingRequest", () => {
  function validRequest(): { type: "pair"; sessionId: string; token: string } {
    return { type: "pair", sessionId: "session-1", token: generateToken() };
  }

  it("accepts a well-formed pairing request", () => {
    expect(isPairingRequest(validRequest())).toBe(true);
  });

  it("rejects non-object values", () => {
    expect(isPairingRequest(null)).toBe(false);
    expect(isPairingRequest([])).toBe(false);
  });

  it("rejects a wrong type discriminator", () => {
    expect(isPairingRequest({ ...validRequest(), type: "pairing-accepted" })).toBe(false);
  });

  it("rejects an empty sessionId", () => {
    expect(isPairingRequest({ ...validRequest(), sessionId: "" })).toBe(false);
  });

  it("rejects a token that doesn't match TOKEN_PATTERN", () => {
    expect(isPairingRequest({ ...validRequest(), token: "" })).toBe(false);
  });
});

describe("createPairingAcceptedMessage", () => {
  it("builds a pairing-accepted message for the given session ID", () => {
    expect(createPairingAcceptedMessage("session-42")).toEqual({
      type: "pairing-accepted",
      sessionId: "session-42",
    });
  });
});
