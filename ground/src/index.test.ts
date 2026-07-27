import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createSignalingServer } from "./signaling.js";

const runtimes: Array<ReturnType<typeof createSignalingServer>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(async (runtime) => runtime.close()));
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function createRuntime(handshakeTimeoutMs = 100): ReturnType<typeof createSignalingServer> {
  const stateDir = mkdtempSync(resolve(tmpdir(), "dronelink-ground-test-"));
  tempDirs.push(stateDir);

  const runtime = createSignalingServer({
    port: 0,
    host: "127.0.0.1",
    stateDir,
    handshakeTimeoutMs,
    logger: {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });

  runtimes.push(runtime);
  return runtime;
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

  it("prints a bundle shape that matches the protocol schema", async () => {
    const runtime = createRuntime();
    const bundle = await runtime.start();
    const schema = JSON.parse(
      readFileSync(
        resolve("/home/runner/work/dronelink/dronelink/protocol/schemas/pairing-bundle.schema.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;

    expect(validateAgainstPairingSchema(schema, bundle as unknown as Record<string, unknown>)).toBe(
      true,
    );
  });

  it("reuses the persisted TLS certificate across restarts", async () => {
    const stateDir = mkdtempSync(resolve(tmpdir(), "dronelink-ground-test-"));
    tempDirs.push(stateDir);

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

    const [firstBundle, secondBundle] = await Promise.all([first.start(), second.start()]);
    expect(firstBundle.certFingerprint).toBe(secondBundle.certFingerprint);
  });
});
