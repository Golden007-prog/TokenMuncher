const test = require('node:test');
const assert = require('node:assert/strict');
const { Store, startOfDay } = require('../src/main/store');
const { Aggregator } = require('../src/main/aggregate');

// A store with one Claude response 10 s ago: 1000 tokens, 900 of them cache reads,
// and one Cursor response with no cache reads.
function setup() {
  const S = new Store();
  const now = Date.now();
  const ts = Math.max(now - 10e3, startOfDay(now) + 1); // today even in the first seconds after midnight
  S.session('claude:a', { provider: 'claude', project: 'p', app: 'Claude Code', model: 'claude-opus-4-5' }).lastTs = ts;
  S.addRecord('a', { ts, provider: 'claude', sid: 'claude:a', project: 'p', app: 'Claude Code', model: 'claude-opus-4-5', fam: 'opus', in: 50, out: 50, cr: 900, cw: 0, total: 1000, cost: 1 });
  S.session('cursor:b', { provider: 'cursor', project: 'q', app: 'Cursor', model: 'gpt-5' }).lastTs = ts;
  S.addRecord('b', { ts, provider: 'cursor', sid: 'cursor:b', project: 'q', app: 'Cursor', model: 'gpt-5', fam: 'cursor', in: 100, out: 20, cr: 0, cw: 0, total: 120, cost: 0.1 });
  const src = id => ({ id, enabled: true, status: () => ({ id, label: id }), limits: () => [] });
  return { S, sources: [src('claude'), src('cursor')] };
}

const pick = snap => ({
  rate: Math.round(snap.burn.rate * 60), // tokens in the last minute
  sessions: Object.fromEntries(snap.sessions.map(s => [s.sid, s.tokens])),
  models: Object.fromEntries(snap.models.map(m => [m.name, m.tokens])),
  today: snap.hist[6].fam,
  top: Object.fromEntries(snap.topWeek.map(p => [p.project, p.tokens]))
});

test('token counts include cache reads by default', () => {
  const { S, sources } = setup();
  const snap = new Aggregator(S, sources).snapshot(true);
  assert.equal(snap.countsCacheReads, true);
  const v = pick(snap);
  assert.equal(v.rate, 1120);
  assert.deepEqual(v.sessions, { 'claude:a': 1000, 'cursor:b': 120 });
  assert.deepEqual(v.today, { opus: 1000, cursor: 120 });
  assert.deepEqual(v.top, { p: 1000, q: 120 });
});

test('without cache reads every token count drops them, costs stay', () => {
  const { S, sources } = setup();
  const snap = new Aggregator(S, sources, { countCacheReads: () => false }).snapshot(true);
  assert.equal(snap.countsCacheReads, false);
  const v = pick(snap);
  assert.equal(v.rate, 220);
  assert.deepEqual(v.sessions, { 'claude:a': 100, 'cursor:b': 120 });
  assert.deepEqual(v.today, { opus: 100, cursor: 120 });
  assert.deepEqual(v.top, { p: 100, q: 120 });
  assert.equal(snap.types.cr, 900, 'the token-type panel still shows cache reads');
  assert.equal(Math.round(snap.api.today * 10) / 10, 1.1, 'API-price cost unchanged');
});

test('a source switched off drops out of providers, sessions and counts', () => {
  const { S, sources } = setup();
  sources[1].off = true;
  const snap = new Aggregator(S, sources).snapshot(true);
  assert.deepEqual(snap.providers.map(p => p.id), ['claude']);
  assert.deepEqual(Object.keys(pick(snap).sessions), ['claude:a']);
  assert.equal(pick(snap).rate, 1000);
});

test('the activity feed and models today follow the setting too', () => {
  const { S, sources } = setup();
  S.addEvent('e1', { ts: S.records[0].ts, provider: 'claude', project: 'p', text: 'Edit x', tok: 1000, cr: 900, kind: 'tool' });
  S.addEvent('e2', { ts: S.records[0].ts, provider: 'claude', project: 'p', text: 'compact', tok: '40k→', kind: 'note' });
  S.addRecord('c', { ...S.records[0], model: 'claude-haiku-4-5', fam: 'haiku', in: 0, out: 0, cr: 500, total: 500, cost: 0.01 });
  const off = new Aggregator(S, sources, { countCacheReads: () => false }).snapshot(true);
  assert.deepEqual(off.events.map(e => e.tok).sort(), [100, '40k→'].sort());
  assert.ok(!off.models.some(m => m.tokens === 0), 'a model with only cache reads today is left out');
  const on = new Aggregator(S, sources).snapshot(true);
  assert.ok(on.events.some(e => e.tok === 1000));
  assert.equal(on.models.length, 3);
});

