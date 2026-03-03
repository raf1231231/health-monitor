# Health Monitor
Status: active
Created: 2026-03-02
Agents: claude

## Description
Lightweight service health checker for the Mac Mini. Pings all known services (agent server, UI, dashboards, Ollama, pm2 processes), reports their status in the terminal with color-coded output, and optionally serves a web dashboard. Keeps a rolling history log so you can spot intermittent failures.

## Goals
- [x] Core health check engine — config-driven service registry (JSON), HTTP ping with timeout, pm2 process status, port-open checks. Single `check()` function returns structured results
- [ ] CLI output — `node index.mjs` prints color-coded table: service name, status (UP/DOWN/SLOW), response time, last checked. Exit code 0 if all healthy, 1 if any down
- [ ] History log — append each check result to a rolling SQLite (via bun:sqlite) or JSON file. Cap at 7 days. CLI flag `--history` shows uptime % per service over last 24h
- [ ] Web dashboard — `node index.mjs --serve` on port 3851. Dark-theme single-page view showing current status + sparkline uptime history. Auto-refresh every 30s
- [ ] Alerting hooks — when a service transitions UP→DOWN or DOWN→UP, write a structured event to a log file. Optional: create a mail thread to notify Aaron
