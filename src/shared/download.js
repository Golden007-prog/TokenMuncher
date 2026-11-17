// Texts for a running download: { got, size, speed } in bytes and bytes per
// second -> { mb: '27.8 / 81.6 MB', speed: '180 KB/s', left: '5 min left' }.
// speed and left are null while there is nothing to measure yet.
const mb = n => (n / 1e6).toFixed(1);

function downloadText({ got = 0, size = 0, speed = 0 } = {}) {
  const out = { mb: `${mb(got)} / ${mb(size)} MB`, speed: null, left: null };
  if (!(speed > 0)) return out;
  out.speed = speed >= 1e6 ? `${mb(speed)} MB/s` : `${Math.max(1, Math.round(speed / 1e3))} KB/s`;
  const sec = Math.max(0, size - got) / speed;
  const min = Math.round(sec / 60); // whole minutes first, so it never says "60 min"
  out.left = sec < 60 ? 'under a minute left' : min < 60 ? `${min} min left` : `${Math.floor(min / 60)} h ${min % 60} min left`;
  return out;
}

module.exports = { downloadText };
