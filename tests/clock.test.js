const test = require('node:test');
const assert = require('node:assert/strict');
const { hhmm, dayDiff, when } = require('../src/shared/clock');
const { evaluate } = require('../src/main/notify');

// Local times, so the tests don't depend on the machine's time zone.
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const now = at(2026, 11, 14, 22, 10); // Saturday

test('hhmm pads hours and minutes', () => {
  assert.equal(hhmm(at(2026, 11, 14, 7, 5)), '07:05');
});

test('dayDiff counts calendar days, not 24 h blocks', () => {
  assert.equal(dayDiff(at(2026, 11, 14, 23, 59), now), 0);
  assert.equal(dayDiff(at(2026, 11, 15, 0, 5), now), 1);  // 5 minutes later, but tomorrow
  assert.equal(dayDiff(at(2026, 11, 17, 9), now), 3);
  assert.equal(dayDiff(at(2026, 11, 13, 9), now), -1);
});

test('dayDiff stays whole across a DST change', () => {
  assert.equal(dayDiff(at(2026, 3, 30, 12), at(2026, 3, 28, 12)), 2); // EU spring forward on Mar 29
  assert.equal(dayDiff(at(2026, 10, 26, 12), at(2026, 10, 24, 12)), 2); // fall back on Oct 25
});

test('when: today, tomorrow, this week, further out', () => {
  assert.equal(when(at(2026, 11, 14, 23, 40), now), 'at 23:40');
  assert.equal(when(at(2026, 11, 15, 14, 25), now), 'tomorrow 14:25');
  assert.equal(when(at(2026, 11, 15, 0, 5), now), 'tomorrow 00:05');
  assert.equal(when(at(2026, 11, 17, 9), now), 'Tue 09:00');
  assert.equal(when(at(2026, 12, 1, 1), now), 'Dec 1 01:00');
  assert.equal(when(at(2026, 11, 21, 22), now), 'Nov 21 22:00'); // a week ahead: same weekday, so the date instead
  assert.equal(when(at(2026, 11, 13, 9), now), 'Nov 13 09:00');  // earlier day
});

test('when absolute: weekday for today and tomorrow too', () => {
  assert.equal(when(at(2026, 11, 14, 23, 40), now, { absolute: true }), 'Sat 23:40');
  assert.equal(when(at(2026, 11, 15, 14, 25), now, { absolute: true }), 'Sun 14:25');
  assert.equal(when(at(2026, 11, 17, 9), now, { absolute: true }), 'Tue 09:00');
});

test('notifications always name the weekday (they are read later from the Action Center)', () => {
  const weekly = { key: 'claude:wk', provider: 'claude', name: 'weekly', kind: 'weekly', percent: 91, est: 91, v: 0, resetsAt: at(2026, 11, 17, 9) };
  const { notifications } = evaluate({}, [weekly], now);
  assert.ok(notifications.length, 'a threshold notification');
  assert.match(notifications[0].body, /Resets Tue 09:00\./);
  const soon = evaluate({}, [{ ...weekly, resetsAt: at(2026, 11, 15, 9) }], now).notifications[0];
  assert.match(soon.body, /Resets Sun 09:00\./); // not "tomorrow", which is wrong once it's past midnight
});
