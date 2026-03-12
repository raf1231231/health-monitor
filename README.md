# Health Monitor

Lightweight service health checker for the Mac Mini. Pings all known services, reports their status with color-coded output, and serves a web dashboard with rolling history.

## Status

**Complete** — Full feature set implemented.

## Features

- **Core Health Check Engine** — Config-driven service registry (JSON), HTTP ping with timeout, pm2 process status, port-open checks
- **CLI Output** — Color-coded table showing service name, status (UP/DOWN/SLOW), response time
- **History Log** — Rolling history stored in JSON file, capped at 7 days. Shows uptime % per service over last 24h
- **Web Dashboard** — Dark-theme dashboard on port 3851 (configurable via HEALTH_MONITOR_PORT), auto-refresh every 30s
- **Alerting Hooks** — Logs state transitions (UP→DOWN, DOWN→UP) to a structured event log

## Installation

```bash
npm install
```

## Usage

### Run Health Checks

```bash
node index.mjs
```

Exit code 0 if all healthy, 1 if any down.

### Start Web Dashboard

```bash
node index.mjs --serve
```

Dashboard available at http://localhost:3851 (or HEALTH_MONITOR_PORT env var).

### View History

```bash
node index.mjs --history
```

Shows uptime percentage per service over the last 24 hours.

## Configuration

### Services Registry (services.json)

Define services to monitor:

```json
[
  {
    "name": "agent-server",
    "type": "http",
    "url": "http://localhost:3001/api/health"
  },
  {
    "name": "agent-ui",
    "type": "http", 
    "url": "http://localhost:3000"
  },
  {
    "name": "pm2-process",
    "type": "pm2",
    "process": "agent-server"
  },
  {
    "name": "database",
    "type": "port",
    "port": 5432
  }
]
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| HEALTH_MONITOR_PORT | 3851 | Dashboard port |

## Project Structure

```
health-monitor/
├── index.mjs          # Main entry point
├── services.json      # Service registry
├── spec.md            # Full specification
├── CLAUDE.md          # Claude instructions
├── work.md            # Work notes
└── history.json       # Rolling history log (generated)
```

## Tech Stack

- **Node.js** — Runtime
- **Bun SQLite** — History storage (via bun:sqlite) or JSON fallback

## Exit Codes

- `0` — All services healthy
- `1` — One or more services down or slow

## License

MIT
