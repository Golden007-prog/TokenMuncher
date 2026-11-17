const test = require('node:test');
const assert = require('node:assert/strict');
const { burning, secondsToFull, runoutBeforeReset, MIN_SPEED } = require('../src/shared/forecast');

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const HOUR = 3600e3;

test('idle below the minimum speed', () => {
  assert.equal(burning({ v: MIN_SPEED / 2 }), false);
  assert.equal(secondsToFull({ est: 50, v: MIN_SPEED / 2 }), Infinity);
  assert.equal(burning({ v: MIN_SPEED }), true);
});

test('seconds to full', () => {
  assert.equal(secondsToFull({ est: 70, v: 30 / 3600 }), 3600);
});

test('runs out only when 100% comes before the reset', () => {
  const l = { est: 70, v: 30 / 3600 };                       // full in 1 h
  assert.equal(runoutBeforeReset({ ...l, resetsAt: NOW + 2 * HOUR }, NOW), 3600);
  assert.equal(runoutBeforeReset({ ...l, resetsAt: NOW + 30 * 60e3 }, NOW), null);
  assert.equal(runoutBeforeReset({ ...l, resetsAt: null }, NOW), null);
  assert.equal(runoutBeforeReset({ est: 100, v: 1, resetsAt: NOW + HOUR }, NOW), null); // already full
  assert.equal(runoutBeforeReset({ est: 50, v: 0, resetsAt: NOW + HOUR }, NOW), null);  // idle
});
