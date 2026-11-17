// Limit history: limit windows from recorded server readings, with the gaps
// rebuilt from local usage records. Pure functions.
//
//   records: [{ ts, cost }] sorted by ts, already filtered to the limit
//   k:       percent of the limit per dollar of local spend (null = unknown)
//   samples: [{ t, p, e, r }] server percent p, estimate e and reset time r
//            (0 = unknown) recorded at time t
const DAY = 86400e3;
const SAME_RESET_MS = 5 * 60e3; // reset times of one window jitter by fractions of a second

// Rebuilt percents are capped at 100: more means the limit was hit (or the
// rate is off), never that more than the whole limit was used.
const pctOf = (cost, k) => (k ? Math.min(100, k * cost) : null);

// Server readings belong to the window their reset time names; readings
// without one fall back to their timestamp.
function samplesOf(samples, start, end) {
  return (samples || []).filter(s => (s.r ? Math.abs(s.r - end) < SAME_RESET_MS : s.t >= start && s.t < end));
}
const maxP = list => (list.length ? Math.max(...list.map(s => s.p)) : null);

function finish(x, k, samples, now) {
  const own = samplesOf(samples, x.start, x.end);
  const server = maxP(own);
  const est = pctOf(x.cost, k);
  return { start: x.start, end: x.end, pct: server == null ? est : Math.max(server, est || 0), measured: server != null, current: x.start <= now && now < x.end };
}

// Session windows (5h), newest first, ending after `since`.
// Windows the server reported (current anchor, reset times of recorded
// readings) are used as-is. Between them, a window starts with the first
// message after the previous one ended and is cut where a server window
// starts. Records from one window length before `since` are used so the
// oldest window shown has its real start.
function sessionWindows(records, { windowMs, k, anchor, since, samples, now }) {
  const fixed = [];
  const addFixed = end => {
    if (!end || fixed.some(a => Math.abs(a.end - end) < SAME_RESET_MS)) return;
    fixed.push({ start: end - windowMs, end, cost: 0 });
  };
  if (anchor) addFixed(anchor.end);
  for (const s of samples || []) if (s.r) addFixed(s.r);
  fixed.sort((a, b) => a.start - b.start);
  // overlapping server windows can't both be right; keep the later one
  for (let i = fixed.length - 2; i >= 0; i--) if (fixed[i].end > fixed[i + 1].start) fixed[i].end = fixed[i + 1].start;

  const out = [...fixed];
  let w = null;
  for (const r of records) {
    if (r.ts < since - windowMs) continue;
    const f = fixed.find(a => r.ts >= a.start && r.ts < a.end);
    if (f) { f.cost += r.cost; w = null; continue; }
    if (!w || r.ts >= w.end) {
      const next = fixed.find(a => a.start > r.ts);
      w = { start: r.ts, end: Math.min(r.ts + windowMs, next ? next.start : Infinity), cost: 0 };
      out.push(w);
    }
    w.cost += r.cost;
  }
  return out
    .filter(x => x.end > since)
    .sort((a, b) => b.start - a.start)
    .map(x => finish(x, k, samples, now));
}

// Usage over one window in `cols` time slices, cumulative (each slice holds the
// highest value reached by its end). Slices after `now` are null.
function windowSeries({ start, end }, records, { k, samples, now, cols = 72 }) {
  const step = (end - start) / cols;
  const out = new Array(cols).fill(null);
  const points = [];
  let cost = 0;
  for (const r of records) {
    if (r.ts < start || r.ts >= end) continue;
    cost += r.cost;
    if (k) points.push([r.ts, Math.min(100, k * cost)]);
  }
  for (const s of samplesOf(samples, start, end)) points.push([s.t, s.e != null ? Math.max(s.p, s.e) : s.p]);
  points.sort((a, b) => a[0] - b[0]);
  let best = 0, j = 0;
  for (let i = 0; i < cols; i++) {
    const sliceEnd = start + (i + 1) * step;
    if (start + i * step > now) break;
    while (j < points.length && points[j][0] < sliceEnd) best = Math.max(best, points[j++][1]);
    out[i] = best;
  }
  return out;
}

