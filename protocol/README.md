# protocol

Shared wire-format documentation, signaling message JSON schemas, and recorded byte-stream fixtures used by both `/ground` and `/webapp` test suites.

## Purpose

- **`schemas/`** — JSON Schema definitions for signaling messages (including the Phase 0 pairing bundle in `schemas/pairing-bundle.schema.json`). Both `/ground` and `/webapp` validate messages against these schemas.
- **`fixtures/`** — Recorded raw serial byte-stream captures (e.g., real INAV/MAVLink telemetry bursts). Used by `/ground` integration tests and `/webapp` unit tests so neither test suite needs a real flight controller or SITL running.

## Signaling message format

Phase 0 defines the pairing bundle JSON shape in `schemas/pairing-bundle.schema.json`:

- `sessionId` — random session identifier for the ground-side pairing session
- `token` — random 128-bit base64url token the client must send in its first signaling message
- `host` / `port` — the ground-side `wss://` endpoint
- `certFingerprint` — SHA-256 fingerprint of the self-signed TLS certificate served by `/ground`

## Adding fixtures

Fixtures are raw binary files (`.bin`) recorded from a real flight controller connection. They should be small (< 1 MB each), named descriptively (e.g., `inav-telemetry-burst-100ms.bin`), and accompanied by a `.json` metadata file describing the source device, firmware version, baud rate, and capture timestamp.

## Adding schemas

Schemas are JSON Schema (draft-07) files. Validation is done in each package's own test suite against a copy of these schemas — there is no shared runtime schema-validation library yet.
