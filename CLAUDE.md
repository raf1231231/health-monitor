# Health Monitor

## Overview
Service health checker for the Mac Mini — pings local services and reports status via CLI or web dashboard.

## Stack
- Runtime: Node.js (ESM, zero external deps for core — same pattern as daily-briefing)
- Database: JSON file for history (keep it simple, no bun:sqlite dependency unless needed)
- Web: Built-in `node:http` + inline HTML/CSS (dark theme, JetBrains Mono)

## Conventions
- Single entry point: `index.mjs`
- Service registry: `services.json` — array of `{ name, url?, port?, type: "http"|"port"|"pm2" }`
- All checks use native `fetch()` or `net.connect()` — no external HTTP libs
- CLI output uses ANSI escape codes directly (no chalk)
- Keep total codebase under 500 lines
- Follow daily-briefing patterns for the web dashboard (dark theme, auto-refresh)

## Known Services to Monitor
- Agent Server: http://localhost:3001/health (or just port 3001)
- Agent UI: http://localhost:3002
- ICM Dashboard: http://localhost:3847
- Daily Briefing: http://localhost:3850
- Ollama: http://localhost:11434/api/tags
- pm2 processes: parse `pm2 jlist` output
