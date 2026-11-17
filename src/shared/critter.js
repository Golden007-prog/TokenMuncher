// The mascots: pixel maps and one rasterizer, used by the dashboard, the mini
// widget, the tray icon, notification images and the app icon generator.
//   X body · o eye · m mouth · s sweat drop · . empty
// Each skin (src/shared/themes.js) has its own mascot; the app icon is always
// the critter. Plain Uint8Array output (no Node Buffer), so this module is safe
// in the sandboxed renderer too.
const W = 12, H = 10;

// Every mascot: base rows (the 'plain' face) and per mood the rows that change
// (eat has two frames, alternating ~7 times a second).
const MASCOTS = {
  // Claude skin: the original critter
  critter: {
    rows: ['..X......X..', '..XX....XX..', '.XXXXXXXXXX.', 'XXXXXXXXXXXX', 'XXooXXXXooXX', 'XXooXXXXooXX', 'XXXXXXXXXXXX', 'XXXXXXXXXXXX', '.XXXXXXXXXX.', '.X.X....X.X.'],
    sleep: { 4: 'XXXXXXXXXXXX', 7: 'XXXXXmmXXXXX' },
    calm: { 7: 'XXXXmmmmXXXX' },
    eat: [{ 7: 'XXXmmmmmmXXX' }, { 6: 'XXXXmmmmXXXX', 7: 'XXXXmmmmXXXX' }],
    panic: { 2: '.XXXXXXXXXXs', 3: 'XXooXXXXooXs', 6: 'XXXmmmmmmXXX', 7: 'XXXmXXXXmXXX' }
  },
  // Codex skin: a little terminal with a prompt for a face
  bot: {
    rows: ['.XXXXXXXXXX.', 'XX........XX', 'XX.X......XX', 'XX..X.....XX', 'XX.X..XXX.XX', 'XX........XX', '.XXXXXXXXXX.', '.....XX.....', '...XXXXXX...', '..XXXXXXXX..'],
    sleep: { 2: 'XX........XX', 3: 'XX.XX..XX.XX', 4: 'XX........XX' },
    calm: {},
    eat: [{}, { 4: 'XX.X......XX' }], // the cursor blinks
    panic: { 0: '.XXXXXXXXXXs', 1: 'XX........Xs', 2: 'XX..X..X..XX', 3: 'XX..X..X..XX', 4: 'XX........XX', 5: 'XX..X..X..XX' }
  },
  // Cursor skin: a pointer with a face
  pointer: {
    rows: ['.XX.........', '.XXXX.......', '.XXXXXX.....', '.XXoXXoXX...', '.XXoXXoXXXX.', '.XXXXXXXXXXX', '.XXXXXXXX...', '.XXXXXXX....', '.XX..XXX....', '.X....XXX...'],
    sleep: { 3: '.XXXXXXXX...', 4: '.XooXooXXXX.', 6: '.XXXXmXXX...' },
    calm: { 6: '.XXXmmXXX...' },
    eat: [{ 6: '.XXmmmmXX...' }, { 6: '.XXXmmXXX...', 7: '.XXXmmXX....' }],
    panic: { 0: '.XX......s..', 1: '.XXXX....s..', 3: '.XooXooXX...', 4: '.XooXooXXXX.', 6: '.XmmmmmmX...' }
  },
  // Copilot skin: a round pilot with goggles
  pilot: {
    rows: ['...XXXXXX...', '.XXXXXXXXXX.', 'XXXXXXXXXXXX', 'X...XXXX...X', 'X.X.XXXX.X.X', 'XXXXXXXXXXXX', 'XXXXXXXXXXXX', 'XXXXXXXXXXXX', '.XXXXXXXXXX.', '.XX......XX.'],
    sleep: { 3: 'XXXXXXXXXXXX', 4: 'X...XXXX...X', 7: 'XXXXXmmXXXXX' },
    calm: { 7: 'XXXXmmmmXXXX' },
    eat: [{ 7: 'XXXmmmmmmXXX' }, { 6: 'XXXXmmmmXXXX', 7: 'XXXXmmmmXXXX' }],
    panic: { 1: '.XXXXXXXXXXs', 2: 'XXXXXXXXXXXs', 3: 'X.X.XXXX.X.X', 4: 'X...XXXX...X', 6: 'XXXmmmmmmXXX', 7: 'XXXmXXXXmXXX' }
  },
  // Paper skin: a cat
  cat: {
    rows: ['X..........X', 'XX........XX', 'XXXXXXXXXXXX', 'XXoXXXXXXoXX', 'XXXXXXXXXXXX', 'XXXXXXXXXXXX', '.XXXXXXXXXX.', '..XXXXXXXX..', '..XXXXXXXX.X', '..XX....XXX.'],
    sleep: { 3: 'XXXXXXXXXXXX', 5: 'XXXXXmmXXXXX' },
    calm: { 5: 'XXXXXmmXXXXX' },
    eat: [{ 5: 'XXXmmmmmmXXX' }, { 5: 'XXXXmmmmXXXX', 6: '.XXXmmmmXXX.' }],
    panic: { 1: 'XX........Xs', 2: 'XXXXXXXXXXXs', 3: 'XooXXXXXXooX', 5: 'XXXmmmmmmXXX' }
  },
  // Dracula skin: a bat with spread wings
  bat: {
    rows: ['.X........X.', '.XX......XX.', '.XXXXXXXXXX.', 'XXooXXXXooXX', 'XXXXXXXXXXXX', 'XXXXXXXXXXXX', 'XX.XXXXXX.XX', 'X..XXXXXX..X', '....XXXX....', '.....XX.....'],
    sleep: { 3: 'XXXXXXXXXXXX', 4: 'XXmmXXXXmmXX', 5: 'XXXXXmmXXXXX' },
    calm: { 5: 'XXXXmmmmXXXX' },
    eat: [{ 5: 'XXXmmmmmmXXX' }, { 5: 'XXXXmmmmXXXX', 6: 'XX.XmmmmX.XX' }],
    panic: { 0: '.X........Xs', 1: '.XX......XXs', 3: 'XooXXXXXXooX', 5: 'XXXmmmmmmXXX', 6: 'XX.mXXXXm.XX' }
  },
  // Tokyo Night and Solarized skins: an owl
  owl: {
    rows: ['XX........XX', 'XXX......XXX', '.XXXXXXXXXX.', '.XooXXXXooX.', '.XooXXXXooX.', '.XXXXmmXXXX.', 'XXXXXXXXXXXX', 'XX.XXXXXX.XX', '.XXXXXXXXXX.', '..X.X..X.X..'],
    sleep: { 3: '.XXXXXXXXXX.', 4: '.XmmXXXXmmX.' },
    calm: {},
    eat: [{ 5: '.XXXmmmmXXX.' }, { 5: '.XXXXmmXXXX.', 6: 'XXXXXmmXXXXX' }],
    panic: { 0: 'XX........Xs', 1: 'XXX......XXs', 3: '.oooXXXXooo.', 4: '.oooXXXXooo.', 5: '.XXXmmmmXXX.' }
  },
  // Nord and Gruvbox skins: a fox
  fox: {
    rows: ['X..........X', 'XX........XX', 'XXX......XXX', 'XXXXXXXXXXXX', 'XXooXXXXooXX', 'XXXXXXXXXXXX', '.XXXXXXXXXX.', '..XXXXXXXX..', '...XXXXXX...', '....XXXX....'],
    sleep: { 4: 'XXXXXXXXXXXX', 5: 'XXmmXXXXmmXX' },
    calm: { 7: '..XXXmmXXX..' },
    eat: [{ 7: '..XXmmmmXX..' }, { 7: '..XXXmmXXX..', 8: '...XmmmmX...' }],
    panic: { 2: 'XXX....s.XXX', 3: 'XXXXXXXXXXXs', 4: 'XooXXXXXXooX', 7: '..XmmmmmmX..' }
  },
  // Windows and macOS skins: an app window with a face
  window: {
    rows: ['.XXXXXXXXXX.', '.XmXmXmXXXX.', '.XXXXXXXXXX.', '.XXXXXXXXXX.', '.XXooXXooXX.', '.XXooXXooXX.', '.XXXXXXXXXX.', '.XXXXXXXXXX.', '.XXXXXXXXXX.', '..XX....XX..'],
    sleep: { 4: '.XXXXXXXXXX.', 5: '.XmmXXXXmmX.', 7: '.XXXXmmXXXX.' },
    calm: { 7: '.XXXmmmmXXX.' },
    eat: [{ 7: '.XXmmmmmmXX.' }, { 6: '.XXXmmmmXXX.', 7: '.XXXmmmmXXX.' }],
    panic: { 0: '.XXXXXXXXXXs', 1: '.XmXmXmXXXXs', 4: '.ooXXXXXXoo.', 5: '.ooXXXXXXoo.', 7: '.XmmmmmmmmX.', 8: '.XmXXXXXXmX.' }
  }
};
const MASCOT_IDS = Object.keys(MASCOTS);
const MOODS = ['sleep', 'calm', 'panic']; // plus 'plain' and the animated 'eat'
const PIX = MASCOTS.critter.rows;