test('sessionDetails: totals by type, models, series, limit shares, events', () => {
  const { S, sources } = setup();
  const t0 = S.records[0].ts;
  S.addRecord('a2', { ...S.records[0], ts: t0 + 1, model: 'claude-haiku-4-5', fam: 'haiku', in: 10, out: 10, cr: 80, cw: 0, total: 100, cost: 0.5 });
  S.addEvent('ev', { ts: t0, provider: 'claude', project: 'p', text: 'Edit a.js', tok: 1000, cr: 900, kind: 'tool' });
  S.addEvent('other', { ts: t0, provider: 'claude', project: 'elsewhere', text: 'x', tok: 1, kind: 'tool' });
  sources[0].limits = () => [{ key: 'claude:session', provider: 'claude', kind: 'session', name: '5h', percent: 30, resetsAt: Date.now() + 3600e3, windowSec: 5 * 3600, fetchedAt: Date.now(), match: r => r.provider === 'claude' }];
  const agg = new Aggregator(S, sources);
  agg.snapshot(true); // learns percent per dollar from the limit: 30 % / $1.5
  const d = agg.sessionDetails('claude:a');
  assert.equal(d.responses, 2);
  assert.deepEqual(d.types, { in: 60, out: 60, cr: 980, cw: 0 });
  assert.equal(d.tokens, 1100);
  assert.equal(Math.round(d.cost * 100) / 100, 1.5);
  assert.deepEqual(d.models.map(m => [m.name.toLowerCase().includes('opus'), m.tokens]), [[true, 1000], [false, 100]]);
  assert.equal(d.series.reduce((a, b) => a + b, 0), 1100);
  assert.equal(d.stepMs, 60e3);
  assert.equal(d.shares.length, 1);
  assert.equal(Math.round(d.shares[0].pct), 30, 'all of the 5h usage so far is this session');
  assert.deepEqual(d.events.map(e => e.text), ['Edit a.js']);
  assert.equal(agg.sessionDetails('nope'), null);
});

test('sessionDetails without cache reads; long sessions keep at most 60 columns', () => {
  const { S, sources } = setup();
  const t0 = S.records[0].ts;
  S.addRecord('old', { ...S.records[0], ts: t0 - 5 * 3600e3, in: 5, out: 5, cr: 90, total: 100, cost: 0.1 });
  const agg = new Aggregator(S, sources, { countCacheReads: () => false });
  const d = agg.sessionDetails('claude:a');
  assert.equal(d.tokens, 110);
  assert.equal(d.types.cr, 990, 'the type breakdown still shows cache reads');
  assert.ok(d.series.length <= 60);
  assert.equal(d.stepMs % 60e3, 0);
  assert.equal(d.series.reduce((a, b) => a + b, 0), 110);
});

test('sessionDetails: own actions beyond the shared log, one row per model name, hidden source', () => {
  const { S, sources } = setup();
  const t0 = S.records[0].ts;
  for (let i = 0; i < 70; i++) S.addEvent('busy' + i, { ts: t0 + i, provider: 'claude', project: 'other', text: 'x' + i, tok: 1, kind: 'tool' });
  S.addEvent('mine', { ts: t0 - 60e3, provider: 'claude', project: 'p', text: 'Edit mine.js', tok: 1000, cr: 900, kind: 'tool' }, 'claude:a');
  S.prepare(Date.now()); // the shared log keeps only the newest 60 once trimmed
  S.trimEvents();
  assert.ok(!S.events.some(e => e.text === 'Edit mine.js'), 'pushed out of the shared log');
  S.addRecord('a1m', { ...S.records.find(r => r.sid === 'claude:a'), ts: t0 + 2, model: 'claude-opus-4-5[1m]', total: 10, in: 10, out: 0, cr: 0, cost: 0 });
  const agg = new Aggregator(S, sources, { countCacheReads: () => false });
  const d = agg.sessionDetails('claude:a');
  assert.deepEqual(d.events.map(e => [e.text, e.tok]), [['Edit mine.js', 100]]);
  assert.equal(new Set(d.models.map(m => m.name)).size, d.models.length, 'no duplicate model names');
  sources[0].off = true;
  assert.equal(agg.sessionDetails('claude:a'), null, 'hidden source');
});

