export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

function bytesToBase64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index];
    const byte1 = bytes[index + 1] ?? 0;
    const byte2 = bytes[index + 2] ?? 0;
    const combined = (byte0 << 16) | (byte1 << 8) | byte2;

    output += alphabet[(combined >> 18) & 0x3f];
    output += alphabet[(combined >> 12) & 0x3f];

    if (index + 1 < bytes.length) {
      output += alphabet[(combined >> 6) & 0x3f];
    }

    if (index + 2 < bytes.length) {
      output += alphabet[combined & 0x3f];
    }
  }

  return output;
}

export interface PairingBundle {
  sessionId: string;
  token: string;
  host: string;
  port: number;
}

export interface PairingRequest {
  type: "pair";
  sessionId: string;
  token: string;
}

export interface PairingAcceptedMessage {
  type: "pairing-accepted";
  sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function generateSessionId(): string {
  return globalThis.crypto.randomUUID();
}

export function generateToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function createPairingBundle(input: PairingBundle): PairingBundle {
  return { ...input };
}

export function isPairingBundle(value: unknown): value is PairingBundle {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.token === "string" &&
    TOKEN_PATTERN.test(value.token) &&
    typeof value.host === "string" &&
    value.host.length > 0 &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65535
  );
}

export function isPairingRequest(value: unknown): value is PairingRequest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.type === "pair" &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.token === "string" &&
    TOKEN_PATTERN.test(value.token)
  );
}

export function createPairingAcceptedMessage(sessionId: string): PairingAcceptedMessage {
  return {
    type: "pairing-accepted",
    sessionId,
  };
}
