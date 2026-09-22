import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createSignalingServer, type GuiAssets } from "./signaling.js";
import * as indexModule from "./index.js";

const runtimes: Array<ReturnType<typeof createSignalingServer>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(async (runtime) => runtime.close()));
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function createRuntime(
  handshakeTimeoutMs = 100,
  guiAssets?: GuiAssets,
): ReturnType<typeof createSignalingServer> {
  const stateDir = mkdtempSync(resolve(tmpdir(), "dronelink-ground-test-"));
  tempDirs.push(stateDir);
  seedTlsMaterial(stateDir);

  const runtime = createSignalingServer({
    port: 0,
    host: "127.0.0.1",
    stateDir,
    handshakeTimeoutMs,
    guiAssets,
    logger: {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });

  runtimes.push(runtime);
  return runtime;
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
    {
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  if (result.status !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || "unknown openssl failure";
    throw new Error(`Failed to seed TLS certificate for tests: ${details}`);
  }

  writeFileSync(tlsTargetPath, "mkcert:localhost\n", "utf8");
}

function openClient(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      rejectUnauthorized: false,
    });

    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(data.toString()));
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({
        code,
        reason: reason.toString(),
      });
    });
  });
}

function mutateToken(token: string): string {
  const replacement = token.endsWith("A") ? "B" : "A";
  return `${token.slice(0, -1)}${replacement}`;
}

function validateAgainstPairingSchema(schema: Record<string, unknown>, value: Record<string, unknown>): boolean {
  if (schema.type !== "object") {
    return false;
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== "string" || !(key in value)) {
      return false;
    }
  }

  if (schema.additionalProperties === false) {
    const properties = typeof schema.properties === "object" && schema.properties !== null ? schema.properties : {};
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        return false;
      }
    }
  }

  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};

  for (const [key, propertySchema] of Object.entries(properties)) {
    const propertyValue = value[key];

    if (propertySchema.type === "string") {
      if (typeof propertyValue !== "string") {
        return false;
      }

      if (
        typeof propertySchema.minLength === "number" &&
        propertyValue.length < propertySchema.minLength
      ) {
        return false;
      }

      if (
        typeof propertySchema.pattern === "string" &&
        !new RegExp(propertySchema.pattern, "u").test(propertyValue)
      ) {
        return false;
      }
    }

    if (propertySchema.type === "integer") {
      if (!Number.isInteger(propertyValue)) {
        return false;
      }

      const numericPropertyValue = propertyValue as number;

      if (
        typeof propertySchema.minimum === "number" &&
        numericPropertyValue < propertySchema.minimum
      ) {
        return false;
      }

      if (
        typeof propertySchema.maximum === "number" &&
        numericPropertyValue > propertySchema.maximum
      ) {
        return false;
      }
    }
  }

  return true;
}

