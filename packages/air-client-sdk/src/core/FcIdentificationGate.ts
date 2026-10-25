import type { DetectedLinkType } from "@dronelink/core-transport";
import {
  BoxId,
  MspCommand,
  decodeApiVersion,
  decodeBoardInfo,
  decodeBoxIds,
  decodeBoxNames,
  decodeBuildInfo,
  decodeFcVariant,
  decodeFcVersion,
  decodeGpsRescueConfig,
  decodeRxMap,
} from "@dronelink/fc-msp";

export interface FcIdentity {
  variant: string;
  version: string;
  apiVersion: string;
  board: string;
  target: string;
  build: string;
  hoverThrottleUs: number;
  /** MSP_BOXIDS order, which pairs with the flight mode flag bits in MSP_STATUS_EX. */
  boxIds: number[];
  /** Raw receiver channel per function, in Betaflight's internal order R, P, Y, T, AUX1.. */
  rxMap: number[];
}

export type IdentificationResult =
  | { mode: "transparent"; reason: string; identity: FcIdentity | null }
  | { mode: "pending"; reason: string | null; identity: null }
  | { mode: "verified"; reason: null; identity: FcIdentity };

export interface FcIdentificationConfig {
  supportedVersions: readonly string[];
  supportedApiMajor: number;
  minApiMinor: number;
  maxApiMinor: number;
  timeoutMs: number;
}

export interface FcIdentificationOptions {
  enabled: boolean;
  detectedType: DetectedLinkType;
  passthroughIdle: boolean;
  request: (command: number) => Promise<Uint8Array | null>;
  onIdentity?: (identity: FcIdentity) => void;
}

export const DEFAULT_FC_IDENTIFICATION_CONFIG: FcIdentificationConfig = {
  supportedVersions: ["2026.6.1", "2026.6.2"],
  supportedApiMajor: 1,
  minApiMinor: 48,
  maxApiMinor: 48,
  timeoutMs: 1_500,
};

function versionText(version: ReturnType<typeof decodeFcVersion>): string {
  return version.versionString ?? `${version.major + 2000}.${version.minor}.${version.patch}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      () => {
        clearTimeout(timeout);
        resolve(null);
      },
    );
  });
}

/**
 * Opt-in Betaflight identification gate. Probe transport is injected so the serial relay
 * remains protocol-agnostic and can ensure probe replies are intercepted before forwarding.
 */
export class FcIdentificationGate {
  private generation = 0;
  private current: IdentificationResult = { mode: "transparent", reason: "setting-disabled", identity: null };

  constructor(private readonly config: FcIdentificationConfig = DEFAULT_FC_IDENTIFICATION_CONFIG) {}

  get result(): IdentificationResult {
    return this.current;
  }

  disable(): IdentificationResult {
    this.generation++;
    this.current = { mode: "transparent", reason: "setting-disabled", identity: null };
    return this.current;
  }

  reset(reason = "link-reopened"): IdentificationResult {
    this.generation++;
    this.current = { mode: "transparent", reason, identity: null };
    return this.current;
  }

  async identify(options: FcIdentificationOptions): Promise<IdentificationResult> {
    const generation = ++this.generation;
    if (!options.enabled) return this.disable();
    if (options.detectedType === "mavlink-v1" || options.detectedType === "mavlink-v2" || options.detectedType === "crsf") {
      return this.reject("unsupported-link-type");
    }
    if (!options.passthroughIdle) {
      this.current = { mode: "pending", reason: "passthrough-busy", identity: null };
      return this.current;
    }

    this.current = { mode: "pending", reason: null, identity: null };
    const query = async (command: number): Promise<Uint8Array> => {
      const payload = await withTimeout(options.request(command), this.config.timeoutMs);
      if (!payload) throw new Error("identification-timeout");
      if (generation !== this.generation) throw new Error("identification-cancelled");
      return payload;
    };

    try {
      const api = decodeApiVersion(await query(MspCommand.API_VERSION));
      if (api.protocolVersion !== 0 || api.apiMajor !== this.config.supportedApiMajor ||
        api.apiMinor < this.config.minApiMinor || api.apiMinor > this.config.maxApiMinor) {
        return this.reject("unsupported-api-version");
      }

      const variant = decodeFcVariant(await query(MspCommand.FC_VARIANT));
      if (variant !== "BTFL") return this.reject("unsupported-firmware");

      const decodedVersion = decodeFcVersion(await query(MspCommand.FC_VERSION));
      const version = versionText(decodedVersion);
      if (!this.config.supportedVersions.includes(version)) return this.reject("unsupported-firmware-version");

      const boardPayload = await query(MspCommand.BOARD_INFO);
      const buildPayload = await query(MspCommand.BUILD_INFO);
      const namesPayload = await query(MspCommand.BOXNAMES);
      const idsPayload = await query(MspCommand.BOXIDS);
      const rxMapPayload = await query(MspCommand.RX_MAP);
      const rescuePayload = await query(MspCommand.GPS_RESCUE);
      const boardInfo = decodeBoardInfo(boardPayload);
      const buildInfo = decodeBuildInfo(buildPayload);
      const boxNames = decodeBoxNames(namesPayload);
      const boxIds = decodeBoxIds(idsPayload);
      const missingBoxes = [BoxId.ARM, BoxId.ALTHOLD, BoxId.POSHOLD, BoxId.MSP_OVERRIDE]
        .filter((boxId) => !boxIds.includes(boxId));
      if (missingBoxes.length > 0) return this.reject(`missing-boxes:${missingBoxes.join(",")}`);
      if (boxNames.length !== boxIds.length) return this.reject("malformed-boxes");
      const requiredBoxNames: Record<number, string> = {
        [BoxId.ARM]: "ARM",
        [BoxId.ALTHOLD]: "ALTHOLD",
        [BoxId.POSHOLD]: "POS HOLD",
        [BoxId.MSP_OVERRIDE]: "MSP OVERRIDE",
      };
      if (boxIds.some((boxId, index) => requiredBoxNames[boxId] !== undefined && boxNames[index] !== requiredBoxNames[boxId])) {
        return this.reject("malformed-boxes");
      }

      const rxMap = decodeRxMap(rxMapPayload);
      if (rxMap.length < 4 || new Set(rxMap.slice(0, 4)).size !== 4 || rxMap.slice(0, 4).some((channel) => channel > 3)) {
        return this.reject("unsupported-rx-map");
      }

      const hoverThrottleUs = decodeGpsRescueConfig(rescuePayload).hoverThrottle;
      if (hoverThrottleUs === 0) return this.reject("hover-throttle-not-fixed");

      if (generation !== this.generation) return this.current;
      const identity: FcIdentity = {
        variant,
        version,
        apiVersion: `${api.apiMajor}.${api.apiMinor}`,
        board: boardInfo.boardName ?? boardInfo.boardIdentifier,
        target: boardInfo.targetName ?? boardInfo.boardIdentifier,
        build: `${buildInfo.buildDate} ${buildInfo.buildTime} ${buildInfo.gitRevision}`.trim(),
        hoverThrottleUs,
        boxIds,
        rxMap,
      };
      options.onIdentity?.(identity);
      this.current = { mode: "verified", reason: null, identity };
      return this.current;
    } catch (error) {
      if (generation !== this.generation) return this.current;
      return this.reject(error instanceof Error && error.message === "identification-timeout"
        ? "identification-timeout"
        : "malformed-identification-reply");
    }
  }

  private reject(reason: string): IdentificationResult {
    this.current = { mode: "transparent", reason, identity: null };
    return this.current;
  }
}
