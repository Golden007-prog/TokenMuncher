const test = require('node:test');
const assert = require('node:assert/strict');
const { hourProfile, habitForecast, slotOf, MIN_DAYS } = require('../src/shared/habits');

// Local times, so the tests don't depend on the machine's time zone.
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const HOUR = 3600e3;

test('slotOf: Monday 00:00 is 0, Sunday 23:00 is 167', () => {
  assert.equal(slotOf(at(2026, 11, 9, 0)), 0);      // Monday
  assert.equal(slotOf(at(2026, 11, 9, 13, 30)), 13);
  assert.equal(slotOf(at(2026, 11, 15, 23, 59)), 167); // Sunday
});

// Two weeks: every weekday 09:00–10:00 uses 2 %, nothing else.
function twoWeeks() {
  const points = [];
  for (let d = 2; d <= 13; d++) {
    const day = new Date(2026, 10, d).getDay();
    if (day >= 1 && day <= 5) points.push({ ts: at(2026, 11, d, 9, 30), pct: 2 });
  }
  return hourProfile(points, { from: at(2026, 11, 2, 0), now: at(2026, 11, 16, 0) }); // Mon Nov 2 → Mon Nov 16
}

test('hourProfile averages each hour of the week over the weeks seen', () => {
  const h = twoWeeks();
  assert.equal(Math.round(h.days), 14);
  assert.equal(h.profile[9], 2, 'Monday 09:00: 2 % in both weeks');
  assert.equal(h.profile[4 * 24 + 9], 2, 'Friday 09:00');
  assert.equal(h.profile[5 * 24 + 9], 0, 'Saturday nothing');
  assert.equal(h.profile.reduce((a, b) => a + b, 0), 10, 'a usual week: 5 × 2 %');
});

test('hourProfile: an hour seen once counts once, the unfinished hour not at all', () => {
  // from Monday 08:30 to Monday 10:15: whole hours 09 (and 08 is partial, 10 unfinished)
  const h = hourProfile([{ ts: at(2026, 11, 9, 9, 10), pct: 3 }, { ts: at(2026, 11, 9, 10, 5), pct: 5 }], { from: at(2026, 11, 9, 8, 30), now: at(2026, 11, 9, 10, 15) });
  assert.equal(h.profile[9], 3);
  assert.equal(h.profile[10], 0, 'the unfinished hour is not averaged in');
});

test('habitForecast: current percent plus the usual hours left', () => {
  const h = twoWeeks();
  // Monday 08:00, reset Wednesday 08:00: Monday and Tuesday 09:00 left → +4 %
  const f = habitForecast(h, { now: at(2026, 11, 16, 8), resetsAt: at(2026, 11, 18, 8), current: 50 });
  assert.equal(f.atReset, 54);
  assert.equal(f.runsOutAt, null);
  // halfway through Monday 09:00 only half of that hour is left
  assert.equal(habitForecast(h, { now: at(2026, 11, 16, 9, 30), resetsAt: at(2026, 11, 16, 12), current: 50 }).atReset, 51);
});

test('habitForecast: when the usual pace runs out before the reset', () => {
  const h = twoWeeks();
  const f = habitForecast(h, { now: at(2026, 11, 16, 8), resetsAt: at(2026, 11, 21, 0), current: 97 });
  assert.equal(f.atReset, 100, 'capped at 100');
  assert.equal(f.runsOutAt, at(2026, 11, 17, 9, 30), 'Monday +2 → 99, then half of Tuesday 09:00 → 100');
});

test('habitForecast: none with under a week of history or no reset ahead', () => {
  const h = twoWeeks();
  assert.equal(habitForecast({ ...h, days: MIN_DAYS - 1 }, { now: at(2026, 11, 16, 8), resetsAt: at(2026, 11, 18, 8), current: 1 }), null);
  assert.equal(habitForecast(h, { now: at(2026, 11, 16, 8), resetsAt: null, current: 1 }), null);
  assert.equal(habitForecast(h, { now: at(2026, 11, 16, 8), resetsAt: at(2026, 11, 16, 7), current: 1 }), null);
  assert.equal(habitForecast(null, { now: 0, resetsAt: 1, current: 0 }), null);
  assert.equal(habitForecast(h, { now: at(2026, 11, 16, 8), resetsAt: at(2026, 11, 18, 8), current: 100 }), null, 'used up');
});
