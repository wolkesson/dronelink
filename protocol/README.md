# protocol

Shared wire-format documentation, signaling message JSON schemas, and recorded byte-stream fixtures used by both `/ground` and `/webapp` test suites.

## Purpose

- **`schemas/`** — JSON Schema definitions for signaling messages (pairing bundle, SDP offer/answer, ICE candidates, session token challenge/response). Both `/ground` and `/webapp` validate messages against these schemas.
- **`fixtures/`** — Recorded raw serial byte-stream captures (e.g., real INAV/MAVLink telemetry bursts). Used by `/ground` integration tests and `/webapp` unit tests so neither test suite needs a real flight controller or SITL running.

## Signaling message format (to be defined in Phase 0)

All signaling messages are JSON objects sent over the WebSocket connection established during pairing. The message envelope will be defined once the Phase 0 pairing spike is complete and placed in `schemas/`.

## Adding fixtures

Fixtures are raw binary files (`.bin`) recorded from a real flight controller connection. They should be small (< 1 MB each), named descriptively (e.g., `inav-telemetry-burst-100ms.bin`), and accompanied by a `.json` metadata file describing the source device, firmware version, baud rate, and capture timestamp.

## Adding schemas

Schemas are JSON Schema (draft-07) files. Validation is done in each package's own test suite against a copy of these schemas — there is no shared runtime schema-validation library yet.