describe("signaling server", () => {
  it("accepts the correct token as the first message", async () => {
    const runtime = createRuntime();
    const bundle = await runtime.start();
    const socket = await openClient(`wss://${bundle.host}:${bundle.port}`);

    socket.send(
      JSON.stringify({
        type: "pair",
        sessionId: bundle.sessionId,
        token: bundle.token,
      }),
    );

    await expect(waitForMessage(socket)).resolves.toBe(
      JSON.stringify({
        type: "pairing-accepted",
        sessionId: bundle.sessionId,
      }),
    );

    socket.close();
  });

  it("rejects a missing first-message token and closes the connection", async () => {
    const runtime = createRuntime(50);
    const bundle = await runtime.start();
    const socket = await openClient(`wss://${bundle.host}:${bundle.port}`);

    await expect(waitForClose(socket)).resolves.toEqual({
      code: 1008,
      reason: "token required",
    });
  });

  it("rejects a wrong first-message token and closes the connection", async () => {
    const runtime = createRuntime();
    const bundle = await runtime.start();
    const socket = await openClient(`wss://${bundle.host}:${bundle.port}`);

    socket.send(
      JSON.stringify({
        type: "pair",
        sessionId: bundle.sessionId,
        token: mutateToken(bundle.token),
      }),
    );

    await expect(waitForClose(socket)).resolves.toEqual({
      code: 1008,
      reason: "invalid token",
    });
  });

  it("serves GUI WebRTC signaling without pairing", async () => {
    const runtime = createRuntime();
    const bundle = await runtime.start();
    const socket = await openClient(`wss://${bundle.host}:${bundle.port}/gui-signaling`);

    socket.send(JSON.stringify({ type: "offer", sdp: "v=0\r\n" }));

    // With no video yet the offer is held, not rejected, so the GUI can still
    // receive control state; a control request proves the socket is live.
    socket.send(JSON.stringify({ type: "video-control-request", control: "quality", preset: "low" }));

    await expect(waitForMessage(socket)).resolves.toBe(
      JSON.stringify({ type: "error", message: "No active drone connection to apply video control to." }),
    );
    socket.close();
  });

  it("prints a bundle shape that matches the protocol schema", async () => {
    const runtime = createRuntime();
    const bundle = await runtime.start();
    const schema = JSON.parse(
      readFileSync(
        new URL("../../../protocol/schemas/pairing-bundle.schema.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, unknown>;

    expect(validateAgainstPairingSchema(schema, bundle as unknown as Record<string, unknown>)).toBe(
      true,
    );
  });

  it("uses a fixed sessionId/token when provided instead of generating random ones", async () => {
    const stateDir = mkdtempSync(resolve(tmpdir(), "dronelink-ground-test-"));
    tempDirs.push(stateDir);
    seedTlsMaterial(stateDir);

    const fixedSessionId = "fixed-session-id";
    const fixedToken = "AAAAAAAAAAAAAAAAAAAAAA";

    const runtime = createSignalingServer({
      port: 0,
      host: "127.0.0.1",
      stateDir,
      sessionId: fixedSessionId,
      token: fixedToken,
      logger: {
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
    runtimes.push(runtime);

    const bundle = await runtime.start();
    expect(bundle.sessionId).toBe(fixedSessionId);
    expect(bundle.token).toBe(fixedToken);
  });

  it("reuses the persisted TLS certificate across restarts", async () => {
    const stateDir = mkdtempSync(resolve(tmpdir(), "dronelink-ground-test-"));
    tempDirs.push(stateDir);
    seedTlsMaterial(stateDir);

    const first = createSignalingServer({
      port: 0,
      host: "127.0.0.1",
      stateDir,
      logger: {
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const second = createSignalingServer({
      port: 0,
      host: "127.0.0.1",
      stateDir,
      logger: {
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    runtimes.push(first, second);

    const certPath = join(stateDir, "pairing-cert.pem");
    const certBeforeSecondStart = readFileSync(certPath, "utf8");
    await Promise.all([first.start(), second.start()]);
    expect(readFileSync(certPath, "utf8")).toBe(certBeforeSecondStart);
  });
});

describe("video control protocol schemas", () => {
  function loadSchema(name: string): {
    oneOf: Array<{
      required: string[];
      properties: Record<string, { const?: string; enum?: Array<string | number>; type?: string }>;
    }>;
  } {
    return JSON.parse(
      readFileSync(new URL(`../../../protocol/schemas/${name}`, import.meta.url), "utf8"),
    ) as ReturnType<typeof loadSchema>;
  }

  it("video-control-request.schema.json's 'quality' branch matches every preset", () => {
    const schema = loadSchema("video-control-request.schema.json");
    const branch = schema.oneOf[0];

    expect(branch.required).toEqual(["type", "control", "preset"]);
    expect(branch.properties.type.const).toBe("video-control-request");
    expect(branch.properties.control.const).toBe("quality");
    expect(branch.properties.preset.enum).toEqual(["auto", "high", "low", "data-only"]);
  });

  it("video-control-state.schema.json's 'quality' branch matches every preset", () => {
    const schema = loadSchema("video-control-state.schema.json");
    const branch = schema.oneOf[0];

    expect(branch.required).toEqual(["type", "control", "preset", "videoActive"]);
    expect(branch.properties.type.const).toBe("video-control-state");
    expect(branch.properties.control.const).toBe("quality");
    expect(branch.properties.preset.enum).toEqual(["auto", "high", "low", "data-only"]);
    expect(branch.properties.videoActive.type).toBe("boolean");
  });

  it("video-control-request.schema.json's 'camera-source' branch requires a non-empty deviceId", () => {
    const schema = loadSchema("video-control-request.schema.json");
    const branch = schema.oneOf[1];

    expect(branch.required).toEqual(["type", "control", "deviceId"]);
    expect(branch.properties.control.const).toBe("camera-source");
    expect(branch.properties.deviceId.type).toBe("string");
  });

  it("video-control-state.schema.json's 'camera-source' and 'camera-source-list' branches are present", () => {
    const schema = loadSchema("video-control-state.schema.json");
    const ackBranch = schema.oneOf[1];
    const listBranch = schema.oneOf[4];

    expect(ackBranch.required).toEqual(["type", "control", "deviceId", "ok"]);
    expect(ackBranch.properties.control.const).toBe("camera-source");

    expect(listBranch.required).toEqual(["type", "control", "devices", "activeDeviceId"]);
    expect(listBranch.properties.control.const).toBe("camera-source-list");
  });

  it("air-status.schema.json bounds battery percent to 0-100 and requires charging", () => {
    const schema = JSON.parse(
      readFileSync(new URL("../../../protocol/schemas/air-status.schema.json", import.meta.url), "utf8"),
    ) as {
      required: string[];
      properties: {
        type: { const: string };
        battery: {
          required: string[];
          properties: { percent: { type: string; minimum: number; maximum: number }; charging: { type: string } };
        };
      };
    };

    expect(schema.required).toEqual(["type"]);
    expect(schema.properties.type.const).toBe("air-status");
    expect(schema.properties.battery.required).toEqual(["percent", "charging"]);
    expect(schema.properties.battery.properties.percent).toEqual({ type: "integer", minimum: 0, maximum: 100 });
    expect(schema.properties.battery.properties.charging.type).toBe("boolean");
  });

  it("air-status.schema.json describes dataUsage as non-negative tx/rx byte totals", () => {
    const schema = loadSchema("air-status.schema.json") as unknown as {
      properties: { dataUsage: { required: string[]; properties: Record<string, { type: string; minimum: number }> } };
    };

    expect(schema.properties.dataUsage.required).toEqual(["txBytes", "rxBytes"]);
    expect(schema.properties.dataUsage.properties.txBytes).toEqual({ type: "integer", minimum: 0 });
    expect(schema.properties.dataUsage.properties.rxBytes).toEqual({ type: "integer", minimum: 0 });
  });

  it("video-control-request.schema.json's 'flip' branch requires horizontal and vertical booleans", () => {
    const schema = loadSchema("video-control-request.schema.json");
    const branch = schema.oneOf[2];

    expect(branch.required).toEqual(["type", "control", "horizontal", "vertical"]);
    expect(branch.properties.control.const).toBe("flip");
    expect(branch.properties.horizontal.type).toBe("boolean");
    expect(branch.properties.vertical.type).toBe("boolean");
  });

  it("video-control-state.schema.json's 'flip' branch acks horizontal/vertical with ok/error", () => {
    const schema = loadSchema("video-control-state.schema.json");
    const branch = schema.oneOf[2];

    expect(branch.required).toEqual(["type", "control", "horizontal", "vertical", "ok"]);
    expect(branch.properties.control.const).toBe("flip");
    expect(branch.properties.horizontal.type).toBe("boolean");
    expect(branch.properties.vertical.type).toBe("boolean");
  });

  it("video-control-request.schema.json's 'rotate' branch only allows 90-degree steps", () => {
    const schema = loadSchema("video-control-request.schema.json");
    const branch = schema.oneOf[3];

    expect(branch.required).toEqual(["type", "control", "degrees"]);
    expect(branch.properties.control.const).toBe("rotate");
    expect(branch.properties.degrees.enum).toEqual([0, 90, 180, 270]);
  });

  it("video-control-state.schema.json's 'rotate' branch acks degrees with ok/error", () => {
    const schema = loadSchema("video-control-state.schema.json");
    const branch = schema.oneOf[3];

    expect(branch.required).toEqual(["type", "control", "degrees", "ok"]);
    expect(branch.properties.control.const).toBe("rotate");
    expect(branch.properties.degrees.enum).toEqual([0, 90, 180, 270]);
  });
});

describe("index.ts barrel exports", () => {
  it("re-exports createSignalingServer from the package root", () => {
    expect(indexModule.createSignalingServer).toBe(createSignalingServer);
  });
});
