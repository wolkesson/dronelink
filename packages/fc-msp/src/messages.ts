/**
 * Typed payloads for the Betaflight MSP messages flight control uses. Layouts follow
 * Betaflight 2026.6 (MSP API 1.48, src/main/msp/msp.c); fields added in later API versions
 * are optional so older replies still decode.
 */

export const MspCommand = {
  API_VERSION: 1,
  FC_VARIANT: 2,
  FC_VERSION: 3,
  BOARD_INFO: 4,
  BUILD_INFO: 5,
  RX_MAP: 64,
  STATUS: 101,
  RC: 105,
  RAW_GPS: 106,
  COMP_GPS: 107,
  ATTITUDE: 108,
  ALTITUDE: 109,
  ANALOG: 110,
  BOXNAMES: 116,
  BOXIDS: 119,
  GPS_RESCUE: 135,
  STATUS_EX: 150,
  SET_RAW_RC: 200,
} as const;

/** Betaflight permanent box ids, as listed by MSP_BOXIDS (msp_box.c). */
export const BoxId = {
  ARM: 0,
  ANGLE: 1,
  HORIZON: 2,
  ALTHOLD: 3,
  POSHOLD: 11,
  FAILSAFE: 27,
  GPSRESCUE: 46,
  MSP_OVERRIDE: 50,
} as const;

/** MSP_SET_RAW_RC accepts at most this many channels (MAX_SUPPORTED_RC_CHANNEL_COUNT). */
export const MAX_RC_CHANNELS = 18;

export class MspDecodeError extends Error {}

class PayloadReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(
    private readonly payload: Uint8Array,
    private readonly message: string,
  ) {
    this.view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  }

  get remaining(): number {
    return this.payload.length - this.offset;
  }

  private take(length: number): number {
    if (this.remaining < length) {
      throw new MspDecodeError(`${this.message}: payload too short (${this.payload.length} bytes)`);
    }
    const at = this.offset;
    this.offset += length;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }

  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }

  i16(): number {
    return this.view.getInt16(this.take(2), true);
  }

  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }

  i32(): number {
    return this.view.getInt32(this.take(4), true);
  }

  bytes(length: number): Uint8Array {
    const at = this.take(length);
    return this.payload.slice(at, at + length);
  }

  ascii(length: number): string {
    return String.fromCharCode(...this.bytes(length));
  }

  /** Length-prefixed string (sbufWritePString). */
  pstring(): string {
    return this.ascii(this.u8());
  }
}

export interface ApiVersion {
  protocolVersion: number;
  apiMajor: number;
  apiMinor: number;
}

export function decodeApiVersion(payload: Uint8Array): ApiVersion {
  const r = new PayloadReader(payload, "MSP_API_VERSION");
  return { protocolVersion: r.u8(), apiMajor: r.u8(), apiMinor: r.u8() };
}

/** Four-letter firmware id: "BTFL" for Betaflight, "INAV", "ARDU", "EMUF", ... */
export function decodeFcVariant(payload: Uint8Array): string {
  return new PayloadReader(payload, "MSP_FC_VARIANT").ascii(4);
}

export interface FcVersion {
  /** Betaflight 2025.12+ uses calendar versions: major = year - 2000, minor = month. */
  major: number;
  minor: number;
  patch: number;
  /** Full version string incl. any suffix, sent since MSP API 1.47 (e.g. "2026.6.2"). */
  versionString?: string;
}

export function decodeFcVersion(payload: Uint8Array): FcVersion {
  const r = new PayloadReader(payload, "MSP_FC_VERSION");
  const version: FcVersion = { major: r.u8(), minor: r.u8(), patch: r.u8() };
  if (r.remaining > 0) version.versionString = r.pstring();
  return version;
}

export interface BoardInfo {
  boardIdentifier: string;
  hardwareRevision: number;
  boardType: number;
  targetCapabilities?: number;
  targetName?: string;
  boardName?: string;
  manufacturerId?: string;
}

