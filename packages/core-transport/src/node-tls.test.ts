import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process before importing the module under test so spawnSync
// can be controlled per-test without subprocess side-effects.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

import { spawnSync } from "node:child_process";
import { ensureTailscaleTlsMaterial, ensureTlsMaterial } from "./node-tls.js";

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