// Rows for a mood of a mascot; t (seconds) animates eating. Unknown moods get
// the panic face, unknown mascots the critter.
function critterRows(mood, t = 0, mascot = 'critter') {
  const m = Object.hasOwn(MASCOTS, mascot) ? MASCOTS[mascot] : MASCOTS.critter;
  const rows = m.rows.slice();
  if (mood === 'plain') return rows;
  const frame = ((Math.floor(t * 7) % 2) + 2) % 2; // also for a negative t
  const changes = mood === 'eat' ? m.eat[frame] : MOODS.includes(mood) ? m[mood] : m.panic;
  for (const [y, row] of Object.entries(changes)) rows[y] = row;
  return rows;
}

const TILE = [0x1b, 0x1a, 0x19];  // app background; also the eye color
const CLAY = [0xe0, 0x78, 0x4a];  // body

// Where the critter sits in a size x size image: a whole-number pixel scale,
// with a margin when requested, but edge to edge when the margin would make it
// much smaller (24 px: 2x fills the tile, 1x would cover only half of it).
function layout(size, withMargin) {
  if (size < W) throw new RangeError(`critter needs at least ${W} px, got ${size}`);
  let scale = withMargin ? Math.floor((size - Math.max(2, size * 0.12)) / W) : Math.floor(size / W);
  if (scale * W < size * 0.6) scale = Math.floor(size / W);
  scale = Math.max(1, scale);
  return { scale, ox: Math.floor((size - W * scale) / 2), oy: Math.floor((size - H * scale) / 2) };
}

