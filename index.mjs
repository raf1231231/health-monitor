#!/usr/bin/env node
/**
 * health-monitor — Service Health Checker for Mac Mini
 *
 * Pings all configured services and reports their status.
 *
 * Usage:
 *   node index.mjs              # CLI health check
 *   node index.mjs --serve      # Web dashboard on port 3851
 *   node index.mjs --history    # Show uptime history (24h)
 *   node index.mjs --json       # Output raw JSON
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_PATH = join(__dirname, 'services.json');
const HISTORY_PATH = join(__dirname, 'history.json');
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Status Constants ────────────────────────────────────────────────────
const STATUS = { UP: 'UP', DOWN: 'DOWN', SLOW: 'SLOW' };
const SLOW_THRESHOLD_MS = 2000;

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
  const services = JSON.parse(raw);
  if (!Array.isArray(services)) {
    throw new Error('services.json must be a JSON array');
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

/**
 * HTTP health check — fetch a URL, check for 2xx response
 * @param {Object} svc - { name, url, timeout? }
 * @returns {Object} { name, type, status, responseTime, detail }
 */
async function checkHttp(svc) {
  const timeout = svc.timeout || 3000;
  const start = performance.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(svc.url, { signal: controller.signal });
    clearTimeout(timer);
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

/**
 * Port-open check — attempt TCP connection
 * @param {Object} svc - { name, port, host?, timeout? }
 * @returns {Object} { name, type, status, responseTime, detail }
 */
async function checkPort(svc) {
  const timeout = svc.timeout || 3000;
  const host = svc.host || 'localhost';
  const start = performance.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({
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
      clearTimeout(timer);
      socket.destroy();
      const elapsed = Math.round(performance.now() - start);
      resolve({
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
      clearTimeout(timer);
      socket.destroy();
      resolve({
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

/**
 * pm2 process status — parses `pm2 jlist` output
 * Returns one result per pm2 process
 * @param {Object} svc - { name }
 * @returns {Object[]} Array of results, one per pm2 process
 */
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

/**
 * Run health checks on all configured services.
 * @param {Object} [options] - { services?: array, concurrency?: number }
 * @returns {Promise<Object>} { results: [...], summary: { total, up, down, slow }, checkedAt }
 */
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

  const allResults = await Promise.all(promises);
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

// ── History Log ─────────────────────────────────────────────────────────

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Append check results to history.json and prune entries older than 7 days.
 * Stores compact snapshots: { checkedAt, results: [{ name, status, responseTime }] }
 */
function appendHistory(data) {
  const history = loadHistory();
  history.push({
    checkedAt: data.checkedAt,
    results: data.results.map(r => ({
      name: r.name,
      status: r.status,
      responseTime: r.responseTime,
    })),
  });
  // Prune entries older than 7 days
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  const pruned = history.filter(entry => new Date(entry.checkedAt).getTime() > cutoff);
  writeFileSync(HISTORY_PATH, JSON.stringify(pruned, null, 2));
}

/**
 * Compute and print uptime % per service over the last 24 hours.
 */
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
  const args = process.argv.slice(2);

  // --history: show uptime stats from saved history (no live check)
  if (args.includes('--history')) {
    printHistory();
    return;
  }

  if (args.includes('--json')) {
    const data = await check();
    appendHistory(data);
    console.log(JSON.stringify(data, null, 2));
    process.exit(data.summary.down > 0 ? 1 : 0);
    return;
  }

  // Default: CLI table output
  if (!args.includes('--serve')) {
    const data = await check();
    appendHistory(data);
    printResults(data);
    process.exit(data.summary.down > 0 ? 1 : 0);
  }
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
