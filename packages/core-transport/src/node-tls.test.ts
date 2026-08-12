import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process before importing the module under test so spawnSync
// can be controlled per-test without subprocess side-effects.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

import { spawnSync } from "node:child_process";
import { ensureTailscaleTlsMaterial, ensureTlsMaterial } from "./node-tls.js";

// A throwaway self-signed cert/key pair, only used so ensureTlsMaterial's
// X509Certificate parsing has something real to read back after a mocked
// "successful" mkcert/tailscale run.
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIC3TCCAcWgAwIBAgIUKeijUGrfVNV72aY1hOs/ENan77MwDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMdGVzdC5pbnZhbGlkMB4XDTI2MDgxMjE2MjM1MloXDTM2
MDgwOTE2MjM1MlowFzEVMBMGA1UEAwwMdGVzdC5pbnZhbGlkMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxhXE+lp9sMcXUf3yyX2SmOBU2dZckveSbow5
iNlAkhSLTtZi+c12K42rByliZWz4scNyR+p1WoPRWzc7QMY7myPzmXDV2YxYR42+
u1uL3jVNyUjwjcxqD/EjvBgWcixJCBMGV8c8ApmWvq1WhASWmz0rLHKEuGUw8El8
h0YEchSSHNp2f+lkd3QYvdT9RNRK1edZjBRxOCydU3zthCrIKvOI5eUfnIKjbBYq
F87ruqpfPD/wx9LifboSqfLCs6lpc1N3+VXhNov5ePPtIZJcSqC9zlGsA7E2XMhU
QH1PIKO6GboKNoOYR9Ef6rY2rT08bqlH00jyjSoZELbiShttUQIDAQABoyEwHzAd
BgNVHQ4EFgQUNIw1ovnUFIP03jfb1haAlUDKJF4wDQYJKoZIhvcNAQELBQADggEB
AC0qQcpvEF2xWNJXdsxLvQRp9GfVFWA7cs6mfBKAAAqUX9rGwuGRx9TSoY9vLm9S
UxNe/sUMTtuRRSDw8kocng8ETRO0uboRTlKuQ3SSOasG1EDZgKCbq7FrsOakj4u2
Le1xua/3Gp9NsYCVQKYRmXAMjavQSNZgrwHL5P0l60c0/RKtXxoLFE8fzKJ/GQBl
lbjtGGftH58Tib8xO4b25uQus9kbjWT6Dn38ZPKZzgkflXP91hY9CfPf4vGSaai2
Ose2BzzDexB7eUcJxlgOEFICkp94RdFiiTIfUQCJYEZ1yLpC/KuHL00mFiz1WPBU
nMcZDaGWm2lyWqp1V0XBKGU=
-----END CERTIFICATE-----
`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDGFcT6Wn2wxxdR
/fLJfZKY4FTZ1lyS95JujDmI2UCSFItO1mL5zXYrjasHKWJlbPixw3JH6nVag9Fb
NztAxjubI/OZcNXZjFhHjb67W4veNU3JSPCNzGoP8SO8GBZyLEkIEwZXxzwCmZa+
rVaEBJabPSsscoS4ZTDwSXyHRgRyFJIc2nZ/6WR3dBi91P1E1ErV51mMFHE4LJ1T
fO2EKsgq84jl5R+cgqNsFioXzuu6ql88P/DH0uJ9uhKp8sKzqWlzU3f5VeE2i/l4
8+0hklxKoL3OUawDsTZcyFRAfU8go7oZugo2g5hH0R/qtjatPTxuqUfTSPKNKhkQ
tuJKG21RAgMBAAECggEAQ6E4HP/bTQlUYXaSN4/rhs2EutEwzy6+rIasuBfwr09b
VsHkjgRDtdALFglfomBnso2XzYzzn0FFL972GIH15NyL9ZXsNXfwxhFTjvVNFkNd
uPzxwIALsEC04inZNAcBskOIlVydFQgqSxS0ZqOIZh0myeiZfrlx0YBNh4P0zZu1
B85pGz53MsuFV1kylX6ilIGv9Bpw54ylsMz8T6dkN1+eDfMP1U9FZ+Es+eSWN6FD
uwvtZhiAiT8CGXl/swF9n37DKOzoJsedIrb2rkdjcs3txFxMLlmnB/d7Ki5LtyA7
ADIXruSkf6F9jiL7ZbkQ9bqviNX2H/YcT56SG+3RTwKBgQD1VBt9p1XDq3ExMfb+
IvyGXAEKtXtRTKOBHTpfCAcxsG9eEc5bHdaXAZtX/tLh/+l6UhI0sbTm0mmKAF0C
4Uw0vMEwZf1QkaP1g1UA8jP45QNOUph1GWo+56vzqE/MT5afyJYskbF+59kSweR7
QvdPJV1hEUXHYoir/MTJzMAB/wKBgQDOs5Muqze4+A0hmZQw4a3BRWNBqpAHaFtz
qZh177zHmoNfesXUgJq63i1DYu1zCVeu/r4Ab2eMOXa+PEr5Xs6UclUVzgDuX4TR
BpTArunCzsKMrvBTY+u1StSGmwhkPzZYsdDyqr/J9YzBOTg6BoqoOXu17sr2+SI8
9yw2uQXwrwKBgClQwdR2guYSEF0FmiAQilCiW/aOu7bkXkDXSEZK1tNScF76RrNn
ogUKWzwFiURQUeSsv64qI1ogI2//QarDgI79HtfkxTV1YZRuSrl/EKug/d6J4G0Q
G6l+YKIHPXEeEjLUmB3nZ2oE57TV/IGZtIaat1AqlYLPoE6+ofGOTuPHAoGAc0Fg
XVJtVL9DmyumnQcJus31BYWUn/zJmZnEgGZ4LhhzDodHzjETlgUS2hNMcauQ7+vt
iBKWe3MDShoWeCwsJkwGM41VqZUrWt4/jZ06jTx68LUPHoCFyuX50UCbEkLJC/XC
m70oCfXYUVmVh41kPV8oIw8Or13FgJcWWUEcFdMCgYBLQG699TUrm80ri5Wh/y7p
SQw1UGtACTLoCUPzD4sFBhuzRWnSJswf2x1pIjTyVbyaQF7xs3ftejoH+Xzu4FKS
sfRSxca0Ni2DV879tTA0MPw3Nf8JCItQHo/huoEi2v421m5/vzgjbAOc1zCHEDSk
/vdnhILq7xCbHrKQ1S/7Kw==
-----END PRIVATE KEY-----
`;