// RGBA bytes of a size x size mascot image.
//   tile: draw a rounded tile behind it (app icon, tray) in tileColor
//   body: body color · mood: which face (default 'calm' on a tile, 'plain' without)
//   mascot: which one (default the critter)
// Eyes and mouth are tile-colored (on the tile they read as holes).
function drawCritter(size, { tile = false, body = CLAY, mood, mascot = 'critter', tileColor = TILE } = {}) {
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };
  if (tile) {
    const radius = Math.max(2, Math.round(size * 0.18));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const cx = x < radius ? radius - x - 0.5 : x >= size - radius ? x - (size - radius) + 0.5 : 0;
        const cy = y < radius ? radius - y - 0.5 : y >= size - radius ? y - (size - radius) + 0.5 : 0;
        if (cx * cx + cy * cy <= radius * radius) set(x, y, tileColor);
      }
    }
  }
  const { scale, ox, oy } = layout(size, tile);
  const rows = critterRows(mood || (tile ? 'calm' : 'plain'), 0, mascot);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = rows[y][x];
      if (c === '.' || (tile && c !== 'X')) continue; // on the tile, eyes and mouth stay holes
      const color = c === 'X' ? body : tileColor;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) set(ox + x * scale + dx, oy + y * scale + dy, color);
    }
  }
  return px;
}

module.exports = { PIX, W, H, MASCOTS, MASCOT_IDS, critterRows, layout, drawCritter, TILE, CLAY };
