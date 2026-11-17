const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionWindows, windowSeries, fixedWindows, monthlyCycles } = require('../src/main/history');

const H = 3600e3, D = 86400e3;
const T0 = Date.UTC(2026, 10, 10, 8, 0, 0);
const r = (h, cost = 1) => ({ ts: T0 + h * H, cost });

test('5h windows start with the first message after the previous one ended', () => {
  const recs = [r(0), r(1), r(4.9), r(5.5), r(6), r(12)];
  const ws = sessionWindows(recs, { windowMs: 5 * H, k: 10, since: 0, now: T0 + 13 * H });
  assert.deepEqual(ws.map(w => [(w.start - T0) / H, (w.end - T0) / H, w.pct]).reverse(), [[0, 5, 30], [5.5, 10.5, 20], [12, 17, 10]]);
  assert.equal(ws[0].current, true);
  assert.equal(ws[0].measured, false);
});

test('the server window is used as-is and cuts an overlapping rebuilt one', () => {
  const recs = [r(0), r(3), r(4)];
  const anchor = { start: T0 + 2.5 * H, end: T0 + 7.5 * H };   // server says the window started at 2:30
  const ws = sessionWindows(recs, { windowMs: 5 * H, k: 10, anchor, since: 0, now: T0 + 4.5 * H }).reverse();
  assert.deepEqual(ws.map(w => [(w.start - T0) / H, (w.end - T0) / H, w.pct]), [[0, 2.5, 10], [2.5, 7.5, 20]]);
});

test('a server window with no local messages still shows up', () => {
  const anchor = { start: T0, end: T0 + 5 * H };
  const ws = sessionWindows([], { windowMs: 5 * H, k: 10, anchor, since: 0, samples: [{ t: T0 + H, p: 12 }], now: T0 + 2 * H });
  assert.equal(ws.length, 1);
  assert.equal(ws[0].pct, 12);
  assert.equal(ws[0].measured, true);
});

test('server readings win over the rebuilt percent when higher', () => {
  const ws = sessionWindows([r(0), r(1)], { windowMs: 5 * H, k: 10, since: 0, samples: [{ t: T0 + 2 * H, p: 35 }], now: T0 + 3 * H });
  assert.equal(ws[0].pct, 35);
  const low = sessionWindows([r(0), r(1)], { windowMs: 5 * H, k: 10, since: 0, samples: [{ t: T0 + 2 * H, p: 5 }], now: T0 + 3 * H });
  assert.equal(low[0].pct, 20);
});

test('unknown rate leaves percent empty unless the server measured it', () => {
  const ws = sessionWindows([r(0)], { windowMs: 5 * H, k: null, since: 0, now: T0 + H });
  assert.equal(ws[0].pct, null);
});

test('window series is cumulative per slice and stops at now', () => {
  const s = windowSeries({ start: T0, end: T0 + 5 * H }, [r(0.5), r(1.5), r(1.6)], { k: 10, now: T0 + 2.5 * H, cols: 5 });
  assert.deepEqual(s, [10, 30, 30, null, null]);
});

test('window series takes server samples into account', () => {
  const s = windowSeries({ start: T0, end: T0 + 5 * H }, [r(0.5)], { k: 10, samples: [{ t: T0 + 1.5 * H, p: 40, e: 41 }], now: T0 + 2.5 * H, cols: 5 });
  assert.deepEqual(s, [10, 41, 41, null, null]);
});

test('weekly windows are counted back from the reset, split by day', () => {
  const resetsAt = T0 + 3 * D;                         // current week: T0-4d .. T0+3d
  const recs = [{ ts: T0 - 10 * D, cost: 2 }, { ts: T0 - 4 * D + H, cost: 1 }, { ts: T0, cost: 3 }];
  const ws = fixedWindows(recs, { resetsAt, windowMs: 7 * D, k: 5, count: 3, now: T0 + H, since: T0 - 10.5 * D });
  assert.equal(ws.length, 2);
  assert.equal(ws[0].current, true);
  assert.equal(ws[0].pct, 20);
  assert.deepEqual(ws[0].daily, [5, 0, 0, 0, 15, 0, 0]);
  assert.equal(ws[1].pct, 10);
  assert.equal(ws[1].partial, true, 'the store starts after that window began');
});

test('server readings define their window by reset time, even when the logs suggest other boundaries', () => {
  // local logs alone would give one window 0-5 h; the server says a window ended at 6 h (so 1-6 h)
  const samples = [{ t: T0 + 5.5 * H, p: 98, e: 98, r: T0 + 6 * H }];
  const ws = sessionWindows([r(0), r(1)], { windowMs: 5 * H, k: 10, since: 0, samples, now: T0 + 7 * H }).reverse();
  assert.deepEqual(ws.map(w => [(w.start - T0) / H, (w.end - T0) / H, w.pct, w.measured]), [[0, 1, 10, false], [1, 6, 98, true]]);
});

