// Health Monitor - Pure Utility Functions
// Extracted for testability

export const STATUS = { UP: 'UP', DOWN: 'DOWN', SLOW: 'SLOW' };
export const SLOW_THRESHOLD_MS = 2000;

/** Format milliseconds to human-readable uptime string */
export function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Determine status based on response time */
export function getStatusFromResponseTime(responseTime, ok) {
  if (!ok) return STATUS.DOWN;
  if (responseTime > SLOW_THRESHOLD_MS) return STATUS.SLOW;
  return STATUS.UP;
}

/** Validate service configuration */
export function validateService(svc) {
  const errors = [];
  if (!svc.name) errors.push('missing name');
  if (!svc.type) errors.push('missing type');
  if (svc.type && !['http', 'port', 'pm2'].includes(svc.type)) {
    errors.push(`unknown type: ${svc.type}`);
  }
  if (svc.type === 'http' && !svc.url) errors.push('http type requires url');
  if (svc.type === 'port' && !svc.port) errors.push('port type requires port');
  if (svc.type === 'pm2' && !svc.process) errors.push('pm2 type requires process');
  return errors;
}
