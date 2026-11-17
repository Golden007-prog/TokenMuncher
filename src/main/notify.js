// Notification rules. Pure: no Electron, no clock, no I/O, so it can be unit tested.
//
// evaluate(prevState, limits, now, opts) -> { notifications, state }
//   opts.thresholds: percents that notify (default 80 / 90 / 100, from settings)
//   opts.forecast:   false turns the 5h run-out warning off
//   limits: snapshot limits ({ key, provider, kind, name, percent, est, v, resetsAt })
//   state:  per limit key { resetsAt, sent: [thresholds], forecast: bool, peak }
//
// Rules, each at most once per limit window:
//   - crossing a threshold (80 / 90 % by default) of the estimate, 100 % only when the server itself reports it
//     (only the highest one when several are crossed at once)
//   - forecast: a session-type window (5h) will run out within 30 min and before it resets
//   - reset: a window that reached the lowest threshold has just reset
//
// A new window starts only when the old one is over: its reset time has passed,
// or (when the reset time moved or is unknown) the percent dropped sharply.
// A reset time that shifts or briefly goes missing keeps the current window.
const THRESHOLDS = [80, 90, 100];
const FORECAST_SEC = 30 * 60;
const FORECAST_MIN_PCT = 50;      // ignore forecasts early in a window; speed is too noisy then
const SAME_WINDOW_MS = 5 * 60e3;  // server reset times jitter by fractions of a second
const RESET_DROP = 20;            // percentage points; a drop this big means the window reset
const RESET_NEWS_MS = 15 * 60e3;  // resets older than this (app was closed) are not announced

const { when } = require('../shared/clock');
const { runoutBeforeReset } = require('../shared/forecast');
const mins = sec => Math.max(1, Math.round(sec / 60));

function sameWindow(a, b) {
  if (a == null || b == null) return a == b; // eslint-disable-line eqeqeq
  return Math.abs(a - b) < SAME_WINDOW_MS;
}

function evaluate(prev, limits, now, opts = {}) {
  const thresholds = opts.thresholds || THRESHOLDS;
  const resetFrom = thresholds.length ? thresholds[0] : Infinity; // all thresholds off: no reset news either
  const state = { ...(prev || {}) };
  const notifications = [];

  for (const l of limits) {
    // A reading whose window already ended is stale; wait for fresh data.
    if (l.resetsAt != null && l.resetsAt <= now) continue;
    const label = `${l.provider} ${l.name}`;
    const p = l.est != null ? l.est : l.percent;
    let s = state[l.key];

    if (s) {
      const moved = !sameWindow(s.resetsAt, l.resetsAt);
      const timeUp = s.resetsAt != null && s.resetsAt <= now + 60e3;
      const dropped = p < s.peak - RESET_DROP && (moved || s.resetsAt == null);
      if (timeUp || dropped) {
        const recent = s.resetsAt == null || s.resetsAt >= now - RESET_NEWS_MS;
        if (s.peak >= resetFrom && recent) {
          notifications.push({ id: `${l.key}:reset:${s.resetsAt}`, kind: 'reset', title: `${label} reset`, body: `Back to ${Math.round(p)}%. Full speed again.` });
        }
        s = null;
      } else if (moved && l.resetsAt != null) {
        s = { ...s, resetsAt: l.resetsAt }; // reset time shifted or became known: same window
      }
    }
    s = s ? { ...s, sent: [...s.sent] } : { resetsAt: l.resetsAt, sent: [], forecast: false, peak: 0 };
    s.peak = Math.round(Math.max(s.peak, p) * 10) / 10;

    const reached = t => (t >= 100 ? l.percent >= 100 : p >= t);
    const crossed = thresholds.filter(t => reached(t) && !s.sent.includes(t));
    if (crossed.length) {
      const t = crossed[crossed.length - 1];
      s.sent.push(...crossed);
      const reset = l.resetsAt ? ` Resets ${when(l.resetsAt, now, { absolute: true })}.` : '';
      notifications.push({
        id: `${l.key}:${t}:${l.resetsAt}`, kind: 'threshold', level: t,
        title: t >= 100 ? `${label} limit reached` : `${label} at ${Math.floor(p)}%`,
        body: (t >= 100 ? 'You are out of this limit.' : `Passed ${t}% of this limit.`) + reset
      });
    }

    if (opts.forecast !== false && l.kind === 'session' && !s.forecast && p >= FORECAST_MIN_PCT) {
      const left = runoutBeforeReset({ ...l, est: p }, now); // seconds until 100 %, if before the reset
      const toReset = (l.resetsAt - now) / 1000;
      if (left != null && left < FORECAST_SEC) {
        s.forecast = true;
        notifications.push({
          id: `${l.key}:forecast:${l.resetsAt}`, kind: 'forecast',
          title: `${label} runs out in ~${mins(left)} min`,
          body: `At this pace you hit the limit ${when(now + left * 1000, now, { absolute: true })}, ${mins(toReset - left)} min before it resets.`
        });
      }
    }

    state[l.key] = s;
  }
  return { notifications, state };
}

// A threshold switched on in settings: windows already past it count it as
// sent, so the next evaluate doesn't announce it late.
function markReached(state, t) {
  const out = {};
  for (const [key, s] of Object.entries(state || {})) out[key] = s.peak >= t && !s.sent.includes(t) ? { ...s, sent: [...s.sent, t] } : s;
  return out;
}

module.exports = { evaluate, markReached, THRESHOLDS };
