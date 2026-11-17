const test = require('node:test');
const assert = require('node:assert/strict');
const { shortName, pickMiniLimits, pickHeadline } = require('../src/shared/mini');

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const HOUR = 3600e3;
const L = (key, est, o = {}) => ({ key, provider: key.split(':')[0], name: o.name || key.split(':')[1], est, percent: Math.floor(est), v: 0, resetsAt: NOW + 2 * HOUR, ...o });

test('short names', () => {
  assert.equal(shortName('5h window'), '5h');
  assert.equal(shortName('weekly'), 'wk');
  assert.equal(shortName('weekly fable'), 'fable wk');
  assert.equal(shortName('auto + composer'), 'auto');
  assert.equal(shortName('something new'), 'something new');
});

test('picks the four most-used limits, highest first, stable on ties', () => {
  const ls = [L('claude:a', 10), L('claude:b', 60), L('cursor:c', 5), L('copilot:d', 60), L('codex:e', 30), L('claude:f', 0)];
  assert.deepEqual(pickMiniLimits(ls).map(l => l.key), ['claude:b', 'copilot:d', 'codex:e', 'claude:a']);
  assert.deepEqual(pickMiniLimits(ls, 2).map(l => l.key), ['claude:b', 'copilot:d']);
  assert.deepEqual(pickMiniLimits([]), []);
  assert.deepEqual(pickMiniLimits(undefined), []);
});

test('headline: nothing to show without limits', () => {
  assert.deepEqual(pickHeadline([], NOW), { kind: 'none' });
});

test('headline: all fit when nothing runs out before reset', () => {
  const ls = [L('claude:5h window', 40, { v: 1 / 3600 })]; // 1 %/h, 60 % left, reset in 2 h
  assert.equal(pickHeadline(ls, NOW).kind, 'ok');
});

test('headline: the limit that runs out soonest', () => {
  const ls = [
    L('claude:5h window', 70, { v: 30 / 3600 }),                          // 30 %/h -> 1 h
    L('claude:weekly', 90, { v: 20 / 3600, resetsAt: NOW + 48 * HOUR }) // 20 %/h -> 30 min
  ];
  const h = pickHeadline(ls, NOW);
  assert.equal(h.kind, 'runout');
  assert.equal(h.label, 'claude wk');
  assert.equal(h.at, NOW + 30 * 60e3);
});

test('headline: a limit at 100% wins', () => {
  const ls = [L('claude:5h window', 70, { v: 30 / 3600 }), L('cursor:auto + composer', 100)];
  assert.deepEqual(pickHeadline(ls, NOW), { kind: 'reached', label: 'cursor auto' });
});
