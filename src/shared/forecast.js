// One definition of "when does this limit run out", used by the dashboard,
// the mini widget and the notifications, so they never disagree.
//   l: { est, v (percent per second), resetsAt }

const MIN_SPEED = 1e-7; // percent per second; slower than this counts as "nothing burning"

const burning = l => (l.v || 0) >= MIN_SPEED;

// Seconds until the limit reaches 100 % at the current speed (Infinity when idle).
function secondsToFull(l) {
  return burning(l) ? Math.max(0, (100 - l.est) / l.v) : Infinity;
}

// Seconds until 100 % if that happens before the reset, else null.
function runoutBeforeReset(l, now) {
  if (l.est >= 100 || !l.resetsAt) return null;
  const left = secondsToFull(l);
  return left < (l.resetsAt - now) / 1000 ? left : null;
}

module.exports = { MIN_SPEED, burning, secondsToFull, runoutBeforeReset };
