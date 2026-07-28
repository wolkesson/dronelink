import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  if (typeof value.certFingerprint !== "string") {
    return false;
  }

  const hasFingerprint = value.certFingerprint === "" || FINGERPRINT_PATTERN.test(value.certFingerprint);

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
    hasFingerprint
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

function normalizeTlsTarget(value: string): string {
  const target = value.trim();
  return target.length > 0 ? target : "localhost";
}

function getMkcertHosts(tlsTarget: string): string[] {
  const hosts = new Set<string>(["localhost", "127.0.0.1"]);
  hosts.add(tlsTarget);
  return Array.from(hosts);
}

export function ensureTlsMaterial(stateDir: string, tlsTarget: string): TlsMaterial {
  mkdirSync(stateDir, { recursive: true });

  const keyPath = join(stateDir, "pairing-key.pem");
  const certPath = join(stateDir, "pairing-cert.pem");
  const tlsTargetPath = join(stateDir, "pairing-cert-target.txt");
  const normalizedTlsTarget = normalizeTlsTarget(tlsTarget);

  const previousTlsTarget = existsSync(tlsTargetPath) ? readFileSync(tlsTargetPath, "utf8").trim() : "";
  const shouldIssueCert =
    !existsSync(keyPath) || !existsSync(certPath) || previousTlsTarget !== normalizedTlsTarget;

  if (shouldIssueCert) {
    const result = spawnSync(
      "mkcert",
      ["-cert-file", certPath, "-key-file", keyPath, ...getMkcertHosts(normalizedTlsTarget)],
      {
        encoding: "utf8",
        stdio: "pipe",
      },
    );

    if (result.error) {
      throw new Error(
        `Failed to generate TLS certificate with mkcert: ${result.error.message}. Ensure mkcert is installed and run 'mkcert -install' once.`,
      );
    }

    if (result.status !== 0) {
      const details = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || "unknown mkcert failure";
      throw new Error(`Failed to generate TLS certificate with mkcert: ${details}`);
    }

    writeFileSync(tlsTargetPath, `${normalizedTlsTarget}\n`, "utf8");
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
