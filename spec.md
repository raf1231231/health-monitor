# Health Monitor

## Project Name
Health Monitor

## Purpose
Lightweight service health checker for the Mac Mini. Pings all known services, reports their status with color-coded output, serves a web dashboard with rolling history, and provides alerting hooks for state transitions. Designed for continuous monitoring of local services.

## Tech Stack
- **Language**: JavaScript (ES Modules)
- **Runtime**: Node.js
- **Testing**: Vitest
- **Storage**: JSON file (history.json) with rolling 7-day window

## Key Files
- `index.mjs` - Main entry point (all-in-one CLI and server)
- `services.json` - Service registry configuration
- `utils.mjs` - Utility functions
- `utils.test.mjs` - Test file
- `vitest.config.js` - Vitest configuration

## How to Run
```bash
# Run health checks (CLI)
node index.mjs

# Start web dashboard (port 3851)
node index.mjs --serve

# View uptime history
node index.mjs --history

# View recent alerts
node index.mjs --alerts

# JSON output for scripting
node index.mjs --json

# Run tests
npm test
```

## Current Status
**100% Complete** - Full feature set implemented including HTTP/port/pm2 checks, web dashboard, rolling history, and alerting.
