#!/usr/bin/env node
// health-monitor — Service Health Checker for Mac Mini
// Usage: node index.mjs [--serve|--history|--alerts|--json]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import net from 'node:net';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_PATH = join(__dirname, 'services.json');
const HISTORY_PATH = join(__dirname, 'history.json');
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LAST_STATUS_PATH = join(__dirname, 'last-status.json');
const ALERTS_PATH = join(__dirname, 'alerts.json');
const ALERTS_MAX = 500;
const PORT = parseInt(process.env.HEALTH_MONITOR_PORT || '3851', 10);
const CHECK_CACHE_TTL_MS = 15_000; // Cache health check results for 15 seconds
const OVERALL_CHECK_TIMEOUT_MS = 35_000; // Max time for all checks combined

// ── Status Constants ────────────────────────────────────────────────────
const STATUS = { UP: 'UP', DOWN: 'DOWN', SLOW: 'SLOW' };
const SLOW_THRESHOLD_MS = 2000;

// ── Result Cache ────────────────────────────────────────────────────────
let _cachedResult = null;
let _cacheTimestamp = 0;

// ── ANSI Colors ─────────────────────────────────────────────────────────
const R = '\x1b[0m', B = '\x1b[1m';
const GR = '\x1b[32m', RD = '\x1b[31m', YL = '\x1b[33m', GY = '\x1b[90m';
const CY = '\x1b[36m';

// ── Config Loader ───────────────────────────────────────────────────────

function loadServices() {
  if (!existsSync(SERVICES_PATH)) {
    throw new Error(`Service registry not found: ${SERVICES_PATH}`);
  }
  const raw = readFileSync(SERVICES_PATH, 'utf8');
  let services;
  try { services = JSON.parse(raw); } catch (e) {
    throw new Error(`services.json contains invalid JSON: ${e.message}`);
  }
  if (!Array.isArray(services)) {
    throw new Error('services.json must be a JSON array');
  }
  if (services.length === 0) {
    throw new Error('services.json is empty — add at least one service to monitor');
  }
  for (const svc of services) {
    if (!svc.name || !svc.type) {
      throw new Error(`Invalid service entry: ${JSON.stringify(svc)} — requires "name" and "type"`);
    }
    if (!['http', 'port', 'pm2'].includes(svc.type)) {
      throw new Error(`Unknown service type "${svc.type}" for "${svc.name}". Must be http, port, or pm2`);
    }
  }
  return services;
}

// ── Check Implementations ───────────────────────────────────────────────

async function checkHttp(svc) {
  const timeout = svc.timeout || 3000;
  const start = performance.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(svc.url, { signal: controller.signal });
    clearTimeout(timer);
    // Drain response body to release connection back to pool
    try { await res.body?.cancel(); } catch {}
    const elapsed = Math.round(performance.now() - start);
    const ok = res.status >= 200 && res.status < 400;
    let status;
    if (!ok) status = STATUS.DOWN;
    else if (elapsed > SLOW_THRESHOLD_MS) status = STATUS.SLOW;
    else status = STATUS.UP;
    return {
      name: svc.name,
      type: 'http',
      status,
      responseTime: elapsed,
      detail: `HTTP ${res.status}`,
      url: svc.url,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    const elapsed = Math.round(performance.now() - start);
    return {
      name: svc.name,
      type: 'http',
      status: STATUS.DOWN,
      responseTime: elapsed,
      detail: err.name === 'AbortError' ? 'Timeout' : err.message,
      url: svc.url,
      checkedAt: new Date().toISOString(),
    };
  }
}

async function checkPort(svc) {
  const timeout = svc.timeout || 3000;
  const host = svc.host || 'localhost';
  const start = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      done({
        name: svc.name,
        type: 'port',
        status: STATUS.DOWN,
        responseTime: Math.round(performance.now() - start),
        detail: `Timeout connecting to ${host}:${svc.port}`,
        port: svc.port,
        checkedAt: new Date().toISOString(),
      });
    }, timeout);

    socket.connect(svc.port, host, () => {
      const elapsed = Math.round(performance.now() - start);
      done({
        name: svc.name,
        type: 'port',
        status: elapsed > SLOW_THRESHOLD_MS ? STATUS.SLOW : STATUS.UP,
        responseTime: elapsed,
        detail: `Port ${svc.port} open`,
        port: svc.port,
        checkedAt: new Date().toISOString(),
      });
    });

    socket.on('error', (err) => {
      done({
        name: svc.name,
        type: 'port',
        status: STATUS.DOWN,
        responseTime: Math.round(performance.now() - start),
        detail: err.message,
        port: svc.port,
        checkedAt: new Date().toISOString(),
      });
    });
  });
}

