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
      const details = result.stderr.trim() || result.stdout.trim() || "unknown mkcert failure";
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

/**
 * Obtains a publicly-trusted TLS certificate from Tailscale (via `tailscale cert`) instead
 * of mkcert. Requires MagicDNS and HTTPS Certificates to be enabled for the tailnet (admin
 * console), the `tailscale` CLI to be on PATH, and this machine to be logged into the
 * tailnet. `tlsTarget` must be this machine's MagicDNS name (e.g. `pc-a.tailxxxx.ts.net`),
 * not an IP — the certificate is issued for that hostname, so clients must connect using it
 * or TLS hostname validation will fail.
 *
 * Safe to call on every startup: `tailscale cert` only actually re-issues from Let's
 * Encrypt when the existing certificate is missing or close to expiry.
 */
export function ensureTailscaleTlsMaterial(stateDir: string, tlsTarget: string): TlsMaterial {
  mkdirSync(stateDir, { recursive: true });

  const normalizedTlsTarget = normalizeTlsTarget(tlsTarget);
  if (normalizedTlsTarget === "localhost") {
    throw new Error(
      "TLS_PROVIDER=tailscale requires SIGNAL_TLS_TARGET to be set to this machine's MagicDNS name " +
        "(e.g. pc-a.tailxxxx.ts.net), not the default 'localhost'.",
    );
  }

  const keyPath = join(stateDir, "pairing-key.pem");
  const certPath = join(stateDir, "pairing-cert.pem");

  // `tailscale cert <domain>` writes <domain>.crt and <domain>.key into the current working
  // directory. Run it with cwd set to stateDir, then copy the result to the fixed
  // pairing-cert.pem/pairing-key.pem paths the rest of this module expects.
  const result = spawnSync("tailscale", ["cert", normalizedTlsTarget], {
    cwd: stateDir,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.error) {
    throw new Error(
      `Failed to obtain a Tailscale TLS certificate: ${result.error.message}. ` +
        "Ensure the 'tailscale' CLI is on PATH and this machine is logged into the tailnet ('tailscale status').",
    );
  }

  if (result.status !== 0) {
    const details =
      (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || "unknown tailscale cert failure";
    throw new Error(
      `Failed to obtain a Tailscale TLS certificate: ${details}. ` +
        "Confirm MagicDNS and HTTPS Certificates are enabled for this tailnet in the admin console, " +
        `and that ${normalizedTlsTarget} matches this machine's actual MagicDNS name.`,
    );
  }

  const issuedCertPath = join(stateDir, `${normalizedTlsTarget}.crt`);
  const issuedKeyPath = join(stateDir, `${normalizedTlsTarget}.key`);

  if (!existsSync(issuedCertPath) || !existsSync(issuedKeyPath)) {
    throw new Error(
      `tailscale cert reported success but expected output files were not found at ${issuedCertPath} / ${issuedKeyPath}.`,
    );
  }

  writeFileSync(certPath, readFileSync(issuedCertPath, "utf8"), "utf8");
  writeFileSync(keyPath, readFileSync(issuedKeyPath, "utf8"), "utf8");

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
