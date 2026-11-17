const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRetryAfter, nextDelay, firstDelay, reviveCached, rollWindow, BASE_MS, FAST_MS, MAX_BACKOFF_MS } = require('../src/main/sources/claude-poll');

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const HOUR = 3600e3;

test('Retry-After as seconds or HTTP date', () => {
  assert.equal(parseRetryAfter('120', NOW), 120e3);
  assert.equal(parseRetryAfter(new Date(NOW + 90e3).toUTCString(), NOW), 90e3);
  assert.equal(parseRetryAfter(new Date(NOW - 90e3).toUTCString(), NOW), 0);
  assert.equal(parseRetryAfter(null, NOW), null);
  assert.equal(parseRetryAfter('soon', NOW), null);
});

test('normal pace is slow, fast only near a limit while burning', () => {
  const limits = [{ percent: 85, resetsAt: NOW + HOUR }];
  assert.equal(nextDelay({ status: 200, limits, burning: false, now: NOW }), BASE_MS);
  assert.equal(nextDelay({ status: 200, limits: [{ percent: 40, resetsAt: NOW + HOUR }], burning: true, now: NOW }), BASE_MS);
  assert.equal(nextDelay({ status: 200, limits, burning: true, now: NOW }), FAST_MS);
  assert.equal(nextDelay({ status: 200, limits: [{ percent: 85, resetsAt: NOW - 1 }], burning: true, now: NOW }), BASE_MS);
});

test('429 uses Retry-After only when it asks for a longer wait than the backoff', () => {
  assert.equal(nextDelay({ status: 429, retryAfterMs: 30 * 60e3, prevDelay: BASE_MS, now: NOW }), 30 * 60e3);
  assert.equal(nextDelay({ status: 429, retryAfterMs: 0, prevDelay: BASE_MS, now: NOW }), 2 * BASE_MS); // what the server really sends
  assert.equal(nextDelay({ status: 429, retryAfterMs: 5e3, prevDelay: BASE_MS, now: NOW }), 2 * BASE_MS);
  assert.equal(nextDelay({ status: 429, retryAfterMs: 5 * 3600e3, prevDelay: BASE_MS, now: NOW }), 3600e3);
});

test('429 without Retry-After backs off exponentially up to the cap', () => {
  let d = BASE_MS;
  const seen = [];
  for (let i = 0; i < 5; i++) { d = nextDelay({ status: 429, retryAfterMs: null, prevDelay: d, now: NOW }); seen.push(d); }
  assert.deepEqual(seen, [2 * BASE_MS, 4 * BASE_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
});

test('429 right after fast polling still waits twice the normal pace', () => {
  assert.equal(nextDelay({ status: 429, prevDelay: FAST_MS, now: NOW }), 2 * BASE_MS);
});

test('network errors and other statuses retry at the normal pace', () => {
  assert.equal(nextDelay({ status: 0, now: NOW }), BASE_MS);
  assert.equal(nextDelay({ status: 503, now: NOW }), BASE_MS);
});

test('first poll keeps the minimum gap and finishes a running backoff', () => {
  assert.equal(firstDelay({}, NOW), 0);
  assert.equal(firstDelay({ fetchedAt: NOW - 20e3 }, NOW), 40e3);
  assert.equal(firstDelay({ fetchedAt: NOW - 5 * 60e3 }, NOW), 0);
  assert.equal(firstDelay({ fetchedAt: NOW - 30 * 60e3, retryUntil: NOW + 4 * 60e3 }, NOW), 4 * 60e3);
  assert.equal(firstDelay({ fetchedAt: NOW - 30 * 60e3, retryUntil: NOW - 60e3 }, NOW), 0);
});

test('cache is used only for the same logged-in account', () => {
  const cache = { account: 'acc-1', fetchedAt: NOW - 60e3, limits: [{ key: 'claude:session', percent: 50 }], retryUntil: NOW + 60e3, delay: 6 * 60e3, rates: { 'claude:session': 0.5 } };
  const r = reviveCached(cache, 'acc-1');
  assert.equal(r.limits.length, 1);
  assert.equal(r.retryUntil, NOW + 60e3);
  assert.equal(r.delay, 6 * 60e3);
  assert.deepEqual(r.rates, { 'claude:session': 0.5 });
  assert.equal(reviveCached(cache, 'acc-2'), null);   // switched account
  assert.equal(reviveCached(cache, null), null);      // logged out
  assert.equal(reviveCached({}, 'acc-1'), null);
  assert.equal(reviveCached(null, 'acc-1'), null);
});

test('window that has not ended is left alone', () => {
  const l = { kind: 'session', percent: 60, resetsAt: NOW + HOUR, windowSec: 5 * 3600 };
  assert.equal(rollWindow(l, NOW, () => null), l);
});

test('weekly window rolls forward on its fixed schedule', () => {
  const l = { kind: 'weekly', percent: 70, resetsAt: NOW - 2 * HOUR, windowSec: 7 * 86400 };
  const r = rollWindow(l, NOW, () => null);
  assert.equal(r.percent, 0);
  assert.equal(r.resetsAt, NOW - 2 * HOUR + 7 * 86400e3);
  assert.equal(r.rolled, true);
});

test('5h window restarts with the first message after the reset, or waits for it', () => {
  const l = { kind: 'session', percent: 93, resetsAt: NOW - HOUR, windowSec: 5 * 3600 };
  const started = rollWindow(l, NOW, t => (t === NOW - HOUR ? NOW - 30 * 60e3 : null));
  assert.deepEqual([started.percent, started.resetsAt], [0, NOW - 30 * 60e3 + 5 * HOUR]);
  const idle = rollWindow(l, NOW, () => null);
  assert.deepEqual([idle.percent, idle.resetsAt], [0, null]);
});
