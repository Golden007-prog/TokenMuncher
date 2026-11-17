// Clock times for forecasts and resets, shared by main and renderer. A bare
// "14:25" reads as today, so times on another day carry the day.
const pad = n => String(n).padStart(2, '0');
const hhmm = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Calendar days from `now` to `t` in local time (0 = same day).
function dayDiff(t, now) {
  const a = new Date(now), b = new Date(t);
  return Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) - new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 864e5);
}

// "at 14:25" today, "tomorrow 14:25", "Tue 14:25" within a week, "Dec 1 14:25"
// further out (or on an earlier day). For text read later (notifications stay
// in the Action Center) { absolute: true } names the weekday even for today
// and tomorrow, since "tomorrow" goes stale after midnight.
function when(t, now = Date.now(), { absolute = false } = {}) {
  const d = dayDiff(t, now), date = new Date(t);
  if (d === 0 && !absolute) return `at ${hhmm(t)}`;
  if (d === 1 && !absolute) return `tomorrow ${hhmm(t)}`;
  if (d >= 0 && d < 7) return `${DAYS[date.getDay()]} ${hhmm(t)}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${hhmm(t)}`;
}

// Elapsed time: "45 s", "12 min", "5 h", "3 d" (never negative).
function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
}

module.exports = { pad, hhmm, dayDiff, when, duration };