// Fixed-schedule windows (weekly), newest first, counted back from the
// current reset. Each has the percent added per 24 h from its start and the
// total. Windows before the local records begin (`since`) can still appear
// from recorded server readings.
function fixedWindows(records, { resetsAt, windowMs, k, count = 6, samples, now, since }) {
  const out = [];
  const days = Math.round(windowMs / DAY);
  for (let i = 0; i < count; i++) {
    const end = resetsAt - i * windowMs, start = end - windowMs;
    const daily = new Array(days).fill(0);
    let cost = 0, any = false;
    for (const r of records) {
      if (r.ts < start || r.ts >= end) continue;
      any = true;
      cost += r.cost;
      daily[Math.min(days - 1, Math.floor((r.ts - start) / DAY))] += r.cost;
    }
    const server = maxP(samplesOf(samples, start, end));
    if (!any && server == null) continue;
    const est = any ? pctOf(cost, k) : null;
    out.push({
      start, end, current: start <= now && now < end, measured: server != null,
      pct: server == null ? est : Math.max(server, est || 0),
      daily: k && any ? daily.map(c => Math.min(100, k * c)) : null,
      partial: start < since // the local records don't reach back to the window start
    });
  }
  return out;
}

// One calendar month before t, with the day clamped (a reset on May 31
// starts on Apr 30, not on "Apr 31" = May 1).
function monthBefore(t) {
  const d = new Date(t), day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d.getTime();
}

// Monthly limits (Cursor, Copilot): billing cycles from the recorded server
// readings alone (Copilot has no local logs), newest first, at most `count`.
// A cycle is the readings that name the same reset time. The current cycle
// starts at resetsAt - windowMs (the source's own window); an older one at the
// end of the cycle before it, or one calendar month back for the oldest.
// Each cycle: { start, end, pct (highest reading), daily (percent added per
// day; null for days ahead and for days before the first reading of a cycle
// joined late), current, partial (readings start more than a day after the
// cycle) }. The current cycle is listed even before its first reading.
// samples must be oldest first (as LimitHistory.samples returns them).
function monthlyCycles(samples, { resetsAt, windowMs, now, count = 3 }) {
  const groups = new Map(); // reset time -> readings
  let last = null;          // readings come in time order: compare with the last cycle first
  for (const s of samples || []) {
    if (!s.r) continue;
    let key = last != null && Math.abs(last - s.r) < SAME_RESET_MS ? last : null;
    if (key == null) for (const r of groups.keys()) if (Math.abs(r - s.r) < SAME_RESET_MS) { key = r; break; }
    if (key == null) { key = s.r; groups.set(key, []); }
    groups.get(key).push(s);
    last = key;
  }
  if (resetsAt && ![...groups.keys()].some(r => Math.abs(r - resetsAt) < SAME_RESET_MS)) groups.set(resetsAt, []);
  const ends = [...groups.keys()].sort((a, b) => b - a);
  return ends.slice(0, count).map((end, i) => {
    const list = groups.get(end);
    const isCurrent = resetsAt && Math.abs(end - resetsAt) < SAME_RESET_MS;
    const start = isCurrent && windowMs ? end - windowMs : i + 1 < ends.length ? ends[i + 1] : monthBefore(end);
    const val = s => (s.e != null ? Math.max(s.e, s.p) : s.p);
    const partial = !list.length || list[0].t > start + DAY;
    // round: a cycle across a DST change is 30 d ± 1 h, not an extra day
    const days = Math.max(1, Math.round((end - start) / DAY));
    const firstDay = list.length ? Math.floor((list[0].t - start) / DAY) : days;
    const daily = [];
    // A cycle joined late starts from its first reading: what came before is unknown.
    let prev = partial && list.length ? val(list[0]) : 0, j = 0, level = prev;
    for (let d = 0; d < days; d++) {
      const dayEnd = start + (d + 1) * DAY;
      if (start + d * DAY > now || (partial && d < firstDay)) { daily.push(null); continue; }
      while (j < list.length && list[j].t < dayEnd) level = Math.max(level, val(list[j++]));
      daily.push(Math.max(0, level - prev));
      prev = Math.max(prev, level);
    }
    return {
      start, end, pct: list.length ? Math.max(...list.map(val)) : null, measured: list.length > 0, daily,
      current: start <= now && now < end, partial
    };
  });
}

module.exports = { sessionWindows, windowSeries, fixedWindows, monthlyCycles, samplesOf };
