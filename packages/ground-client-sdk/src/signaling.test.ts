// Exercises signaling.ts's own plumbing -- HTTP GUI asset serving, WebSocket
// upgrade routing, the pairing handshake's failure branches, post-auth message
// dispatch, and start()/getPairingBundle()/close() -- in isolation from real
// WebRTC negotiation. index.test.ts already covers a few of these paths
// end-to-end against the real webrtc.js; this file mocks "./webrtc.js" so the
// dispatch and error-handling branches that require a controlled reply (or
// that real negotiation can't deterministically reach) are directly testable.
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { WebSocket } from "ws";
import { createSignalingServer } from "./signaling.js";

const { webrtcMock } = vi.hoisted(() => ({
  webrtcMock: {
    setStateDir: vi.fn(),
    handleSignalingMessage: vi.fn(),
    handleGuiSignalingMessage: vi.fn(),
    handleSocketClose: vi.fn(),
    handleGuiSocketClose: vi.fn(),
  },
}));

vi.mock("./webrtc.js", () => webrtcMock);

type SignalingServerRuntime = ReturnType<typeof createSignalingServer>;
type SignalingServerOptions = Parameters<typeof createSignalingServer>[0];
type GuiAssets = NonNullable<SignalingServerOptions["guiAssets"]>;

// ---------------------------------------------------------------------------
// Helpers (mirrors index.test.ts's setup, kept self-contained in this file)
// ---------------------------------------------------------------------------

const runtimes: SignalingServerRuntime[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

interface TestLogger {
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

function makeLogger(): TestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function seedTlsMaterial(stateDir: string): void {
  const keyPath = join(stateDir, "pairing-key.pem");
  const certPath = join(stateDir, "pairing-cert.pem");
  const tlsTargetPath = join(stateDir, "pairing-cert-target.txt");
  // Explicit minimal config avoids the system openssl.cnf's default [req]
  // x509_extensions (v3_ca), which some Windows OpenSSL distributions ship
  // with a broken authorityKeyIdentifier value (keyid:nonss).
  const opensslConfigPath = join(stateDir, "openssl.cnf");
  writeFileSync(
    opensslConfigPath,
    "[req]\ndistinguished_name = req_distinguished_name\n[req_distinguished_name]\n",
    "utf8",
  );
  const result = spawnSync(
    "openssl",
    [
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
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-config",
      opensslConfigPath,
    ],
    { encoding: "utf8", stdio: "pipe" },
  );

  if (result.status !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || "unknown openssl failure";
    throw new Error(`Failed to seed TLS certificate for tests: ${details}`);
  }

  writeFileSync(tlsTargetPath, "mkcert:localhost\n", "utf8");
}

function createRuntime(
  overrides: Partial<SignalingServerOptions> = {},
  logger: TestLogger = makeLogger(),
): { runtime: SignalingServerRuntime; logger: TestLogger; stateDir: string } {
  const stateDir = mkdtempSync(resolve(tmpdir(), "dronelink-ground-sig-test-"));
  tempDirs.push(stateDir);
  seedTlsMaterial(stateDir);

  const runtime = createSignalingServer({
    port: 0,
    host: "127.0.0.1",
    stateDir,
    handshakeTimeoutMs: 200,
    logger: logger as unknown as SignalingServerOptions["logger"],
    ...overrides,
  });

  runtimes.push(runtime);
  return { runtime, logger, stateDir };
}

function openClient(url: string): Promise<WebSocket> {
  return new Promise((resolveClient, reject) => {
    const socket = new WebSocket(url, { rejectUnauthorized: false });
    socket.once("open", () => resolveClient(socket));
    socket.once("error", reject);
  });
}

function waitForMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolveMessage) => {
    socket.once("message", (data) => resolveMessage(data.toString()));
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolveClose) => {
    socket.once("close", (code, reason) => resolveClose({ code, reason: reason.toString() }));
  });
}

interface HttpResult {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function httpsGet(url: string): Promise<HttpResult> {
  return new Promise((resolveResult, reject) => {
    const req = https.get(url, { rejectUnauthorized: false }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () =>
        resolveResult({ statusCode: res.statusCode ?? 0, headers: res.headers, body }),
      );
    });
    req.on("error", reject);
  });
}

