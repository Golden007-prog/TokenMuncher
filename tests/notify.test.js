const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/main/notify');

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const HOUR = 3600e3;
const lim = (o = {}) => ({ key: 'claude:session', provider: 'claude', kind: 'session', name: '5h window', percent: 10, est: 10, v: 0, resetsAt: NOW + 2 * HOUR, ...o });
const run = (state, limits, now = NOW) => evaluate(state, limits, now);

test('nothing below 80%', () => {
  const r = run({}, [lim({ est: 79.9 })]);
  assert.equal(r.notifications.length, 0);
});

test('crossing 80% notifies once per window', () => {
  let r = run({}, [lim({ est: 81 })]);
  assert.equal(r.notifications.length, 1);
  assert.equal(r.notifications[0].level, 80);
  r = run(r.state, [lim({ est: 85 })]);
  assert.equal(r.notifications.length, 0);
});

test('jumping past several thresholds sends only the highest', () => {
  const r = run({}, [lim({ est: 95 })]);
  assert.equal(r.notifications.length, 1);
  assert.equal(r.notifications[0].level, 90);
  assert.deepEqual(r.state['claude:session'].sent, [80, 90]);
});

test('100% says limit reached, but only when the server reports it', () => {
  let r = run({}, [lim({ est: 100, percent: 95 })]);
  assert.equal(r.notifications[0].level, 90);
  r = run(r.state, [lim({ est: 100, percent: 100 })]);
  assert.match(r.notifications[0].title, /limit reached/);
});

test('reset time shifting or briefly missing keeps the window', () => {
  let r = run({}, [lim({ est: 85 })]);
  r = run(r.state, [lim({ est: 86, resetsAt: NOW + 3 * HOUR })]);   // server moved the reset
  assert.equal(r.notifications.length, 0);
  assert.equal(r.state['claude:session'].resetsAt, NOW + 3 * HOUR);
  r = run(r.state, [lim({ est: 86, resetsAt: null })]);             // one poll without a date
  assert.equal(r.notifications.length, 0);
  r = run(r.state, [lim({ est: 87, resetsAt: NOW + 3 * HOUR })]);
  assert.equal(r.notifications.length, 0);
  assert.deepEqual(r.state['claude:session'].sent, [80]);
});

test('limit without a reset date starts over after a big drop', () => {
  const nodate = o => lim({ key: 'copilot:chat', kind: 'monthly', resetsAt: null, ...o });
  let r = run({}, [nodate({ est: 85 })]);
  r = run(r.state, [nodate({ est: 5 })]);
  assert.equal(r.notifications[0].kind, 'reset');
  r = run(r.state, [nodate({ est: 82 })]);
  assert.equal(r.notifications[0].level, 80);
});

test('reset that happened while the app was closed is not announced', () => {
  const r0 = run({}, [lim({ est: 92 })]);
  const days = NOW + 3 * 24 * HOUR;
  const r = run(r0.state, [lim({ est: 12, resetsAt: days + 2 * HOUR })], days);
  assert.equal(r.notifications.length, 0);
  assert.deepEqual(r.state['claude:session'].sent, []);
});

test('stale reading whose reset time already passed is skipped', () => {
  const r0 = run({}, [lim({ est: 92 })]);
  const later = NOW + 2 * HOUR + 1000;
  const r = run(r0.state, [lim({ est: 92 })], later);   // same old resetsAt, now in the past
  assert.equal(r.notifications.length, 0);
  assert.equal(r.state['claude:session'], r0.state['claude:session']);
});

test('reset jitter under 5 min is the same window', () => {
  let r = run({}, [lim({ est: 85 })]);
  r = run(r.state, [lim({ est: 86, resetsAt: NOW + 2 * HOUR + 400 })]);
  assert.equal(r.notifications.length, 0);
});

test('reset after a busy window notifies, then thresholds start over', () => {
  let r = run({}, [lim({ est: 92 })]);
  const later = NOW + 2 * HOUR + 1000;
  r = run(r.state, [lim({ est: 0, percent: 0, resetsAt: later + 5 * HOUR })], later);
  assert.equal(r.notifications.length, 1);
  assert.equal(r.notifications[0].kind, 'reset');
  r = run(r.state, [lim({ est: 81, resetsAt: later + 5 * HOUR })], later);
  assert.equal(r.notifications[0].level, 80);
});

test('reset of a quiet window stays silent', () => {
  let r = run({}, [lim({ est: 40 })]);
  const later = NOW + 2 * HOUR + 1000;
  r = run(r.state, [lim({ est: 0, resetsAt: later + 5 * HOUR })], later);
  assert.equal(r.notifications.length, 0);
});

test('window that stopped (resetsAt becomes null) counts as a reset', () => {
  let r = run({}, [lim({ est: 88 })]);
  const later = NOW + 2 * HOUR + 1000;
  r = run(r.state, [lim({ est: 0, percent: 0, resetsAt: null })], later);
  assert.equal(r.notifications[0].kind, 'reset');
});

test('forecast fires when the limit runs out within 30 min, before reset', () => {
  // 75% used, burning 1%/min -> 25% left lasts 25 min, reset is 2 h away
  const r = run({ 'claude:session': { resetsAt: NOW + 2 * HOUR, sent: [], forecast: false, peak: 75 } },
    [lim({ est: 75, v: 1 / 60 })]);
  const f = r.notifications.find(n => n.kind === 'forecast');
  assert.ok(f, 'forecast expected');
  assert.match(f.title, /~25 min/);
  const again = run(r.state, [lim({ est: 76, v: 1 / 60 })]);
  assert.equal(again.notifications.filter(n => n.kind === 'forecast').length, 0);
});

test('no forecast when reset comes first, when early in window, or for weekly limits', () => {
  assert.equal(run({}, [lim({ est: 75, v: 1 / 60, resetsAt: NOW + 10 * 60e3 })]).notifications.length, 0);
  assert.equal(run({}, [lim({ est: 40, v: 10 / 60 })]).notifications.length, 0);
  const weekly = lim({ key: 'claude:weekly', kind: 'weekly', name: 'weekly', est: 75, v: 1 / 60, resetsAt: NOW + 3 * 24 * HOUR });
  assert.equal(run({}, [weekly]).notifications.length, 0);
});

test('limits are tracked independently', () => {
  const r = run({}, [lim({ est: 81 }), lim({ key: 'cursor:auto', provider: 'cursor', kind: 'monthly', name: 'auto + composer', est: 91 })]);
  assert.deepEqual(r.notifications.map(n => n.level), [80, 90]);
});
