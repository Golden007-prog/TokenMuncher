// Demo mode (TM_DEMO): made-up data that the real views can show.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/main/store');
const { Aggregator } = require('../src/main/aggregate');
const { LimitHistory } = require('../src/main/limit-history');
const { demoSources, seedHistory, PROJECTS } = require('../src/main/sources/demo');

test('demo data: three sources, sessions running now, sensible limits', () => {
  const S = new Store();
  const sources = demoSources(S);
  assert.deepEqual(sources.map(s => s.id), ['claude', 'cursor', 'copilot']);
  assert.ok(S.records.length > 500, `records: ${S.records.length}`);
  const names = new Set(PROJECTS.map(p => p[0]));
  assert.ok(S.records.every(r => names.has(r.project)), 'made-up projects only');
  const agg = new Aggregator(S, sources);
  const snap = agg.snapshot(true);
  assert.equal(snap.sessions.filter(s => Date.now() - s.lastTs < 60e3).length, 2, 'two live sessions');
  for (const l of snap.limits) {
    assert.ok(l.est >= 0 && l.est <= 100, `${l.key}: ${l.est}`);
    assert.ok(l.resetsAt > Date.now(), `${l.key} resets in the future`);
  }
  assert.ok(snap.limits.find(l => l.key === 'claude:weekly_all').today > 0, 'weekly limit used today');
});

test('demo history: complete previous monthly cycles and past weeks', () => {
  const S = new Store();
  const sources = demoSources(S);
  const h = new LimitHistory('unused.jsonl');
  seedHistory(h, sources);
  const agg = new Aggregator(S, sources, { history: h });
  agg.snapshot(true);
  const hist = agg.snapshot(true).history;
  const cursor = hist.months.find(m => m.key === 'cursor:auto');
  assert.equal(cursor.rows.length, 2);
  assert.ok(cursor.rows[1].pct > cursor.rows[0].pct, 'last cycle ended higher than this one so far');
  assert.ok(hist.weeks.find(w => w.key === 'claude:weekly_all').rows.some(r => r.measured), 'measured past weeks');
});
