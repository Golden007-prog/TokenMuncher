// Forecasts from habits: how much of a limit you usually use in each hour of
// the week (Monday 00–01 … Sunday 23–24, local time), learned from past usage,
// projected over the hours left until the reset. Pure, shared by main and tests.
const HOUR = 3600e3;
const SLOTS = 7 * 24;
const MIN_DAYS = 7;   // less history than a week gives no habit forecast

const startOfHour = t => { const d = new Date(t); d.setMinutes(0, 0, 0); return d.getTime(); };
const slotOf = t => { const d = new Date(t); return ((d.getDay() + 6) % 7) * 24 + d.getHours(); };

// points: [{ ts, pct }] usage increments (percent of the limit) from `from` to
// `now`. Returns { profile: 168 average percents per hour-of-week, days }, where
// each slot is averaged over how often that hour occurred in [from, now).
function hourProfile(points, { from, now }) {
  const sum = new Array(SLOTS).fill(0), seen = new Array(SLOTS).fill(0);
  for (const p of points) if (p.ts >= from && p.ts < now) sum[slotOf(p.ts)] += p.pct;
  // Whole hours only: the current, unfinished hour would read as a quiet one.
  for (let h = startOfHour(from) + (from > startOfHour(from) ? HOUR : 0); h + HOUR <= now; h += HOUR) seen[slotOf(h)]++;
  return { profile: sum.map((s, i) => (seen[i] ? s / seen[i] : 0)), days: Math.max(0, (now - from) / 864e5) };
}

// Usual usage from now to the reset added to the current percent:
// { atReset, runsOutAt } (runsOutAt = when it would reach 100 %, or null).
// null with less than MIN_DAYS of history, no reset ahead, or the limit used up.
function habitForecast(habit, { now, resetsAt, current }) {
  if (!habit || habit.days < MIN_DAYS || !resetsAt || resetsAt <= now || current >= 100) return null;
  let pct = current, runsOutAt = null;
  for (let t = now; t < resetsAt;) {
    const end = Math.min(resetsAt, startOfHour(t) + HOUR);
    const add = habit.profile[slotOf(t)] * (end - t) / HOUR;
    if (runsOutAt == null && add > 0 && pct + add >= 100) runsOutAt = t + (100 - pct) / add * (end - t);
    pct += add;
    t = end;
  }
  return { atReset: Math.min(100, pct), runsOutAt };
}

module.exports = { hourProfile, habitForecast, slotOf, MIN_DAYS, SLOTS };
