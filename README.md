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

### View Recent Alerts

```bash
node index.mjs --alerts
```

Shows recent state transitions (UP→DOWN or DOWN→UP).

### JSON Output

```bash
node index.mjs --json
```

Outputs raw JSON for scripting.

---

## Health Check Types

The monitor supports three check types, configured in `services.json`:

### 1. HTTP Check (`type: "http"`)

Pings an HTTP endpoint and verifies a successful response.

**Configuration:**
```json
{
  "name": "agent-server",
  "type": "http",
  "url": "http://localhost:3001/api/health"
}
```

**Response States:**
- **UP** — HTTP 2xx response within timeout (default 5s)
- **SLOW** — Response received but took >3s
- **DOWN** — Connection failed, timeout, or non-2xx response

**Example Response:**
```json
{
  "name": "agent-server",
  "status": "UP",
  "responseTime": 45,
  "checkedAt": "2026-03-13T01:00:00.000Z"
}
```

### 2. Port Check (`type: "port"`)

Verifies a TCP port is open and accepting connections.

**Configuration:**
```json
{
  "name": "database",
  "type": "port",
  "port": 5432
}
```

**Response States:**
- **UP** — Port is open
- **DOWN** — Port is closed or unreachable

**Example Response:**
```json
{
  "name": "database",
  "status": "UP",
  "responseTime": 2,
  "checkedAt": "2026-03-13T01:00:00.000Z"
}
```

### 3. PM2 Process Check (`type: "pm2"`)

Verifies a PM2 process is running.

**Configuration:**
```json
{
  "name": "agent-server",
  "type": "pm2",
  "process": "agent-server"
}
```

**Response States:**
- **UP** — Process is running (status "online" or "launching")
- **STOPPED** — Process exists but not running (status "stopped", "errored", "one-launch-status")
- **DOWN** — Process not found in PM2 list

**Example Response:**
```json
{
  "name": "agent-server",
  "status": "UP",
  "pm2Status": "online",
  "cpu": 2.1,
  "memory": 145678900,
  "checkedAt": "2026-03-13T01:00:00.000Z"
}
```

---

## Web Dashboard API

When running with `--serve`, the dashboard exposes:

### GET /

Returns the HTML dashboard with auto-refresh every 30 seconds.

### GET /api/data

Returns JSON health data for all services.

**Response Format:**
```json
{
  "checkedAt": "2026-03-13T01:00:00.000Z",
  "services": [
    {
      "name": "agent-server",
      "type": "http",
      "status": "UP",
      "responseTime": 45,
      "detail": "200 OK"
    },
    {
      "name": "database",
      "type": "port",
      "status": "UP",
      "responseTime": 2
    },
    {
      "name": "agent-server",
      "type": "pm2",
      "status": "UP",
      "pm2Status": "online",
      "cpu": 2.1,
      "memory": 145678900
    }
  ],
  "summary": {
    "total": 5,
    "up": 5,
    "down": 0,
    "slow": 0
  }
}
```

---

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
    "name": "ollama",
    "type": "http",
    "url": "http://localhost:11434/api/tags"
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

## Monitored Services

This deployment monitors the following services:

| Service | Type | Endpoint | Timeout |
|---------|------|----------|---------|
| Agent Server | HTTP | http://localhost:3001/api/health | 3s |
| Agent UI | HTTP | http://localhost:3002 | 3s |
| ICM Dashboard | HTTP | http://localhost:3847 | 3s |
| Daily Briefing | HTTP | http://localhost:3850 | 3s |
| Ollama | HTTP | http://localhost:11434/api/tags | 5s |
| pm2 Processes | PM2 | — | — |

## License

MIT

---

## Troubleshooting

### Services showing as DOWN

1. **Check if the service is running:**
   ```bash
   curl http://localhost:3001/api/health
   pm2 list
   ```

2. **Check the port is open:**
   ```bash
   lsof -i :3001
   ```

3. **Verify timeout settings** — some services may need longer timeouts if they're slow to respond.

### Dashboard not loading

1. Verify the port is not in use:
   ```bash
   lsof -i :3851
   ```

2. Check the environment variable:
   ```bash
   HEALTH_MONITOR_PORT=3851 node index.mjs --serve
   ```

### History not persisting

- Ensure the process has write permissions to the project directory
- Check `history.json` exists and is valid JSON

## Alerting

When a service transitions state (UP→DOWN or DOWN→UP), the monitor logs the event to `alerts.json`:

```json
[
  {
    "timestamp": "2026-03-13T06:27:26.567Z",
    "service": "Agent UI",
    "from": "UP",
    "to": "DOWN",
    "type": "outage"
  }
]
```

### Alert Types

- **outage** — Service went DOWN
- **recovery** — Service came back UP

View recent alerts:
```bash
node index.mjs --alerts
```

## Cron Integration

Run health checks automatically on a schedule:

```bash
# Every 5 minutes
*/5 * * * * cd /path/to/health-monitor && node index.mjs >> /var/log/health.log 2>&1
```

Or run as a daemon with automatic serving:

```bash
# Start dashboard and health checker as PM2 process
pm2 start index.mjs --name health-monitor -- serve
pm2 save
```

## Programmatic Usage

Import the health checker in other Node.js scripts:

```javascript
import { checkService, loadServices } from './index.mjs';

const services = await loadServices();
const results = await Promise.all(services.map(checkService));

console.log(results);
// [
//   { name: "agent-server", status: "UP", responseTime: 45 },
//   ...
// ]
```
