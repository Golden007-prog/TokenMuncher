const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WeekSummaries, lastWeek, weeksDue, summarize, weekNews, WEEK, KEEP } = require('../src/main/week-summary');
const { fmtTok, change } = require('../src/shared/numbers');
const { defaults, normalize, PANELS } = require('../src/shared/layout');

const DAY = 86400e3, HOUR = 3600e3;
const NOW = new Date(2026, 10, 18, 12, 0).getTime(); // Wednesday 18 Nov 2026, noon
const weekly = resetsAt => ({ provider: 'claude', kind: 'weekly', name: 'weekly', key: 'claude:weekly_all', resetsAt, windowSec: 7 * 86400 });
const rec = (ts, o = {}) => ({ ts, provider: 'claude', sid: 's1', project: 'app', model: 'claude-opus-5-5', fam: 'opus', total: 1000, cr: 800, cost: 1, ...o });

test('lastWeek: the window of the weekly limit that ended last', () => {
  const reset = NOW + 2 * DAY + 3 * HOUR;
  assert.deepEqual(lastWeek([weekly(reset)], NOW), { start: reset - 2 * WEEK, end: reset - WEEK, limitKey: 'claude:weekly_all', by: 'limit' });
  // a reset time that already passed (no fresh reading yet) is that week's end
  const passed = NOW - HOUR;
  assert.deepEqual(lastWeek([weekly(passed)], NOW), { start: passed - WEEK, end: passed, limitKey: 'claude:weekly_all', by: 'limit' });
  const longAgo = NOW - 9 * DAY;
  assert.equal(lastWeek([weekly(longAgo)], NOW).end, longAgo + WEEK);
});

test('lastWeek: without the main weekly limit, the calendar week from Monday', () => {
  const others = [{ provider: 'claude', kind: 'weekly', name: 'weekly fable', resetsAt: NOW + DAY, windowSec: 7 * 86400 }, { provider: 'cursor', kind: 'monthly', name: 'auto', resetsAt: NOW + DAY, windowSec: 30 * 86400 }];
  for (const limits of [[], null, others]) {
    const w = lastWeek(limits, NOW);
    assert.deepEqual([w.limitKey, w.by], [null, 'calendar']);
    assert.equal(new Date(w.end).toString(), new Date(2026, 10, 16).toString());
    assert.equal(new Date(w.start).toString(), new Date(2026, 10, 9).toString());
  }
});

test('summarize: totals, sessions, shares; only this week and shown sources', () => {
  const start = new Date(2026, 10, 9, 15).getTime(), end = start + WEEK;
  const records = [
    rec(start - 1),                                                   // before
    rec(start, { sid: 'a' }),
    rec(start + HOUR, { sid: 'a', project: 'site', total: 3000, cr: 1000, cost: 2 }),
    rec(start + 2 * DAY, { sid: 'b', model: 'claude-sonnet-5-5', fam: 'sonnet', total: 500, cr: 0, cost: 0.5 }),
    rec(start + 2 * DAY + HOUR, { sid: 'c', provider: 'cursor', model: 'auto', fam: 'cursor', total: 9000, cr: 0, cost: 9 }),
    rec(end)                                                          // after
  ];
  const s = summarize(records, { start, end, hidden: new Set(['cursor']), cutoff: start - DAY });
  assert.deepEqual([s.tokens, s.cr, s.cost, s.sessions, s.activeDays, s.by], [4500, 1800, 3.5, 2, 2, 'limit']);
  assert.deepEqual(s.projects.map(p => [p.name, p.tokens]), [['site', 3000], ['app', 1500]]);
  assert.deepEqual(s.models.map(m => [m.fam, m.tokens]), [['opus', 4000], ['sonnet', 500]]);
  assert.deepEqual(Object.keys(s.providers), ['claude']);
  assert.deepEqual([s.busiest.start, s.busiest.tokens], [start, 4000]);
  assert.equal(s.partial, false);
  assert.equal(s.limit, null);

  const all = summarize(records, { start, end, by: 'calendar' });
  assert.deepEqual([all.tokens, all.sessions, all.by], [13500, 3, 'calendar']);
  assert.equal(summarize(records, { start, end, cutoff: start + 1 }).partial, true, 'the records begin after the week did');
  const none = summarize([], { start, end });
  assert.deepEqual([none.tokens, none.sessions, none.busiest, none.projects], [0, 0, null, []]);
});