const tempDirs: string[] = [];

afterEach(() => {
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.mocked(spawnSync).mockReset();
});

function makeTempDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "dronelink-pairing-test-"));
  tempDirs.push(dir);
  return dir;
}

const successResult = {
  pid: 0,
  output: [],
  stdout: "",
  stderr: "",
  status: 0,
  signal: null,
};

// Mimics the real mkcert binary's side effect: writing a cert/key pair to the
// -cert-file/-key-file paths it's invoked with.
function mockMkcertSuccess() {
  vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
    const argv = args as string[];
    writeFileSync(argv[1], TEST_CERT, "utf8");
    writeFileSync(argv[3], TEST_KEY, "utf8");
    return successResult;
  });
}

// Mimics `tailscale cert <target>`'s side effect: writing <target>.crt/.key
// into the invocation's cwd.
function mockTailscaleSuccess() {
  vi.mocked(spawnSync).mockImplementation((_cmd, args, options) => {
    const target = (args as string[])[1];
    const cwd = (options as { cwd: string }).cwd;
    writeFileSync(join(cwd, `${target}.crt`), TEST_CERT, "utf8");
    writeFileSync(join(cwd, `${target}.key`), TEST_KEY, "utf8");
    return successResult;
  });
}

describe("ensureTlsMaterial", () => {
  it("throws when mkcert is not found (spawn error)", () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      error: new Error("spawn mkcert ENOENT"),
    });

    expect(() => ensureTlsMaterial(makeTempDir(), "localhost")).toThrow(
      /Failed to generate TLS certificate with mkcert/,
    );
  });

  it("throws when mkcert exits with a non-zero status", () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "mkcert: root CA not installed — run 'mkcert -install' first",
      status: 1,
      signal: null,
    });

    expect(() => ensureTlsMaterial(makeTempDir(), "localhost")).toThrow(
      /mkcert: root CA not installed/,
    );
  });

  it("does not re-invoke mkcert on a second call with the same target", () => {
    mockMkcertSuccess();
    const dir = makeTempDir();

    ensureTlsMaterial(dir, "192.168.0.150");
    ensureTlsMaterial(dir, "192.168.0.150");

    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("re-invokes mkcert when the target changes", () => {
    mockMkcertSuccess();
    const dir = makeTempDir();

    ensureTlsMaterial(dir, "192.168.0.150");
    ensureTlsMaterial(dir, "192.168.0.151");

    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  // Regression test: pairing-cert.pem/pairing-key.pem are shared file paths between
  // ensureTlsMaterial and ensureTailscaleTlsMaterial. If a Tailscale-issued cert for
  // this exact target string is already on disk, switching back to mkcert must still
  // reissue — otherwise the stale Tailscale cert (wrong hostname/SAN) keeps being
  // served indefinitely even though mkcert mode is now active.
  it("re-invokes mkcert when the existing cert was issued by ensureTailscaleTlsMaterial for the same target", () => {
    const dir = makeTempDir();

    mockTailscaleSuccess();
    ensureTailscaleTlsMaterial(dir, "192.168.0.150");
    expect(spawnSync).toHaveBeenCalledTimes(1);

    mockMkcertSuccess();
    ensureTlsMaterial(dir, "192.168.0.150");

    expect(spawnSync).toHaveBeenCalledTimes(2);
  });
});

describe("ensureTailscaleTlsMaterial", () => {
  it("throws immediately when tlsTarget is localhost (not set by the caller)", () => {
    // No spawnSync mock needed — the guard fires before the subprocess call.
    expect(() => ensureTailscaleTlsMaterial(makeTempDir(), "localhost")).toThrow(
      /SIGNAL_TLS_TARGET/,
    );
  });

  it("throws immediately when tlsTarget is an empty string", () => {
    expect(() => ensureTailscaleTlsMaterial(makeTempDir(), "")).toThrow(
      /SIGNAL_TLS_TARGET/,
    );
  });

  it("throws when the tailscale CLI is not found (spawn error)", () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      error: new Error("spawn tailscale ENOENT"),
    });

    expect(() =>
      ensureTailscaleTlsMaterial(makeTempDir(), "pc-a.tailxxxx.ts.net"),
    ).toThrow(/Failed to obtain a Tailscale TLS certificate/);
  });

  it("throws when tailscale cert exits with a non-zero status", () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "not a tailnet member",
      status: 1,
      signal: null,
    });

    expect(() =>
      ensureTailscaleTlsMaterial(makeTempDir(), "pc-a.tailxxxx.ts.net"),
    ).toThrow(/not a tailnet member/);
  });
});