async function pairedSocket(
  overrides: Partial<SignalingServerOptions> = {},
  logger: TestLogger = makeLogger(),
): Promise<{
  runtime: SignalingServerRuntime;
  socket: WebSocket;
  bundle: Awaited<ReturnType<SignalingServerRuntime["start"]>>;
  logger: TestLogger;
}> {
  const { runtime } = createRuntime(overrides, logger);
  const bundle = await runtime.start();
  const socket = await openClient(`wss://${bundle.host}:${bundle.port}`);
  socket.send(JSON.stringify({ type: "pair", sessionId: bundle.sessionId, token: bundle.token }));
  await waitForMessage(socket); // consume the pairing-accepted reply
  return { runtime, socket, bundle, logger };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSignalingServer: HTTP GUI asset serving", () => {
  it("returns 404 for /gui when no guiAssets are configured", async () => {
    const { runtime } = createRuntime();
    const bundle = await runtime.start();

    const res = await httpsGet(`https://${bundle.host}:${bundle.port}/gui`);

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.body).toBe("Ground GUI assets are unavailable.\n");
  });

  it("returns 404 for /gui-client.js when no guiAssets are configured", async () => {
    const { runtime } = createRuntime();
    const bundle = await runtime.start();

    const res = await httpsGet(`https://${bundle.host}:${bundle.port}/gui-client.js`);

    expect(res.statusCode).toBe(404);
  });

  it("serves the GUI page and client script when guiAssets are configured", async () => {
    const guiAssets: GuiAssets = { page: "<html>gui</html>", clientScript: "console.log('gui');" };
    const { runtime } = createRuntime({ guiAssets });
    const bundle = await runtime.start();

    const page = await httpsGet(`https://${bundle.host}:${bundle.port}/gui`);
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.body).toBe(guiAssets.page);

    const script = await httpsGet(`https://${bundle.host}:${bundle.port}/gui-client.js`);
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(script.body).toBe(guiAssets.clientScript);
  });

  it("serves the default plaintext response for any other path", async () => {
    const { runtime } = createRuntime();
    const bundle = await runtime.start();

    const res = await httpsGet(`https://${bundle.host}:${bundle.port}/anything-else`);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.body).toBe("DroneLink signaling endpoint\n");
  });
});

describe("createSignalingServer: WebSocket upgrade routing", () => {
  it("destroys the underlying socket for an unrecognized upgrade path", async () => {
    const { runtime } = createRuntime();
    const bundle = await runtime.start();

    const ws = new WebSocket(`wss://${bundle.host}:${bundle.port}/unknown-path`, {
      rejectUnauthorized: false,
    });
    const outcome = await new Promise<string>((resolveOutcome) => {
      ws.once("error", () => resolveOutcome("error"));
      ws.once("close", () => resolveOutcome("close"));
    });

    expect(["error", "close"]).toContain(outcome);
  });
});

describe("createSignalingServer: pairing handshake failures", () => {
  it("closes with 'invalid auth payload' when the first message is not valid JSON", async () => {
    const { runtime } = createRuntime();
    const bundle = await runtime.start();
    const socket = await openClient(`wss://${bundle.host}:${bundle.port}`);

    socket.send("not json");

    await expect(waitForClose(socket)).resolves.toEqual({
      code: 1008,
      reason: "invalid auth payload",
    });
  });

  it("closes with 'token required' when the first message is not a pairing request", async () => {
    const { runtime } = createRuntime();
    const bundle = await runtime.start();
    const socket = await openClient(`wss://${bundle.host}:${bundle.port}`);

    socket.send(JSON.stringify({ type: "pair" })); // missing sessionId/token

    await expect(waitForClose(socket)).resolves.toEqual({
      code: 1008,
      reason: "token required",
    });
  });

  it("closes with 'invalid session id' when the sessionId does not match", async () => {
    const { runtime } = createRuntime();
    const bundle = await runtime.start();
    const socket = await openClient(`wss://${bundle.host}:${bundle.port}`);

    socket.send(JSON.stringify({ type: "pair", sessionId: "wrong-session", token: bundle.token }));

    await expect(waitForClose(socket)).resolves.toEqual({
      code: 1008,
      reason: "invalid session id",
    });
  });
});

describe("createSignalingServer: post-auth message dispatch (main channel)", () => {
  it("warns and does not dispatch when a post-auth message is malformed JSON", async () => {
    const { socket, logger } = await pairedSocket();

    socket.send("not json");

    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith("Received malformed signaling message after auth"),
    );
    expect(webrtcMock.handleSignalingMessage).not.toHaveBeenCalled();
    socket.close();
  });

  it("dispatches a valid post-auth message to handleSignalingMessage and forwards its reply", async () => {
    webrtcMock.handleSignalingMessage.mockImplementation(
      (msg: unknown, reply: (m: unknown) => void) => {
        reply({ type: "echo", received: msg });
      },
    );
    const { socket } = await pairedSocket();

    socket.send(JSON.stringify({ type: "offer", sdp: "v=0" }));

    await expect(waitForMessage(socket)).resolves.toBe(
      JSON.stringify({ type: "echo", received: { type: "offer", sdp: "v=0" } }),
    );
    expect(webrtcMock.handleSignalingMessage).toHaveBeenCalledWith(
      { type: "offer", sdp: "v=0" },
      expect.any(Function),
      false,
    );
    socket.close();
  });

  it("calls handleSocketClose when an authenticated socket disconnects", async () => {
    const { socket } = await pairedSocket();

    socket.close();

    await vi.waitFor(() => expect(webrtcMock.handleSocketClose).toHaveBeenCalledTimes(1));
  });

  it("does not call handleSocketClose when a socket disconnects before authenticating", async () => {
    const { runtime } = createRuntime({ handshakeTimeoutMs: 10_000 });
    const bundle = await runtime.start();
    const socket = await openClient(`wss://${bundle.host}:${bundle.port}`);

    socket.close();
    await new Promise((r) => setTimeout(r, 30));

    expect(webrtcMock.handleSocketClose).not.toHaveBeenCalled();
  });
});

