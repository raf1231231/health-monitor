import { describe, it, expect } from 'vitest';
import { formatUptime, getStatusFromResponseTime, validateService, STATUS } from './utils.mjs';

describe('formatUptime', () => {
  it('formats seconds', () => {
    expect(formatUptime(5000)).toBe('5s');
  });

  it('formats minutes', () => {
    expect(formatUptime(120000)).toBe('2m');
  });

  it('formats hours and minutes', () => {
    expect(formatUptime(3661000)).toBe('1h 1m');
  });

  it('formats days and hours', () => {
    expect(formatUptime(90000000)).toBe('1d 1h');
  });

  it('handles zero', () => {
    expect(formatUptime(0)).toBe('0s');
  });
});

describe('getStatusFromResponseTime', () => {
  it('returns UP for fast response when ok', () => {
    expect(getStatusFromResponseTime(100, true)).toBe(STATUS.UP);
  });

  it('returns SLOW for slow response when ok', () => {
    expect(getStatusFromResponseTime(3000, true)).toBe(STATUS.SLOW);
  });

  it('returns DOWN when not ok', () => {
    expect(getStatusFromResponseTime(100, false)).toBe(STATUS.DOWN);
  });

  it('returns DOWN for slow response when not ok', () => {
    expect(getStatusFromResponseTime(5000, false)).toBe(STATUS.DOWN);
  });
});

describe('validateService', () => {
  it('returns empty array for valid http service', () => {
    const errors = validateService({ name: 'test', type: 'http', url: 'http://localhost' });
    expect(errors).toHaveLength(0);
  });

  it('returns empty array for valid port service', () => {
    const errors = validateService({ name: 'test', type: 'port', port: 3000 });
    expect(errors).toHaveLength(0);
  });

  it('returns empty array for valid pm2 service', () => {
    const errors = validateService({ name: 'test', type: 'pm2', process: 'myapp' });
    expect(errors).toHaveLength(0);
  });

  it('returns error for missing name', () => {
    const errors = validateService({ type: 'http', url: 'http://localhost' });
    expect(errors).toContain('missing name');
  });

  it('returns error for missing type', () => {
    const errors = validateService({ name: 'test' });
    expect(errors).toContain('missing type');
  });

  it('returns error for unknown type', () => {
    const errors = validateService({ name: 'test', type: 'invalid' });
    expect(errors.some(e => e.includes('unknown type'))).toBe(true);
  });

  it('returns error for http without url', () => {
    const errors = validateService({ name: 'test', type: 'http' });
    expect(errors).toContain('http type requires url');
  });

  it('returns error for port without port', () => {
    const errors = validateService({ name: 'test', type: 'port' });
    expect(errors).toContain('port type requires port');
  });

  it('returns error for pm2 without process', () => {
    const errors = validateService({ name: 'test', type: 'pm2' });
    expect(errors).toContain('pm2 type requires process');
  });
});
