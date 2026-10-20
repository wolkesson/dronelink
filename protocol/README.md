# protocol

Shared wire-format documentation, signaling message JSON schemas, and recorded byte-stream fixtures used by both the ground and air-side packages test suites.

## Purpose

- **`schemas/`** — JSON Schema definitions for signaling messages (including the pairing bundle in `schemas/pairing-bundle.schema.json`). Both the ground and air-side packages validate messages against these schemas.
- **`fixtures/`** — Recorded raw serial byte-stream captures (e.g., real INAV/MAVLink telemetry bursts). Used by `/ground` integration tests and `/webapp` unit tests so neither test suite needs a real flight controller or SITL running.

## Signaling message format

The pairing bundle JSON shape is defined in `schemas/pairing-bundle.schema.json`:

- `sessionId` — session identifier for the ground-side pairing session, randomly generated per process start unless pinned via `PAIRING_SESSION_ID`
- `token` — 128-bit base64url token the client must send in its first signaling message, randomly generated per process start unless pinned via `PAIRING_TOKEN`
- `host` / `port` — the ground-side `wss://` endpoint

## Adding fixtures

Fixtures are raw binary files (`.bin`) recorded from a real flight controller connection. They should be small (< 1 MB each), named descriptively (e.g., `inav-telemetry-burst-100ms.bin`), and accompanied by a `.json` metadata file describing the source device, firmware version, baud rate, and capture timestamp.

## Adding schemas

Schemas are JSON Schema (draft-07) files. Validation is done in each package's own test suite against a copy of these schemas — there is no shared runtime schema-validation library yet.

## Current fixtures

| Fixture | Contents |
| --- | --- |
| `fixtures/betaflight-2026.6.2-sitl-msp.bin` / `.json` | MSP v1/v2 reply frames from Betaflight 2026.6.2 SITL, armed in ALT HOLD + POS HOLD with MSP OVERRIDE active, one reply per request (identification, status, RC, GPS, attitude, altitude, analog, box names/ids, GPS rescue config, a `MSP_SET_RAW_RC` ack, and an error reply for an unassigned command). The `.json` lists each request's raw bytes and its reply's offset/length in the `.bin`. Recorded with `tools/sitl/capture_msp_fixture.py`. |