test('summarize: days are the seven 24 h slices from the start of the week', () => {
  const start = new Date(2026, 10, 11, 15).getTime(), end = start + WEEK; // Wednesday 15:00: touches 8 calendar days
  const records = [];
  for (let d = 0; d < 7; d++) records.push(rec(start + d * DAY + HOUR), rec(start + d * DAY + 20 * HOUR, { total: d === 3 ? 5000 : 1000 }));
  const s = summarize(records, { start, end });
  assert.equal(s.activeDays, 7);
  assert.deepEqual([s.busiest.start, s.busiest.tokens], [start + 3 * DAY, 6000], 'a slice, not a cut calendar day');
  assert.equal(summarize([rec(end + 1)], { start, end: end + HOUR }).busiest.start, start + 7 * DAY, 'a longer week: the extra hour is its own slice');
  assert.equal(summarize([rec(start + 3 * DAY)], { start, end: start + 3 * DAY + HOUR }).activeDays, 1);
});

test('summarize lists at most five projects', () => {
  const start = NOW - WEEK;
  const records = Array.from({ length: 8 }, (_, i) => rec(start + i, { project: 'p' + i, total: 100 + i }));
  assert.deepEqual(summarize(records, { start, end: NOW }).projects.map(p => p.name), ['p7', 'p6', 'p5', 'p4', 'p3']);
});

test('weeksDue: the last week always, earlier ones only while the records cover them', () => {
  const reset = NOW + DAY, last = reset - WEEK;
  const ends = o => weeksDue([weekly(reset)], NOW, o).map(w => [(last - w.end) / WEEK, w.latest, w.by]);
  assert.deepEqual(ends({ cutoff: last - 3 * WEEK, has: () => false }), [[0, true, 'limit'], [1, false, 'limit'], [2, false, 'limit']]);
  assert.deepEqual(ends({ cutoff: last, has: () => false }), [[0, true, 'limit']], 'the last week even when the records start inside it');
  assert.deepEqual(ends({ cutoff: 0, has: w => w.end === last }).map(x => x[0]), [1, 2, 3, 4, 5]);
  assert.deepEqual(ends({ cutoff: 0, has: () => true }), []);
});

test('weeksDue: calendar weeks stay on Monday midnight across a clock change', () => {
  const now = new Date(2026, 10, 4, 12).getTime(); // the clocks went back on Sunday 25 Oct 2026 (where they do)
  const weeks = weeksDue([], now, { cutoff: 0, has: () => false, back: 3 });
  assert.equal(weeks.length, 4);
  for (const w of weeks) {
    for (const t of [w.start, w.end]) { const d = new Date(t); assert.deepEqual([d.getDay(), d.getHours(), d.getMinutes()], [1, 0, 0]); }
    assert.equal(w.by, 'calendar');
  }
  assert.deepEqual(weeks.map(w => new Date(w.end).getDate()), [2, 26, 19, 12]);
});

test('weekNews: the limit when known, tokens otherwise; the change against the week before', () => {
  const s = { end: 5, tokens: 412.3e6, cr: 300e6, cost: 318.2, sessions: 41, projects: [{ name: 'web-shop' }], limit: { name: 'claude weekly', pct: 61.6 } };
  const n = weekNews(s, { cost: 270 });
  assert.deepEqual(n, { id: 'week:5', kind: 'reset', title: 'Last week: 62% of the claude weekly limit', body: '412.30 M tokens · $318.20 · 41 sessions · +18% vs the week before · top: web-shop' });
  const bare = weekNews({ ...s, limit: null, sessions: 1, projects: [] }, null, { withCR: false });
  assert.deepEqual([bare.title, bare.body], ['Last week: 112.30 M tokens', '112.30 M tokens · $318.20 · 1 session']);
});

test('numbers: token counts and changes read the same in the window and in notifications', () => {
  assert.deepEqual([fmtTok(412.3e6), fmtTok(1.25e9), fmtTok(3400), fmtTok(12.4)], ['412.30 M', '1.25 B', '3.4 k', '12']);
  assert.deepEqual([change(90, 100), change(100, 100), change(118, 100), change(5, 0), change(5, undefined)], ['-10%', '0%', '+18%', null, null]);
});

const sum = (i, o = {}) => ({ start: NOW - (i + 1) * WEEK, end: NOW - i * WEEK, by: 'limit', tokens: i, cr: 0, cost: i, sessions: 1, activeDays: 1, busiest: null, projects: [], models: [], providers: {}, partial: false, limit: null, ...o });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-week-')), 'week-summaries.json');

test('the store keeps one summary per week, the newest twelve, across restarts', () => {
  const file = tmpFile();
  const a = new WeekSummaries(file).load();
  assert.deepEqual(a.list, []);
  for (let i = 14; i >= 0; i--) assert.equal(a.add(sum(i)), true);
  assert.equal(a.list.length, KEEP);
  assert.deepEqual([a.list[0].tokens, a.list[KEEP - 1].tokens], [0, KEEP - 1], 'newest first, oldest dropped');
  assert.equal(a.add(sum(0, { end: NOW + 5 * HOUR })), false, 'a reset time that moved by hours is the same week');
  assert.equal(a.has({ by: 'limit', end: NOW - 3 * WEEK }), true);
  assert.equal(a.has({ by: 'limit', end: NOW + WEEK }), false);
  assert.equal(a.has({ by: 'calendar', end: NOW }), false, 'a calendar week is another thing');
  assert.equal(a.before(a.list[0]).tokens, 1);
  assert.equal(a.before(a.list[KEEP - 1]), null);
  assert.deepEqual(new WeekSummaries(file).load().list.map(s => s.tokens), a.list.map(s => s.tokens));
  assert.equal(new WeekSummaries(null).load().add(sum(0)), true, 'memory only (demo mode)');
});

