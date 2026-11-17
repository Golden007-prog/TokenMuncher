// Number texts shared by the windows and the notifications.

// Token counts: 412.30 M, 1.25 B, 3.4 k.
const fmtTok = n => (n >= 1e9 ? (n / 1e9).toFixed(2) + ' B' : n >= 1e6 ? (n / 1e6).toFixed(2) + ' M' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' k' : String(Math.round(n)));

// Change against an earlier value, as text: "+18%" / "-4%" / "0%"; null
// without a base to compare with.
function change(now, before) {
  if (!(before > 0)) return null;
  const p = Math.round((now - before) / before * 100);
  return (p > 0 ? '+' : '') + p + '%';
}

module.exports = { fmtTok, change };
