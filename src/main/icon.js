// The skin's mascot as a native image in a status color, for the tray and
// notifications. Drawing is shared with the app icon (src/shared/critter.js).
const { nativeImage } = require('electron');
const { drawCritter } = require('../shared/critter');
const { themeOf, lookOf } = require('../shared/themes');

// Status colors, sRGB approximations of the UI's oklch tokens.
// Each skin has its own ok / warn / danger (readable on its tile); "idle" is
// the skin's accent.
const colorOf = (status, theme) => theme.tray[status] || theme.tray.body;

// tile: a rounded tile in the skin's background behind the mascot (tray), or none (toasts).
function bitmap(rgb, size, theme, mascot, tile = false) {
  const rgba = drawCritter(size, { body: rgb, tile, mascot, tileColor: theme.tray.tile });
  const bgra = Buffer.alloc(rgba.length); // createFromBitmap wants BGRA
  for (let i = 0; i < rgba.length; i += 4) {
    bgra[i] = rgba[i + 2]; bgra[i + 1] = rgba[i + 1]; bgra[i + 2] = rgba[i]; bgra[i + 3] = rgba[i + 3];
  }
  return nativeImage.createFromBitmap(bgra, { width: size, height: size });
}

const cache = new Map();
// look: { theme, mascot } from lookOf (shared/themes.js), the mascot resolved.
// Tray icon: a tile with the mascot in the status color, 16 px with a 2x
// representation for high-DPI screens.
function critterIcon(status = 'idle', look = lookOf()) {
  const theme = themeOf(look.theme), mascot = look.mascot;
  const key = status + ':' + theme.name + ':' + mascot;
  if (cache.has(key)) return cache.get(key);
  const rgb = colorOf(status, theme);
  const img = bitmap(rgb, 16, theme, mascot, true);
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: bitmap(rgb, 32, theme, mascot, true).toPNG() });
  cache.set(key, img);
  return img;
}

function critterLarge(status = 'idle', look = lookOf()) {
  const theme = themeOf(look.theme);
  return bitmap(colorOf(status, theme), 64, theme, look.mascot);
}

function statusFor(pct) {
  if (pct == null) return 'idle';
  return pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok';
}

module.exports = { critterIcon, critterLarge, statusFor };
