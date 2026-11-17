// Polling policy for the Claude plan-usage endpoint. Pure functions, unit tested.
// The endpoint rate-limits (HTTP 429), and percents between polls are estimated
// locally anyway, so polling is slow by default and fast only near a limit.
const BASE_MS = 3 * 60e3;       // normal pace
const FAST_MS = 60e3;           // a limit is at 80 %+ and tokens are burning
const MIN_GAP_MS = 60e3;        // never poll closer together than this, even on restart
const MAX_BACKOFF_MS = 15 * 60e3;
const MAX_RETRY_AFTER_MS = 60 * 60e3;

// Retry-After is either seconds or an HTTP date. Returns milliseconds or null.
function parseRetryAfter(value, now) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

// Delay before the next poll.
//   status: HTTP status of the last poll (0 = network error)
//   prevDelay: the delay used before the last poll (for exponential backoff)
//   limits: [{ percent, resetsAt }] with percent = the current estimate
function nextDelay({ status, retryAfterMs, prevDelay, limits, burning, now }) {
  if (status === 429) {
    // Doubles from at least the normal pace, so a 429 after fast polling still
    // waits 6 min. The endpoint sends "Retry-After: 0", so the header can only
    // lengthen the wait.
    const backoff = Math.min(MAX_BACKOFF_MS, Math.max(BASE_MS, prevDelay || BASE_MS) * 2);
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(backoff, retryAfterMs || 0));
  }
  if (status !== 200) return BASE_MS;
  const hot = burning && (limits || []).some(l => l.percent >= 80 && (l.resetsAt == null || l.resetsAt > now));
  return hot ? FAST_MS : BASE_MS;
}

// Wait before the first poll after start: keep the minimum gap after the last
// fetch, and finish a backoff that was running when the app was closed.
function firstDelay({ fetchedAt, retryUntil }, now) {
  const gap = fetchedAt ? fetchedAt + MIN_GAP_MS - now : 0;
  const backoff = retryUntil ? retryUntil - now : 0;
  return Math.max(0, gap, backoff);
}

// Limits saved on disk. Used only for the same logged-in account.
function reviveCached(cache, accountId) {
  if (!cache || !Array.isArray(cache.limits) || !cache.fetchedAt) return null;
  if (!accountId || (cache.account && cache.account !== accountId)) return null;
  return {
    plan: cache.plan || null,
    breakdown: Array.isArray(cache.breakdown) ? cache.breakdown : [],
    fetchedAt: cache.fetchedAt,
    limits: cache.limits,
    rates: cache.rates && typeof cache.rates === 'object' ? cache.rates : {},
    retryUntil: cache.retryUntil || 0,
    delay: cache.delay || BASE_MS
  };
}

// A limit whose reset time has passed (data from before the reset): show the
// window that follows it at 0 %.
//   weekly-type windows run on a fixed schedule: step forward by the window length
//   session (5h) windows start with the first message after the reset;
//   firstActivityAfter(t) returns that timestamp or null (no window yet)
function rollWindow(l, now, firstActivityAfter) {
  if (l.resetsAt == null || l.resetsAt > now) return l;
  const len = l.windowSec * 1000;
  if (l.kind === 'session') {
    const start = firstActivityAfter(l.resetsAt);
    return { ...l, percent: 0, resetsAt: start == null ? null : start + len, rolled: true };
  }
  let r = l.resetsAt;
  while (r <= now) r += len;
  return { ...l, percent: 0, resetsAt: r, rolled: true };
}

module.exports = { parseRetryAfter, nextDelay, firstDelay, reviveCached, rollWindow, BASE_MS, FAST_MS, MIN_GAP_MS, MAX_BACKOFF_MS };