test('addEvent keeps the last 12 actions per session, oldest first', () => {
  const { S } = setup();
  const t0 = S.records[0].ts;
  for (let i = 0; i < 15; i++) assert.equal(S.addEvent('k' + i, { ts: t0 + i * 10, provider: 'claude', project: 'p', text: 'a' + i, tok: 1, kind: 'tool' }, 'claude:a'), true);
  assert.equal(S.addEvent('k3', { ts: t0, provider: 'claude', project: 'p', text: 'dup', tok: 1, kind: 'tool' }, 'claude:a'), false, 'seen before');
  S.addEvent('late', { ts: t0 + 125, provider: 'claude', project: 'p', text: 'late', tok: 1, kind: 'tool' }, 'claude:a');
  const acts = S.sessions.get('claude:a').actions;
  assert.equal(acts.length, 12);
  assert.deepEqual(acts.map(a => a.ts), acts.map(a => a.ts).slice().sort((a, b) => a - b));
  assert.equal(acts[acts.length - 1].text, 'a14');
});

test('weekly limits get a habit forecast once the logs cover a week', () => {
  const S = new Store();
  const now = Date.now(), DAYMS = 86400e3;
  S.session('claude:h', { provider: 'claude', project: 'p', app: 'Claude Code', model: 'claude-opus-4-5' }).lastTs = now;
  // $1 a day for the past 9 days (the store keeps at least 8 days back)
  for (let d = 1; d <= 9; d++) S.addRecord('h' + d, { ts: now - d * DAYMS, provider: 'claude', sid: 'claude:h', project: 'p', app: 'Claude Code', model: 'claude-opus-4-5', fam: 'opus', in: 1, out: 1, cr: 0, cw: 0, total: 2, cost: 1 });
  const weekly = { key: 'claude:weekly', provider: 'claude', kind: 'weekly', name: 'weekly', percent: 20, resetsAt: now + 3 * DAYMS, windowSec: 7 * 86400, fetchedAt: now, kHint: 2, match: r => r.provider === 'claude' };
  const src = { id: 'claude', enabled: true, status: () => ({ id: 'claude', label: 'claude' }), limits: () => [weekly] };
  const agg = new Aggregator(S, [src]);
  agg.snapshot(true); // builds the history, and with it the habit profile
  const l = agg.snapshot(true).limits[0];
  assert.ok(l.habit && !l.habit.notEnough, 'nine days of logs: a forecast');
  // 20 % for the $3 in the current window → ~6.7 % per $1 day; the reset is 3 days
  // away at this time of day, so 2 whole usual days and part of the third come on top.
  const perDay = 20 / 3;
  assert.ok(l.habit.atReset > l.est + 2 * perDay - 0.01 && l.habit.atReset <= l.est + 3 * perDay + 0.01, `${l.habit.atReset} vs ${l.est}`);
});

test('habit forecast: history starts at the first record, not at the store cutoff', () => {
  const S = new Store();
  const now = Date.now(), DAYMS = 86400e3;
  S.session('claude:h', { provider: 'claude', project: 'p', app: 'Claude Code', model: 'claude-opus-4-5' }).lastTs = now;
  for (let d = 1; d <= 2; d++) S.addRecord('h' + d, { ts: now - d * DAYMS, provider: 'claude', sid: 'claude:h', project: 'p', app: 'Claude Code', model: 'claude-opus-4-5', fam: 'opus', in: 1, out: 1, cr: 0, cw: 0, total: 2, cost: 1 });
  const weekly = { key: 'claude:weekly', provider: 'claude', kind: 'weekly', name: 'weekly', percent: 20, resetsAt: now + 3 * DAYMS, windowSec: 7 * 86400, fetchedAt: now, kHint: 2, match: r => r.provider === 'claude' };
  const agg = new Aggregator(S, [{ id: 'claude', enabled: true, status: () => ({ id: 'claude', label: 'claude' }), limits: () => [weekly] }]);
  agg.snapshot(true);
  const h = agg.snapshot(true).limits[0].habit;
  assert.equal(h.notEnough, true);
  assert.ok(h.days > 1.9 && h.days < 3.1, `about 2–3 days of logs: ${h.days}`);
  weekly.percent = 100; // used up: nothing to forecast
  agg.anchors.clear();
  assert.equal(agg.snapshot(true).limits[0].habit, null);
});

test('history is rebuilt at once when a limit appears (a source answers after start)', () => {
  const { S, sources } = setup();
  const agg = new Aggregator(S, sources, { history: { record() {}, samples: () => [] } });
  const first = agg.snapshot(true).history;
  assert.equal(first.months.length, 0);
  sources[1].limits = () => [{ key: 'cursor:auto', provider: 'cursor', kind: 'monthly', name: 'auto', percent: 5, resetsAt: Date.now() + 10 * 86400e3, windowSec: 30 * 86400, fetchedAt: Date.now(), match: r => r.provider === 'cursor' }];
  const second = agg.snapshot(true).history;
  assert.notEqual(second, first, 'not the cached build');
  assert.deepEqual(second.months.map(m => m.key), ['cursor:auto']);
});
