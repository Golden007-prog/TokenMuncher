// The project page: the mascot, the skin picker, the light/dark switch and the
// download button. The page works without this script (the button then leads
// to the releases page).
(function () {
  // The critter of the app (src/shared/critter.js): X body, o eye, m mouth.
  var ROWS = ['..X......X..', '..XX....XX..', '.XXXXXXXXXX.', 'XXXXXXXXXXXX', 'XXooXXXXooXX', 'XXooXXXXooXX', 'XXXXXXXXXXXX', 'XXXXXXXXXXXX', '.XXXXXXXXXX.', '.X.X....X.X.'];
  var CALM = { 7: 'XXXXmmmmXXXX' };
  var EAT = [{ 7: 'XXXmmmmmmXXX' }, { 6: 'XXXXmmmmXXXX', 7: 'XXXXmmmmXXXX' }];

  function draw(svg, face) {
    var out = '';
    for (var y = 0; y < ROWS.length; y++) {
      var row = face[y] || ROWS[y];
      for (var x = 0; x < row.length; x++) {
        var ch = row[x];
        if (ch === '.') continue;
        out += '<rect x="' + x + '" y="' + y + '" width="1.02" height="1.02" fill="' + (ch === 'X' ? 'var(--clay)' : 'var(--bg)') + '"/>';
      }
    }
    svg.innerHTML = out;
  }

  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  Array.prototype.forEach.call(document.querySelectorAll('svg[data-critter]'), function (svg) {
    svg.setAttribute('viewBox', '0 0 12 10');
    draw(svg, CALM);
    if (svg.getAttribute('data-critter') !== 'eat' || still) return;
    var i = 0;
    setInterval(function () { draw(svg, EAT[i++ % 2]); }, 140);
  });

  // Skins: one screenshot, swapped by the buttons.
  var shot = document.getElementById('skin-shot');
  var tabs = document.querySelectorAll('.tabs button');
  Array.prototype.forEach.call(tabs, function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call(tabs, function (o) { o.setAttribute('aria-pressed', o === b ? 'true' : 'false'); });
      shot.src = 'screenshots/theme-' + b.getAttribute('data-skin') + '.png';
      shot.alt = 'TokenMuncher in the ' + b.textContent + ' skin';
    });
  });

  // Light / dark: follows the system until the visitor picks one.
  var root = document.documentElement;
  var toggle = document.getElementById('theme-toggle');
  function isLight() {
    var set = root.getAttribute('data-theme');
    return set ? set === 'light' : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  }
  function label() { toggle.textContent = isLight() ? '[ dark ]' : '[ light ]'; }
  try { var saved = localStorage.getItem('theme'); if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved); } catch (e) { /* no storage */ }
  if (toggle) {
    label();
    toggle.addEventListener('click', function () {
      var next = isLight() ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) { /* no storage */ }
      label();
    });
  }

  // Download button: the newest installer straight from the release.
  var btn = document.getElementById('download');
  var arm = document.getElementById('download-arm');
  if (!btn || !window.fetch) return;
  fetch('https://api.github.com/repos/bartoszclapinski/TokenMuncher/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (rel) {
      if (!rel || !rel.assets) return;
      var x64 = null, arm64 = null;
      rel.assets.forEach(function (a) {
        if (/^TokenMuncher-Setup-[\d.]+\.exe$/.test(a.name)) x64 = a;
        if (/^TokenMuncher-Setup-[\d.]+-arm64\.exe$/.test(a.name)) arm64 = a;
      });
      if (x64) {
        btn.href = x64.browser_download_url;
        btn.querySelector('small').textContent = rel.tag_name + ' · ' + Math.round(x64.size / 1048576) + ' MB';
      }
      if (arm64 && arm) arm.href = arm64.browser_download_url;
    })
    .catch(function () { /* the links to the releases page stay */ });
})();