export function decodeBoardInfo(payload: Uint8Array): BoardInfo {
  const r = new PayloadReader(payload, "MSP_BOARD_INFO");
  const info: BoardInfo = { boardIdentifier: r.ascii(4), hardwareRevision: r.u16(), boardType: r.u8() };
  if (r.remaining === 0) return info;
  info.targetCapabilities = r.u8();
  info.targetName = r.pstring();
  if (r.remaining === 0) return info;
  info.boardName = r.pstring();
  info.manufacturerId = r.pstring();
  return info;
}

export interface BuildInfo {
  buildDate: string;
  buildTime: string;
  gitRevision: string;
}

export function decodeBuildInfo(payload: Uint8Array): BuildInfo {
  const r = new PayloadReader(payload, "MSP_BUILD_INFO");
  return { buildDate: r.ascii(11), buildTime: r.ascii(8), gitRevision: r.ascii(7) };
}

/** Raw receiver channel index for each function, in Betaflight's internal order R, P, Y, T, AUX1.. */
export function decodeRxMap(payload: Uint8Array): number[] {
  return [...payload];
}

export interface FcStatus {
  cycleTimeUs: number;
  i2cErrors: number;
  /** Bit 0 acc, 1 baro, 2 mag, 3 GPS, 4 rangefinder, 5 gyro, 6 optical flow. */
  sensors: number;
  /** Bit i set = the i-th box of MSP_BOXIDS is active. See {@link activeBoxIds}. */
  flightModeFlags: Uint8Array;
  pidProfile: number;
  cpuLoad: number;
  armingDisableFlags: number;
  rebootRequired: boolean;
}

/** Decodes MSP_STATUS and MSP_STATUS_EX, which share every field flight control reads. */
export function decodeStatus(payload: Uint8Array): FcStatus {
  const r = new PayloadReader(payload, "MSP_STATUS");
  const cycleTimeUs = r.u16();
  const i2cErrors = r.u16();
  const sensors = r.u16();
  const firstFlags = r.bytes(4);
  const pidProfile = r.u8();
  const cpuLoad = r.u16();
  r.u16(); // STATUS_EX: profile count + rate profile; STATUS: gyro cycle time
  const extraFlags = r.bytes(r.u8() & 0x0f);
  r.u8(); // arming disable flag count
  const armingDisableFlags = r.u32();
  const rebootRequired = (r.u8() & 0x01) !== 0;

  const flightModeFlags = new Uint8Array(4 + extraFlags.length);
  flightModeFlags.set(firstFlags);
  flightModeFlags.set(extraFlags, 4);
  return { cycleTimeUs, i2cErrors, sensors, flightModeFlags, pidProfile, cpuLoad, armingDisableFlags, rebootRequired };
}

/** Permanent ids of the active boxes, pairing status flag bits with MSP_BOXIDS order. */
export function activeBoxIds(flightModeFlags: Uint8Array, boxIds: readonly number[]): Set<number> {
  const active = new Set<number>();
  boxIds.forEach((boxId, index) => {
    const byte = flightModeFlags[index >> 3] ?? 0;
    if (byte & (1 << (index & 7))) active.add(boxId);
  });
  return active;
}

/** rcData in Betaflight's internal order R, P, Y, T, AUX1.. (after MSP override). */
export function decodeRc(payload: Uint8Array): number[] {
  const r = new PayloadReader(payload, "MSP_RC");
  const channels: number[] = [];
  while (r.remaining >= 2) channels.push(r.u16());
  return channels;
}

export interface RawGps {
  fix: boolean;
  numSat: number;
  latitude: number;
  longitude: number;
  altitudeM: number;
  groundSpeedCmS: number;
  groundCourseDeg: number;
  pdop?: number;
}

