import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
export const FINGERPRINT_PATTERN = /^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/u;

export interface PairingBundle {
  sessionId: string;
  token: string;
  host: string;
  port: number;
  certFingerprint: string;
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

export interface TlsMaterial {
  key: string;
  cert: string;
  certFingerprint: string;
  keyPath: string;
  certPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function generateSessionId(): string {
  return randomUUID();
}

export function generateToken(): string {
  return randomBytes(16).toString("base64url");
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
    value.port <= 65535 &&
    typeof value.certFingerprint === "string" &&
    FINGERPRINT_PATTERN.test(value.certFingerprint)
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

function buildSubjectAltName(host: string): string {
  const entries = new Set<string>(["DNS:localhost", "IP:127.0.0.1"]);

  if (host.length > 0) {
    if (isIP(host) === 0) {
      entries.add(`DNS:${host}`);
    } else {
      entries.add(`IP:${host}`);
    }
  }

  return Array.from(entries).join(",");
}

export function ensureTlsMaterial(stateDir: string, host: string): TlsMaterial {
  mkdirSync(stateDir, { recursive: true });

  const keyPath = join(stateDir, "pairing-key.pem");
  const certPath = join(stateDir, "pairing-cert.pem");

  if (!existsSync(keyPath) || !existsSync(certPath)) {
    const args = [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "3650",
      "-subj",
      "/CN=localhost",
      "-addext",
      `subjectAltName=${buildSubjectAltName(host)}`,
    ];

    const result = spawnSync("openssl", args, {
      encoding: "utf8",
      stdio: "pipe",
    });

    if (result.status !== 0) {
      const details = result.stderr.trim() || result.stdout.trim() || "unknown openssl failure";
      throw new Error(`Failed to generate TLS certificate: ${details}`);
    }
  }

  const cert = readFileSync(certPath, "utf8");
  const key = readFileSync(keyPath, "utf8");
  const certFingerprint = new X509Certificate(cert).fingerprint256;

  return {
    key,
    cert,
    certFingerprint,
    keyPath,
    certPath,
  };
}