describe("createSignalingServer: post-auth message dispatch (GUI channel)", () => {
  it("warns and does not dispatch when a GUI message is malformed JSON", async () => {
    const logger = makeLogger();
    const { runtime } = createRuntime({}, logger);
    const bundle = await runtime.start();
    const socket = await openClient(`wss://${bundle.host}:${bundle.port}/gui-signaling`);

    socket.send("not json");

    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith("Received malformed GUI signaling message"),
    );
    expect(webrtcMock.handleGuiSignalingMessage).not.toHaveBeenCalled();
    socket.close();
  });

  it("dispatches a valid GUI message to handleGuiSignalingMessage and forwards its reply", async () => {
    webrtcMock.handleGuiSignalingMessage.mockImplementation(
      (msg: unknown, reply: (m: unknown) => void) => {
        reply({ type: "echo", received: msg });
      },
    );
    const { runtime } = createRuntime();
    const bundle = await runtime.start();
    const socket = await openClient(`wss://${bundle.host}:${bundle.port}/gui-signaling`);

    socket.send(JSON.stringify({ type: "offer", sdp: "v=0" }));

    await expect(waitForMessage(socket)).resolves.toBe(
      JSON.stringify({ type: "echo", received: { type: "offer", sdp: "v=0" } }),
    );
    expect(webrtcMock.handleGuiSignalingMessage).toHaveBeenCalledWith(
      { type: "offer", sdp: "v=0" },
      expect.any(Function),
      false,
    );
    socket.close();
  });

  it("calls handleGuiSocketClose when the GUI socket disconnects", async () => {
    const { runtime } = createRuntime();
    const bundle = await runtime.start();
    const socket = await openClient(`wss://${bundle.host}:${bundle.port}/gui-signaling`);

    socket.close();

    await vi.waitFor(() => expect(webrtcMock.handleGuiSocketClose).toHaveBeenCalledTimes(1));
  });
});

describe("createSignalingServer: defaults", () => {
  it("uses 'localhost' as the default host when none is provided", async () => {
    const { runtime } = createRuntime({ host: undefined });
    const bundle = await runtime.start();

    expect(bundle.host).toBe("localhost");
    const socket = await openClient(`wss://localhost:${bundle.port}`);
    socket.close();
  });

  it("uses console as the default logger when none is provided", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { runtime } = createRuntime({ logger: undefined });
    const bundle = await runtime.start();
    const socket = await openClient(`wss://${bundle.host}:${bundle.port}`);

    await vi.waitFor(() => expect(logSpy).toHaveBeenCalledWith("Signaling client connected"));
    socket.close();
  });
});

describe("createSignalingServer: start()", () => {
  it("rejects when the port is already bound by another server", async () => {
    const { runtime: first } = createRuntime();
    const firstBundle = await first.start();

    const { runtime: second } = createRuntime({ port: firstBundle.port });

    await expect(second.start()).rejects.toThrow();
  });
});

describe("createSignalingServer: getPairingBundle", () => {
  it("throws before start() has been called", () => {
    const { runtime } = createRuntime();

    expect(() => runtime.getPairingBundle()).toThrow(
      "Signaling server has not started yet.",
    );
  });

  it("returns the same bundle start() resolved with", async () => {
    const { runtime } = createRuntime();

    const started = await runtime.start();

    expect(runtime.getPairingBundle()).toEqual(started);
  });
});

describe("createSignalingServer: close()", () => {
  it("rejects when the WebSocket signaling server fails to close", async () => {
    const { runtime } = createRuntime();
    await runtime.start();
    await new Promise<void>((r) => runtime.wss.close(() => r()));

    await expect(runtime.close()).rejects.toThrow();
  });

  it("rejects when the GUI WebSocket server fails to close", async () => {
    const { runtime } = createRuntime();
    await runtime.start();
    await new Promise<void>((r) => runtime.guiWss.close(() => r()));

    await expect(runtime.close()).rejects.toThrow();
  });

  it("rejects when the HTTPS server fails to close", async () => {
    const { runtime } = createRuntime();
    await runtime.start();
    await new Promise<void>((r) => runtime.httpsServer.close(() => r()));

    await expect(runtime.close()).rejects.toThrow();
  });

  it("resolves cleanly when every underlying server closes without error", async () => {
    const { runtime } = createRuntime();
    await runtime.start();

    await expect(runtime.close()).resolves.toBeUndefined();
  });
});
