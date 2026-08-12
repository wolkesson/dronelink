import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TlsMaterial {
  key: string;
  cert: string;
  certFingerprint: string;
  keyPath: string;
  certPath: string;
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

// Tracks which provider+target pairing-cert.pem/pairing-key.pem were last issued for, so
// switching between mkcert and Tailscale (which write the same file paths) is detected as a
// change even when the target string alone is unchanged — otherwise the stale certificate from
// the previous provider would keep being served indefinitely.
function readMarker(markerPath: string): string {
  return existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : "";
}

function writeMarker(markerPath: string, marker: string): void {
  writeFileSync(markerPath, `${marker}\n`, "utf8");
}

export function ensureTlsMaterial(stateDir: string, tlsTarget: string): TlsMaterial {
  mkdirSync(stateDir, { recursive: true });

  const keyPath = join(stateDir, "pairing-key.pem");
  const certPath = join(stateDir, "pairing-cert.pem");
  const tlsTargetPath = join(stateDir, "pairing-cert-target.txt");
  const normalizedTlsTarget = normalizeTlsTarget(tlsTarget);
  const marker = `mkcert:${normalizedTlsTarget}`;

  const previousMarker = readMarker(tlsTargetPath);
  const shouldIssueCert = !existsSync(keyPath) || !existsSync(certPath) || previousMarker !== marker;

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

    writeMarker(tlsTargetPath, marker);
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
  const tlsTargetPath = join(stateDir, "pairing-cert-target.txt");

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
  writeMarker(tlsTargetPath, `tailscale:${normalizedTlsTarget}`);

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
