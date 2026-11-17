const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LimitHistory } = require('../src/main/limit-history');

const T = Date.UTC(2026, 10, 14, 12, 0, 0);
const M = 60e3, D = 86400e3;
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-lh-')), 'limit-history.jsonl');
const L = (percent, est = percent) => ({ key: 'claude:session', percent, est, resetsAt: T + 3600e3 });

test('a reading when the server value changes, otherwise every 5 minutes', () => {
  const h = new LimitHistory(file());
  h.record([L(20, 20.1)], T);
  h.record([L(20, 20.4)], T + M);        // same server value, too soon
  h.record([L(21, 21.0)], T + 2 * M);    // server value changed
  h.record([L(21, 21.7)], T + 6 * M);    // 4 min later, same value
  h.record([L(21, 22.3)], T + 7 * M);    // 5 min since the last reading
  assert.deepEqual(h.samples('claude:session').map(s => [(s.t - T) / M, s.p, s.e]), [[0, 20, 20.1], [2, 21, 21], [7, 21, 22.3]]);
});

test('readings are appended to the file and read back', async () => {
  const f = file();
  const h = new LimitHistory(f);
  h.record([L(10), { key: 'claude:weekly_all', percent: 30, est: 30.5, resetsAt: 0 }], T);
  await h.flush();
  h.record([L(12)], T + M);
  h.flushSync();
  const back = new LimitHistory(f);
  await back.load(T + 2 * M);
  assert.deepEqual(back.samples('claude:session').map(s => s.p), [10, 12]);
  assert.deepEqual(back.samples('claude:weekly_all').map(s => s.e), [30.5]);
  assert.deepEqual(back.samples('claude:session', T + M).map(s => s.p), [12], 'time range filter');
});

test('bad lines are skipped and old readings dropped (and rewritten away)', async () => {
  const f = file();
  const lines = [
    JSON.stringify([T - 60 * D, 'claude:session', 5, 5, 0]),   // older than 8 weeks
    '{not json',
    JSON.stringify(['x', 'claude:session', 5, 5, 0]),          // wrong shape
    JSON.stringify([T - D, 'claude:session', 7, 7, 0])
  ];
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const h = new LimitHistory(f);
  await h.load(T);
  assert.deepEqual(h.samples('claude:session').map(s => s.p), [7]);
  const rest = fs.readFileSync(f, 'utf8').trim().split('\n');
  assert.equal(rest.length, 1, 'file rewritten without the dropped lines');
});

test('a missing file is an empty history', async () => {
  const h = new LimitHistory(file());
  await h.load(T);
  assert.deepEqual(h.samples('claude:session'), []);
});

test('values the app made up itself are not recorded', () => {
  const h = new LimitHistory(file());
  h.record([{ ...L(0), synthetic: true }, L(30)], T);
  assert.deepEqual([...h.byKey.keys()], ['claude:session']);
  assert.deepEqual(h.samples('claude:session').map(s => s.p), [30]);
  assert.equal(h.pending.length, 1);
});

test('quitting during a flush keeps every reading, a line written twice is read once', async () => {
  const f = file();
  const h = new LimitHistory(f);
  h.record([L(10)], T);
  const running = h.flush(T);           // async append in progress
  h.record([L(11)], T + M);
  h.flushSync();                        // quit: writes the in-flight line too
  await running;
  const back = new LimitHistory(f);
  await back.load(T + 2 * M);
  assert.deepEqual(back.samples('claude:session').map(s => s.p), [10, 11]);
});

test('old readings are pruned while the app keeps running', async () => {
  const f = file();
  const h = new LimitHistory(f, { keepMs: 10 * D });
  h.record([L(5)], T);
  await h.flush(T);
  h.record([L(6)], T + 9 * D);
  await h.flush(T + 11 * D);            // more than 6 h since the last prune: rewrite
  assert.deepEqual(h.samples('claude:session').map(s => s.p), [6]);
  const back = new LimitHistory(f, { keepMs: 10 * D });
  await back.load(T + 11 * D);
  assert.deepEqual(back.samples('claude:session').map(s => s.p), [6]);
});

test('samples are found by time range', () => {
  const h = new LimitHistory(file());
  for (let i = 0; i < 50; i++) h.record([L(i)], T + i * 10 * M);
  assert.deepEqual(h.samples('claude:session', T + 100 * M, T + 130 * M).map(s => s.p), [10, 11, 12]);
});

test('quitting during the periodic rewrite keeps the newest reading', async () => {
  const f = file();
  const h = new LimitHistory(f);
  await h.load(T);                              // starts the prune clock
  h.record([L(10)], T);
  const rewriting = h.flush(T + 7 * 3600e3);    // > 6 h: full rewrite in progress
  h.record([L(11)], T + 7 * 3600e3 + M);
  h.flushSync();                                // quit
  await rewriting;
  const back = new LimitHistory(f);
  await back.load(T + 8 * 3600e3);
  assert.deepEqual(back.samples('claude:session').map(s => s.p), [10, 11]);
  assert.deepEqual(fs.readdirSync(path.dirname(f)).filter(n => n.endsWith('.tmp')), [], 'no temp files left');
});

test('monthly limits (kind in the file) are kept longer when pruning on load', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-lh-keep-'));
  const file = path.join(dir, 'h.jsonl');
  const now = 200 * 86400e3;
  const old = now - 80 * 86400e3; // older than 8 weeks, newer than 100 days
  // the old cursor line has no kind yet; a newer line of the same key carries it
  fs.writeFileSync(file, [[old, 'claude:weekly_all', 10, 10, 0, 'weekly'], [old, 'cursor:auto', 5, 5, 0], [now - 86400e3, 'cursor:auto', 6, 6, 0, 'monthly']].map(a => JSON.stringify(a)).join('\n') + '\n');
  const h = new LimitHistory(file);
  await h.load(now);
  assert.equal(h.samples('claude:weekly_all').length, 0);
  assert.equal(h.samples('cursor:auto').length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
