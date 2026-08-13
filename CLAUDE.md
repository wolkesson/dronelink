# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DroneLink is a drone command-and-control (C2) and video link system: the air side reads FC telemetry/control over USB serial and captures phone/desktop camera media, forwarding both to the ground over WebRTC; the ground side terminates signaling/WebRTC, bridges the serial byte stream to TCP for INAV Configurator/GCS, and records or re-serves video.

**[AGENTS.md](AGENTS.md) is the single source of truth for repository guidance** — project overview, workspace layout, commands, key design constraints, testing, CI, and code style all live there. Read it before making changes. This file exists only because Claude Code looks for `CLAUDE.md` specifically; there is no Claude-Code-specific guidance beyond what AGENTS.md already covers.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design before making structural changes; see its "Current implementation state" section for what's built.
