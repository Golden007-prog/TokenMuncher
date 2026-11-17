// WCAG contrast of skin colours: '#rrggbb', 'oklch(L C H)' or [r, g, b].
// Test helper, not a test file.

const srgbToLinear = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

// Linear sRGB [r, g, b] in 0..1 of an oklch colour (clamped to the gamut).
function oklchToLinear(L, C, h) {
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ].map(v => Math.min(1, Math.max(0, v)));
}

// Linear sRGB [r, g, b] in 0..1 of any accepted colour.
function linear(colour) {
  if (Array.isArray(colour)) return colour.map(srgbToLinear);
  if (colour.startsWith('#')) return [1, 3, 5].map(i => srgbToLinear(parseInt(colour.slice(i, i + 2), 16)));
  const m = colour.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
  if (!m) throw new Error('unknown colour ' + colour);
  return oklchToLinear(+m[1], +m[2], +m[3]);
}

function luminance(colour) {
  const lin = linear(colour);
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

// OKLab [L, a, b] of a colour (via linear sRGB, so oklch gets gamut-clamped
// like the screen shows it).
function oklab(colour) {
  const [r, g, b] = linear(colour);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

// How far apart two colours look: Euclidean distance in OKLab (about 0.02 is
// barely visible; distinct chart colours want several times that).
function distance(a, b) {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

function contrastOf(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

module.exports = { contrastOf, luminance, oklab, distance };
