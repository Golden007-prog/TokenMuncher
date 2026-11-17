const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReport, scrubber } = require('../src/main/diagnostics');

const HOME = 'C:\\Users\\Jane Doe';
const now = Date.UTC(2026, 10, 15, 12);

test('scrubber hides the home folder in any slash style and case, and the user name', () => {
  const scrub = scrubber({ home: HOME, user: 'Jane Doe' });
  assert.equal(scrub('C:\\Users\\Jane Doe\\.codex\\sessions'), '~\\.codex\\sessions');
  assert.equal(scrub('c:/users/jane doe/.claude/projects'), '~/.claude/projects');
  assert.equal(scrub('C:\\\\Users\\\\Jane Doe\\\\x'), '~\\\\x', 'JSON-escaped backslashes');
  assert.equal(scrub('D:\\work\\Jane Doe\\repo'), 'D:\\work\\<user>\\repo');
  assert.equal(scrubber({ home: '', user: 'ab' })('ab'), 'ab', 'very short names are left alone');
});

test('report: versions, settings, limits rounded, diagnostics, nothing private', () => {
  const text = buildReport({
    now, home: HOME, user: 'Jane Doe',
    app: { version: '0.10.0', electron: '37.2.0', os: 'Windows 10.0.26100', arch: 'arm64', packaged: true },
    settings: { sources: { claude: true, codex: false }, thresholds: [80, 90], notifications: true, forecastNotify: true, countCacheReads: false, checkUpdates: true },
    update: { status: 'current', latest: null, error: null, checkedAt: now - 3600e3 },
    counts: { codex: { records: 12, sessions: 2, lastTs: now - 30e3 } },
    sources: [{
      id: 'codex', detected: true, off: true, status: { plan: { name: 'plus' }, error: null, fetchedAt: now - 90e3 },
      limits: [{ key: 'codex:primary', kind: 'session', percent: 5.066666666, est: 5.066666666, resetsAt: now + 2 * 3600e3 }],
      diagnostics: { logFolders: [{ path: 'C:\\Users\\Jane Doe\\.codex\\sessions', exists: true }], parser: { tokenCount: 40, skippedTypes: { reasoning: 3 } } }
    }]
  });
  assert.match(text, /version \*\*0\.10\.0\*\* \(installed\), Electron 37\.2\.0, Windows 10\.0\.26100, arm64/);
  assert.match(text, /sources claude on, codex off; thresholds 80\/90%/);
  assert.match(text, /cache reads not counted/);
  assert.match(text, /#### codex: detected, hidden in settings/);
  assert.match(text, /plan: plus; error: none; last reading 90 s ago/);
  assert.match(text, /codex:primary \(session\): 5\.07%, resets in 2 h/);
  assert.match(text, /records 12, sessions 2, last activity 30 s ago/);
  assert.match(text, /"reasoning": 3/);
  assert.match(text, /"~\\\\\.codex\\\\sessions"/, 'home folder replaced inside the JSON block');
  assert.ok(!/Jane/i.test(text), 'no user name anywhere');
});

test('scrubber leaves longer names and ordinary words alone', () => {
  const scrub = scrubber({ home: 'C:\\Users\\Jan', user: 'Jan' });
  assert.equal(scrub('C:\\Users\\Janet\\x'), 'C:\\Users\\Janet\\x', 'another account that starts the same');
  assert.equal(scrub('"C:\\\\Users\\\\Jan"'), '"~"', 'quoted, JSON-escaped, at the end');
  const plain = scrubber({ home: 'C:\\Users\\User', user: 'User' });
  assert.equal(plain('{"user_message": 3, "path": "D:\\\\User\\\\x"}'), '{"user_message": 3, "path": "D:\\\\<user>\\\\x"}');
});

test('Codex stats: inner types of skipped lines, lines without payload, odd type names', () => {
  const { Store } = require('../src/main/store');
  const { CodexSource } = require('../src/main/sources/codex');
  const c = new CodexSource(new Store());
  const ts = new Date().toISOString();
  c.onLine(`{"timestamp":"${ts}","type":"response_item","payload":{"type":"reasoning","summary":[]}}`, 'f.jsonl');
  c.onLine(`{"timestamp":"${ts}","type":"response_item","payload":{"type":"reasoning"}}`, 'f.jsonl');
  c.onLine(`{"timestamp":"${ts}","type":"event_msg","payload":{"type":"agent_message","message":"x"}}`, 'f.jsonl');
  c.onLine(`{"timestamp":"${ts}","type":"constructor"}`, 'f.jsonl');
  c.onLine(`{"timestamp":"${ts}","type":"event_msg","body":{"type":"token_count"}}`, 'f.jsonl'); // payload renamed
  c.onLine(`{"timestamp":"${ts}","type":"event_msg","payload":{"type":"token_count","info":null}}`, 'f.jsonl');
  assert.deepEqual({ ...c.stats.skippedTypes }, { 'response_item/reasoning': 2, 'event_msg/agent_message': 1, constructor: 1 });
  assert.equal(c.stats.noTimestampOrPayload, 1);
  assert.equal(c.stats.tokenCount, 1);
  assert.equal(c.stats.tokenCountNoUsage, 1);
  assert.match(JSON.stringify(c.diagnostics().parser), /"constructor":1/);
});