test('the oldest window shown keeps its real start when it began before the 7-day range', () => {
  const since = T0 + 2 * H;
  const ws = sessionWindows([r(1), r(3)], { windowMs: 5 * H, k: 10, since, now: T0 + 4 * H });
  assert.equal(ws.length, 1);
  assert.deepEqual([(ws[0].start - T0) / H, ws[0].pct], [1, 20]);
});

test('weeks before the local logs still show from recorded readings', () => {
  const resetsAt = T0 + 3 * D;
  const oldEnd = resetsAt - 3 * 7 * D;                        // three weeks back
  const samples = [{ t: oldEnd - D, p: 55, r: oldEnd }];
  const ws = fixedWindows([{ ts: T0, cost: 1 }], { resetsAt, windowMs: 7 * D, k: 5, count: 6, samples, now: T0, since: T0 - 2 * D });
  assert.deepEqual(ws.map(w => [w.current, w.pct, w.measured]), [[true, 5, false], [false, 55, true]]);
  assert.equal(ws[1].daily, null);
});

// Monthly cycles: local times so the month arithmetic matches the code.
const lt = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h).getTime();

test('monthlyCycles: cycles told apart by reset time, newest first', () => {
  const prevEnd = lt(2026, 11, 1, 1), curEnd = lt(2026, 12, 1, 1);
  const samples = [
    { t: lt(2026, 10, 1, 9), p: 0, e: null, r: prevEnd },
    { t: lt(2026, 10, 2, 9), p: 10, e: null, r: prevEnd },
    { t: lt(2026, 10, 20, 9), p: 60, e: 61, r: prevEnd + 200 }, // reset time jitter: same cycle
    { t: lt(2026, 11, 3, 9), p: 5, e: null, r: curEnd },
    { t: lt(2026, 11, 10, 9), p: 12, e: null, r: curEnd }
  ];
  const now = lt(2026, 11, 14);
  const [cur, prev] = monthlyCycles(samples, { resetsAt: curEnd, now });
  assert.equal(cur.end, curEnd);
  assert.equal(cur.start, lt(2026, 11, 1, 1));
  assert.equal(cur.current, true);
  assert.equal(cur.pct, 12);
  assert.equal(cur.partial, true, 'first reading two days after the cycle began');
  assert.equal(cur.daily.length, 30);
  assert.deepEqual(cur.daily.slice(0, 3), [null, null, 0], 'joined late: unknown before the first reading, which is the baseline');
  assert.equal(cur.daily[9], 7);
  assert.equal(cur.daily[20], null, 'days still ahead');
  assert.equal(cur.daily.filter(v => v != null).reduce((a, b) => a + b, 0), 7, 'from 5 % to 12 %');
  assert.equal(prev.pct, 61, 'highest of server value and estimate');
  assert.equal(prev.current, false);
  assert.equal(prev.partial, false);
  assert.equal(prev.daily.reduce((a, b) => a + b, 0), 61);
});

test('monthlyCycles: the current cycle shows before its first reading; readings without a reset are ignored', () => {
  const curEnd = lt(2026, 12, 1, 1);
  const rows = monthlyCycles([{ t: lt(2026, 11, 3), p: 5, e: null, r: 0 }], { resetsAt: curEnd, now: lt(2026, 11, 14) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pct, null);
  assert.equal(rows[0].measured, false);
  assert.deepEqual(monthlyCycles([], { resetsAt: null, now: 0 }), []);
});

test('monthlyCycles: real window for the current cycle, clamped month for the oldest, no DST day', () => {
  // Cursor-style cycle that isn't a calendar month: the source's window wins
  const end = lt(2026, 11, 21, 13), windowMs = 31 * 86400e3;
  const [cur] = monthlyCycles([{ t: lt(2026, 10, 22), p: 1, e: null, r: end }], { resetsAt: end, windowMs, now: lt(2026, 11, 14) });
  assert.equal(cur.start, end - windowMs);
  // a reset on May 31 starts on Apr 30 (not "Apr 31" = May 1)
  const may31 = lt(2026, 5, 31, 1);
  const [old] = monthlyCycles([{ t: lt(2026, 5, 1), p: 3, e: null, r: may31 }], { resetsAt: null, now: lt(2026, 6, 2) });
  assert.equal(old.start, lt(2026, 4, 30, 1));
  assert.equal(old.daily.length, 31);
  // across a DST change (Oct 25 in Europe, Nov 1 in the US) the day count stays whole
  const [dst] = monthlyCycles([], { resetsAt: lt(2026, 11, 15, 1), now: lt(2026, 10, 20) });
  assert.equal(dst.daily.length, 31);
});

test('monthlyCycles: an older cycle ends where the next one starts', () => {
  const a = lt(2026, 10, 21, 13), b = lt(2026, 11, 21, 13);
  const rows = monthlyCycles([{ t: lt(2026, 10, 1), p: 2, e: null, r: a }, { t: lt(2026, 10, 25), p: 3, e: null, r: b }], { resetsAt: b, windowMs: b - a, now: lt(2026, 11, 1) });
  assert.equal(rows[0].start, a);
  assert.equal(rows[1].end, a);
});