function checkPm2(svc) {
  const start = performance.now();
  try {
    const raw = execSync('pm2 jlist 2>/dev/null', {
      timeout: 5000,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
    });
    const elapsed = Math.round(performance.now() - start);
    const processes = JSON.parse(raw);
    if (!Array.isArray(processes) || processes.length === 0) {
      return [{
        name: svc.name,
        type: 'pm2',
        status: STATUS.DOWN,
        responseTime: elapsed,
        detail: 'No pm2 processes found',
        checkedAt: new Date().toISOString(),
      }];
    }
    return processes.map((proc) => {
      const pmStatus = proc.pm2_env?.status || 'unknown';
      const uptime = proc.pm2_env?.pm_uptime
        ? formatUptime(Date.now() - proc.pm2_env.pm_uptime)
        : 'n/a';
      const restarts = proc.pm2_env?.restart_time ?? 0;
      let status;
      if (pmStatus === 'online') status = STATUS.UP;
      else if (pmStatus === 'stopping' || pmStatus === 'launching') status = STATUS.SLOW;
      else status = STATUS.DOWN;
      return {
        name: `pm2: ${proc.name}`,
        type: 'pm2',
        status,
        responseTime: elapsed,
        detail: `${pmStatus} | uptime: ${uptime} | restarts: ${restarts}`,
        pid: proc.pid,
        checkedAt: new Date().toISOString(),
      };
    });
  } catch (err) {
    const elapsed = Math.round(performance.now() - start);
    return [{
      name: svc.name,
      type: 'pm2',
      status: STATUS.DOWN,
      responseTime: elapsed,
      detail: err.message?.includes('not found') || err.status === 127
        ? 'pm2 not installed'
        : `pm2 error: ${(err.message || '').slice(0, 60)}`,
      checkedAt: new Date().toISOString(),
    }];
  }
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// ── Core Check Function ─────────────────────────────────────────────────

export async function check(options = {}) {
  const services = options.services || loadServices();
  const results = [];

  // Run all checks concurrently
  const promises = services.map(async (svc) => {
    switch (svc.type) {
      case 'http':
        return [await checkHttp(svc)];
      case 'port':
        return [await checkPort(svc)];
      case 'pm2':
        return checkPm2(svc);
      default:
        return [{
          name: svc.name,
          type: svc.type,
          status: STATUS.DOWN,
          responseTime: 0,
          detail: `Unknown check type: ${svc.type}`,
          checkedAt: new Date().toISOString(),
        }];
    }
  });

  // Race against an overall timeout to prevent indefinite hangs
  const allResults = await Promise.race([
    Promise.all(promises),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Overall health check timed out after ${OVERALL_CHECK_TIMEOUT_MS}ms`)), OVERALL_CHECK_TIMEOUT_MS)
    ),
  ]);
  for (const batch of allResults) {
    results.push(...batch);
  }

  const summary = {
    total: results.length,
    up: results.filter(r => r.status === STATUS.UP).length,
    down: results.filter(r => r.status === STATUS.DOWN).length,
    slow: results.filter(r => r.status === STATUS.SLOW).length,
  };

  return {
    results,
    summary,
    checkedAt: new Date().toISOString(),
  };
}

// ── Cached Check (for dashboard) ────────────────────────────────────────

/**
 * Returns cached health check results if fresh (within TTL), otherwise runs a new check.
 * Prevents redundant checks when multiple page loads hit within a short window.
 */
async function cachedCheck() {
  const now = Date.now();
  if (_cachedResult && (now - _cacheTimestamp) < CHECK_CACHE_TTL_MS) {
    return _cachedResult;
  }
  const data = await check();
  _cachedResult = data;
  _cacheTimestamp = now;
  appendHistory(data);
  processAlerts(data.results);
  return data;
}

// ── History Log ─────────────────────────────────────────────────────────

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function appendHistory(data) {
  try {
    const history = loadHistory();
    history.push({
      checkedAt: data.checkedAt,
      results: data.results.map(r => ({
        name: r.name,
        status: r.status,
        responseTime: r.responseTime,
      })),
    });
    const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
    const pruned = history.filter(entry => new Date(entry.checkedAt).getTime() > cutoff);
    writeFileSync(HISTORY_PATH, JSON.stringify(pruned, null, 2));
  } catch (e) {
    console.error(`${YL}Warning: Failed to save history: ${e.message}${R}`);
  }
}

function printHistory() {
  const history = loadHistory();
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  const recent = history.filter(entry => new Date(entry.checkedAt).getTime() > cutoff24h);

  if (recent.length === 0) {
    console.log(`\n${B}${CY}⚡ Health Monitor — History${R}\n`);
    console.log(`  ${YL}No history data available.${R} Run some checks first.\n`);
    return;
  }

  // Aggregate per service: { name -> { up, total, totalMs, checks } }
  const stats = {};
  for (const entry of recent) {
    for (const r of entry.results) {
      if (!stats[r.name]) stats[r.name] = { up: 0, total: 0, totalMs: 0, lastStatus: null, lastChecked: null };
      stats[r.name].total++;
      if (r.status !== STATUS.DOWN) stats[r.name].up++;
      stats[r.name].totalMs += r.responseTime;
      stats[r.name].lastStatus = r.status;
      stats[r.name].lastChecked = entry.checkedAt;
    }
  }

  const oldest = new Date(recent[0].checkedAt);
  const newest = new Date(recent[recent.length - 1].checkedAt);
  const spanHrs = Math.max(0.1, (newest - oldest) / (1000 * 60 * 60));

  console.log(`\n${B}${CY}⚡ Health Monitor — 24h Uptime${R}  ${GY}(${recent.length} checks over ${spanHrs.toFixed(1)}h)${R}\n`);

  const W = { name: 22, uptime: 12, avg: 10, checks: 10, current: 10 };
  const lineW = 2 + W.name + W.uptime + W.avg + W.checks + W.current;

  console.log(`${GY}${'─'.repeat(lineW)}${R}`);
  console.log(`  ${B}${'Service'.padEnd(W.name)}${'Uptime'.padEnd(W.uptime)}${'Avg ms'.padEnd(W.avg)}${'Checks'.padEnd(W.checks)}Current${R}`);
  console.log(`${GY}${'─'.repeat(lineW)}${R}`);

  for (const [name, s] of Object.entries(stats)) {
    const pct = (s.up / s.total * 100);
    const pctStr = pct.toFixed(1) + '%';
    const avgMs = Math.round(s.totalMs / s.total) + 'ms';
    const color = pct >= 99 ? GR : pct >= 90 ? YL : RD;
    const curIcon = statusIcon(s.lastStatus);
    const displayName = name.length > 20 ? name.slice(0, 20) + '…' : name;

    console.log(`  ${displayName.padEnd(W.name)}${color}${pctStr.padEnd(W.uptime)}${R}${avgMs.padEnd(W.avg)}${GY}${String(s.total).padEnd(W.checks)}${R}${curIcon} ${statusColor(s.lastStatus)}${s.lastStatus}${R}`);
  }

  console.log(`${GY}${'─'.repeat(lineW)}${R}\n`);
}

// ── Web Dashboard ───────────────────────────────────────────────────────

function renderDashboardHTML(data) {
  const hist = loadHistory().slice(-30);
  const sparks = {};
  for (const e of hist) for (const r of e.results) (sparks[r.name] ??= []).push(r.status);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sc = s => s === 'UP' ? 'up' : s === 'SLOW' ? 'slow' : 'down';
  const rows = data.results.map(r => {
    const dots = (sparks[r.name] || []).slice(-24).map(s => `<i class="${sc(s)}"></i>`).join('');
    return `<tr><td>${esc(r.name)}</td><td><b class="${sc(r.status)}">${r.status}</b></td><td>${r.responseTime}ms</td><td class="dim">${esc(r.detail)}</td><td class="spark">${dots}</td></tr>`;
  }).join('');
  const { up, down, slow, total } = data.summary;
  const time = new Date(data.checkedAt).toLocaleTimeString('en-US', { hour12: false });
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Health Monitor</title><meta http-equiv="refresh" content="30">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'JetBrains Mono','SF Mono',monospace;background:#0a0a0f;color:#e0e0e8;padding:24px;max-width:960px;margin:0 auto;line-height:1.5}h1{color:#67e8f9;font-size:1.4rem;margin-bottom:4px}.sub{color:#666;font-size:.85rem;margin-bottom:24px}.stats{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px}.sc{background:#12121a;border:1px solid #1e1e2e;border-radius:8px;padding:16px 20px;flex:1;min-width:120px}.sc .v{font-size:1.8rem;font-weight:700}.sc .l{font-size:.75rem;color:#666;text-transform:uppercase;letter-spacing:.5px}.green{color:#4ade80}.red{color:#f87171}.yellow{color:#facc15}.cyan{color:#67e8f9}table{width:100%;border-collapse:collapse;margin-top:12px}td{padding:8px 12px;border-bottom:1px solid #1a1a24;font-size:.85rem}tr:hover{background:#111118}b.up{color:#4ade80}b.slow{color:#facc15}b.down{color:#f87171}.dim{color:#555}.spark{white-space:nowrap}.spark i{display:inline-block;width:6px;height:16px;margin:0 1px;border-radius:2px;vertical-align:middle}.spark i.up{background:#4ade80}.spark i.slow{background:#facc15}.spark i.down{background:#f87171}footer{text-align:center;color:#333;font-size:.75rem;margin-top:32px}</style></head>
<body><h1>⚡ Health Monitor</h1><div class="sub">${time} · Auto-refreshes every 30s</div>
<div class="stats"><div class="sc"><div class="v cyan">${total}</div><div class="l">Services</div></div><div class="sc"><div class="v green">${up}</div><div class="l">Up</div></div><div class="sc"><div class="v ${down > 0 ? 'red' : 'green'}">${down}</div><div class="l">Down</div></div><div class="sc"><div class="v ${slow > 0 ? 'yellow' : 'green'}">${slow}</div><div class="l">Slow</div></div></div>
<table><tr style="color:#888;font-size:.75rem;text-transform:uppercase;letter-spacing:1px"><td>Service</td><td>Status</td><td>Time</td><td>Detail</td><td>Uptime (recent)</td></tr>${rows}</table>
<footer>health-monitor · ${new Date().toISOString().split('T')[0]}</footer></body></html>`;
}

async function serveDashboard() {
  const noCacheHeaders = { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' };
  const server = createServer(async (req, res) => {
    try {
      const data = await cachedCheck();
      if (req.url === '/api/data') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...noCacheHeaders });
        res.end(JSON.stringify(data));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noCacheHeaders });
        res.end(renderDashboardHTML(data));
      }
    } catch (err) {
      console.error(`${RD}Request error: ${err.message}${R}`);
      if (!res.headersSent) {
        if (req.url === '/api/data') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Health check failed', detail: err.message }));
        } else {
          // Return a styled error page instead of raw JSON
          const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="30">
<title>Health Monitor — Error</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'JetBrains Mono','SF Mono',monospace;background:#0a0a0f;color:#e0e0e8;padding:48px;max-width:600px;margin:60px auto;text-align:center}h1{color:#f87171;font-size:1.4rem;margin-bottom:16px}.msg{color:#888;font-size:.9rem;margin-bottom:24px;line-height:1.6}.detail{background:#12121a;border:1px solid #2a1a1a;border-radius:8px;padding:16px;color:#f87171;font-size:.8rem;word-break:break-all}footer{color:#333;font-size:.75rem;margin-top:32px}</style></head>
<body><h1>⚡ Health Check Failed</h1><div class="msg">Unable to complete health checks. Retrying in 30 seconds…</div>
<div class="detail">${esc(err.message)}</div><footer>health-monitor · ${new Date().toISOString().split('T')[0]}</footer></body></html>`);
        }
      }
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`${RD}Fatal: Port ${PORT} is already in use.${R} Stop the other process or choose a different port.`);
    } else {
      console.error(`${RD}Server error: ${err.message}${R}`);
    }
    process.exit(2);
  });

  // ── Graceful Shutdown ───────────────────────────────────────────────
  const shutdown = (signal) => {
    console.log(`\n  ${YL}Received ${signal}, shutting down gracefully…${R}`);
    server.close(() => {
      console.log(`  ${GY}Server closed.${R}`);
      process.exit(0);
    });
    // Force exit after 10s if connections don't drain
    setTimeout(() => {
      console.error(`  ${RD}Forcing exit after 10s timeout.${R}`);
      process.exit(1);
    }, 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(PORT, () => {
    console.log(`\n  ${B}${CY}⚡ Health Monitor${R} serving at ${B}http://localhost:${PORT}${R}`);
    console.log(`  ${GY}API: http://localhost:${PORT}/api/data${R}`);
    console.log(`  ${GY}Auto-refreshes every 30s · Results cached ${CHECK_CACHE_TTL_MS / 1000}s${R}\n`);
  });
}

// ── Alerting ────────────────────────────────────────────────────────────

function processAlerts(results) {
  let prev = {};
  if (existsSync(LAST_STATUS_PATH)) try { prev = JSON.parse(readFileSync(LAST_STATUS_PATH, 'utf8')); } catch (e) {
    console.error(`${YL}Warning: last-status.json corrupted, resetting alert state: ${e.message}${R}`);
  }
  const transitions = [];
  for (const r of results) {
    if (!(r.name in prev)) continue; // Skip on first-ever check for this service
    const p = prev[r.name];
    if ((p === 'DOWN') !== (r.status === 'DOWN')) {
      transitions.push({ timestamp: r.checkedAt, service: r.name, from: p, to: r.status, type: r.status === 'DOWN' ? 'outage' : 'recovery' });
    }
  }
  // Persist current status map
  const map = {};
  for (const r of results) map[r.name] = r.status;
  try { writeFileSync(LAST_STATUS_PATH, JSON.stringify(map)); } catch (e) {
    console.error(`${YL}Warning: Failed to save status map: ${e.message}${R}`);
  }
  if (!transitions.length) return transitions;
  // Append to rolling alert log
  let log = [];
  if (existsSync(ALERTS_PATH)) try { log = JSON.parse(readFileSync(ALERTS_PATH, 'utf8')); } catch {}
  log.push(...transitions);
  if (log.length > ALERTS_MAX) log = log.slice(-ALERTS_MAX);
  try { writeFileSync(ALERTS_PATH, JSON.stringify(log, null, 2)); } catch (e) {
    console.error(`${YL}Warning: Failed to save alert log: ${e.message}${R}`);
  }
  // Notify: console output + mail thread for outages
  const threadDir = '/Users/user/.openclaw/mail/threads';
  for (const t of transitions) {
    const icon = t.type === 'outage' ? `${RD}▼` : `${GR}▲`;
    console.log(`  ${icon} ${B}${t.service}${R} ${t.from} → ${t.to}`);
    if (t.type === 'outage' && existsSync(threadDir)) {
      try {
        const slug = `health-alert-${t.service.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        const fp = join(threadDir, `${slug}.md`);
        if (!existsSync(fp)) writeFileSync(fp, `---\nproject: health-monitor\nagents: [claude]\nstatus: active\npriority: high\ncreated: ${t.timestamp}\nupdated: ${t.timestamp}\n---\n\n[health-monitor, ${t.timestamp}]\n🔴 **${t.service}** went DOWN (was ${t.from}).\nThis is an automated alert from health-monitor.\n`);
      } catch (e) { console.error(`${YL}Warning: Failed to create alert thread: ${e.message}${R}`); }
    }
  }
  return transitions;
}

function printAlerts() {
  let log = [];
  if (existsSync(ALERTS_PATH)) try { log = JSON.parse(readFileSync(ALERTS_PATH, 'utf8')); } catch {}
  if (!log.length) { console.log(`\n  ${GY}No alerts recorded yet.${R}\n`); return; }
  console.log(`\n${B}${CY}⚡ Health Monitor — Alerts${R}  ${GY}(${log.length} total, showing last 20)${R}\n`);
  for (const a of log.slice(-20)) {
    const icon = a.type === 'outage' ? `${RD}▼${R}` : `${GR}▲${R}`;
    const ts = new Date(a.timestamp).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    console.log(`  ${GY}${ts}${R}  ${icon} ${a.service.padEnd(20)}  ${a.from} → ${a.to}`);
  }
  console.log('');
}

// ── CLI Entrypoint ──────────────────────────────────────────────────────

function statusColor(status) {
  if (status === STATUS.UP) return GR;
  if (status === STATUS.SLOW) return YL;
  return RD;
}

function statusIcon(status) {
  if (status === STATUS.UP) return `${GR}●${R}`;
  if (status === STATUS.SLOW) return `${YL}●${R}`;
  return `${RD}●${R}`;
}

function formatCheckedAt(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function printResults(data) {
  const { results, summary, checkedAt } = data;
  const time = new Date(checkedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  console.log(`\n${B}${CY}⚡ Health Monitor${R}  ${GY}${time}${R}\n`);

  // Column widths
  const W = { name: 22, status: 10, time: 10, checked: 12 };
  const lineW = 2 + W.name + W.status + W.time + W.checked + 14; // +14 for "Detail" col

  console.log(`${GY}${'─'.repeat(lineW)}${R}`);
  console.log(`  ${B}${'Service'.padEnd(W.name)}${'Status'.padEnd(W.status)}${'Time'.padEnd(W.time)}${'Checked'.padEnd(W.checked)}Detail${R}`);
  console.log(`${GY}${'─'.repeat(lineW)}${R}`);

  for (const r of results) {
    const color = statusColor(r.status);
    const icon = statusIcon(r.status);
    const name = r.name.length > 20 ? r.name.slice(0, 20) + '…' : r.name;
    const timeStr = `${r.responseTime}ms`;
    const checked = formatCheckedAt(r.checkedAt);
    console.log(`  ${name.padEnd(W.name)}${icon} ${color}${r.status.padEnd(W.status - 2)}${R}${timeStr.padEnd(W.time)}${GY}${checked.padEnd(W.checked)}${r.detail}${R}`);
  }

  console.log(`${GY}${'─'.repeat(lineW)}${R}`);
  const statusLine = [
    `${GR}${summary.up} up${R}`,
    summary.slow > 0 ? `${YL}${summary.slow} slow${R}` : null,
    summary.down > 0 ? `${RD}${summary.down} down${R}` : null,
  ].filter(Boolean).join('  ');
  console.log(`  ${B}${summary.total} services${R}  ${statusLine}\n`);
}

async function main() {
  // Catch unhandled rejections to prevent silent daemon crashes (especially in --serve mode)
  process.on('unhandledRejection', (reason) => {
    console.error(`${RD}Unhandled rejection: ${reason instanceof Error ? reason.message : reason}${R}`);
  });

  const args = process.argv.slice(2);

  // --history: show uptime stats from saved history (no live check)
  if (args.includes('--history')) {
    printHistory();
    return;
  }

  if (args.includes('--alerts')) {
    printAlerts();
    return;
  }

  if (args.includes('--json')) {
    const data = await check();
    appendHistory(data);
    processAlerts(data.results);
    console.log(JSON.stringify(data, null, 2));
    process.exit(data.summary.down > 0 ? 1 : 0);
    return;
  }

  if (args.includes('--serve')) {
    await serveDashboard();
    return;
  }

  // Default: CLI table output
  const data = await check();
  appendHistory(data);
  processAlerts(data.results);
  printResults(data);
  process.exit(data.summary.down > 0 ? 1 : 0);
}

// Only run CLI when executed directly (not when imported as module)
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('index.mjs') ||
  process.argv[1].endsWith('health-monitor/index.mjs')
);
if (isDirectRun) {
  main().catch((err) => {
    console.error(`${RD}Fatal: ${err.message}${R}`);
    process.exit(2);
  });
}