test('the store drops entries a view could not show', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(new WeekSummaries(file).load().list, []);
  const bad = [
    { junk: true }, null, 'x',
    sum(2, { cost: undefined }), sum(3, { cr: 'many' }), sum(4, { by: 'other' }), sum(5, { projects: [{ name: 'p' }] }),
    sum(6, { models: 'x' }), sum(7, { limit: { name: 'claude weekly' } }), sum(8, { busiest: { start: 1 } }), sum(9, { end: 0 })
  ];
  fs.writeFileSync(file, JSON.stringify([sum(1), ...bad, sum(0, { limit: { name: 'claude weekly', pct: 50, measured: true }, busiest: { start: 1, tokens: 1, cr: 0, cost: 0 }, projects: [{ name: 'p', tokens: 1, cr: 0, cost: 0 }] })]));
  assert.deepEqual(new WeekSummaries(file).load().list.map(s => s.tokens), [0, 1]);
});

test('a week is only compared with a complete week of the same kind right before it', () => {
  const w = new WeekSummaries(null);
  w.add(sum(2)); w.add(sum(1, { partial: true })); w.add(sum(0));
  assert.equal(w.before(w.list[0]), null, 'the week before is partial');
  assert.equal(w.before(w.list[1]).tokens, 2);
  const view = w.view();
  assert.deepEqual(view.map(s => s.before && s.before.tokens), [null, 2, null]);
  assert.deepEqual(Object.keys(view[1].before), ['tokens', 'cr', 'cost', 'sessions', 'limit']);
  const gap = new WeekSummaries(null);
  gap.add(sum(3)); gap.add(sum(0));
  assert.equal(gap.before(gap.list[0]), null, 'not the week three weeks ago');
});

test('a reset that moved: the next week starts where the stored one ended; the other kind gives way', () => {
  const w = new WeekSummaries(null);
  w.add(sum(1)); // ends at NOW - WEEK
  const early = { by: 'limit', start: NOW - 3 * DAY - WEEK, end: NOW - 3 * DAY }; // reset three days early: overlaps the stored week
  assert.equal(w.has(early), false);
  assert.equal(w.startOf(early), NOW - WEEK, 'no day twice, none lost');
  assert.equal(w.startOf({ by: 'limit', start: NOW - WEEK, end: NOW }), NOW - WEEK, 'the usual case is left alone');
  assert.equal(w.startOf({ by: 'calendar', start: NOW - 3 * DAY - WEEK, end: NOW - 3 * DAY }), NOW - 3 * DAY - WEEK);

  const mixed = new WeekSummaries(null);
  mixed.add(sum(1, { by: 'calendar' }));
  mixed.add(sum(3, { by: 'calendar' }));
  mixed.add({ ...sum(1), start: NOW - 2 * WEEK + 2 * DAY, end: NOW - WEEK + 2 * DAY }); // the limit's bounds became known
  assert.deepEqual(mixed.list.map(s => [s.by, s.tokens]), [['limit', 1], ['calendar', 3]], 'the overlapping calendar week went, the other stayed');
});

test('a failed write is tried again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-week-'));
  const w = new WeekSummaries(path.join(dir, 'missing', 'week-summaries.json'));
  assert.equal(w.add(sum(0)), true);
  assert.equal(w.unsaved, true);
  fs.mkdirSync(path.join(dir, 'missing'));
  w.save();
  assert.equal(w.unsaved, false);
  assert.equal(new WeekSummaries(w.file).load().list.length, 1);
});

test('layout: the week summary panel is in the history view, after the weekly limits; saved layouts get it at the end', () => {
  assert.ok(PANELS.hist.includes('summary'));
  const ids = defaults('hist').rows.map(r => r.map(p => p.id).join(','));
  assert.equal(ids[ids.indexOf('weekly') + 1], 'summary');
  const saved = normalize({ rows: [[{ id: 'daily', w: 1 }], [{ id: 'weekly', w: 1 }]], hidden: ['burners'] }, 'hist');
  assert.deepEqual(saved.rows.slice(0, 2).map(r => r[0].id), ['daily', 'weekly']);
  assert.ok(saved.rows.flat().some(p => p.id === 'summary'));
});
