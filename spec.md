# Health Monitor
Status: complete
Created: 2026-03-02
Agents: claude

## Description
Lightweight service health checker for the Mac Mini. Pings all known services (agent server, UI, dashboards, Ollama, pm2 processes), reports their status in the terminal with color-coded output, and optionally serves a web dashboard. Keeps a rolling history log so you can spot intermittent failures.

## Goals
- [x] Core health check engine — config-driven service registry (JSON), HTTP ping with timeout, pm2 process status, port-open checks. Single `check()` function returns structured results
- [x] CLI output — `node index.mjs` prints color-coded table: service name, status (UP/DOWN/SLOW), response time, last checked. Exit code 0 if all healthy, 1 if any down
- [x] History log — append each check result to a rolling SQLite (via bun:sqlite) or JSON file. Cap at 7 days. CLI flag `--history` shows uptime % per service over last 24h
- [x] Web dashboard — `node index.mjs --serve` on port 3851. Dark-theme single-page view showing current status + sparkline uptime history. Auto-refresh every 30s
- [x] Alerting hooks — when a service transitions UP→DOWN or DOWN→UP, write a structured event to a log file. Optional: create a mail thread to notify Aaron

## Changelog
- **2026-03-03**: Bug fix audit — 5 critical/high bugs fixed:
  1. `checkPort()` socket double-resolve race — added `settled` guard so timeout/connect/error callbacks can't resolve the promise twice
  2. `checkHttp()` response body never drained — added `res.body?.cancel()` to release connection pool sockets (prevents EMFILE in --serve mode)
  3. No `unhandledRejection` handler — added process-level handler to prevent silent daemon crashes in --serve mode
  4. Alert transition detection missed services with no prior state — replaced `p && ...` with explicit `r.name in prev` check so new services get baseline before alerting
  5. Empty `services.json` silently succeeded — now throws descriptive error requiring at least one service
- **2026-03-03**: Error handling hardening audit — 7 fixes applied:
  1. `services.json` JSON.parse wrapped in try-catch with descriptive error
  2. Web dashboard request handler wrapped in try-catch (was crashing on unhandled errors, leaving clients hanging)
  3. Server port binding error handler added (EADDRINUSE detection with helpful message)
  4. `last-status.json` corruption now logs warning instead of silently swallowing
  5. Alert mail thread creation protected with try-catch
  6. `appendHistory()` protected against write failures (disk full, permissions)
  7. Added Cache-Control `no-store` headers to prevent proxies caching stale health data
- **2026-03-04**: Performance & reliability improvements (project audit):
  1. **Result caching** — Dashboard now caches health check results for 15s. Previously every page load/refresh triggered 5+ concurrent checks (HTTP requests + pm2 subprocess). Multiple viewers within the TTL window get instant responses
  2. **Graceful shutdown** — Added SIGTERM/SIGINT handlers with 10s drain timeout. Server now closes cleanly instead of abruptly terminating in-flight requests
  3. **Overall timeout** — Promise.all() for health checks now races against a 35s timeout, preventing indefinite dashboard hangs if individual check timeouts fail
  4. **Error page** — Dashboard 500 errors now return a styled dark-theme error page with auto-retry instead of raw JSON blob
  5. **Configurable port** — Port now reads from `HEALTH_MONITOR_PORT` env var (default 3851)