export function decodeRawGps(payload: Uint8Array): RawGps {
  const r = new PayloadReader(payload, "MSP_RAW_GPS");
  const gps: RawGps = {
    fix: r.u8() !== 0,
    numSat: r.u8(),
    latitude: r.i32() / 1e7,
    longitude: r.i32() / 1e7,
    altitudeM: r.u16(),
    groundSpeedCmS: r.u16(),
    groundCourseDeg: r.u16() / 10,
  };
  if (r.remaining >= 2) gps.pdop = r.u16() / 100;
  return gps;
}

export interface CompGps {
  distanceToHomeM: number;
  directionToHomeDeg: number;
  updated: boolean;
}

export function decodeCompGps(payload: Uint8Array): CompGps {
  const r = new PayloadReader(payload, "MSP_COMP_GPS");
  return { distanceToHomeM: r.u16(), directionToHomeDeg: r.i16(), updated: (r.u8() & 1) !== 0 };
}

export interface Attitude {
  rollDeg: number;
  pitchDeg: number;
  headingDeg: number;
}

export function decodeAttitude(payload: Uint8Array): Attitude {
  const r = new PayloadReader(payload, "MSP_ATTITUDE");
  return { rollDeg: r.i16() / 10, pitchDeg: r.i16() / 10, headingDeg: r.i16() };
}

export interface Altitude {
  altitudeM: number;
  varioMS: number;
}

export function decodeAltitude(payload: Uint8Array): Altitude {
  const r = new PayloadReader(payload, "MSP_ALTITUDE");
  return { altitudeM: r.i32() / 100, varioMS: r.i16() / 100 };
}

export interface Analog {
  voltageV: number;
  mAhDrawn: number;
  rssi: number;
  currentA: number;
}

export function decodeAnalog(payload: Uint8Array): Analog {
  const r = new PayloadReader(payload, "MSP_ANALOG");
  const legacyVoltage = r.u8() / 10;
  const mAhDrawn = r.u16();
  const rssi = r.u16();
  const currentA = r.i16() / 100;
  const voltageV = r.remaining >= 2 ? r.u16() / 100 : legacyVoltage;
  return { voltageV, mAhDrawn, rssi, currentA };
}

export function decodeBoxNames(payload: Uint8Array): string[] {
  const text = String.fromCharCode(...payload);
  return text.split(";").filter((name) => name.length > 0);
}

export function decodeBoxIds(payload: Uint8Array): number[] {
  return [...payload];
}

export interface GpsRescueConfig {
  maxAngleDeg: number;
  returnAltitudeM: number;
  descentDistanceM: number;
  groundSpeedCmS: number;
  throttleMin: number;
  throttleMax: number;
  /** ap_hover_throttle; 0 means "capture the throttle when alt hold engages". */
  hoverThrottle: number;
  sanityChecks: number;
  minSats: number;
}

export function decodeGpsRescueConfig(payload: Uint8Array): GpsRescueConfig {
  const r = new PayloadReader(payload, "MSP_GPS_RESCUE");
  return {
    maxAngleDeg: r.u16(),
    returnAltitudeM: r.u16(),
    descentDistanceM: r.u16(),
    groundSpeedCmS: r.u16(),
    throttleMin: r.u16(),
    throttleMax: r.u16(),
    hoverThrottle: r.u16(),
    sanityChecks: r.u8(),
    minSats: r.u8(),
  };
}

/**
 * MSP_SET_RAW_RC payload: channel values in raw receiver order. Betaflight only overrides a
 * masked channel that the frame actually contains, so a 4-channel frame can never reach AUX.
 */
export function encodeSetRawRc(channels: readonly number[]): Uint8Array {
  if (channels.length === 0 || channels.length > MAX_RC_CHANNELS) {
    throw new RangeError(`MSP_SET_RAW_RC needs 1..${MAX_RC_CHANNELS} channels, got ${channels.length}`);
  }
  const payload = new Uint8Array(channels.length * 2);
  const view = new DataView(payload.buffer);
  channels.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new RangeError(`RC channel ${index} must be an integer in 0..65535, got ${value}`);
    }
    view.setUint16(index * 2, value, true);
  });
  return payload;
}
