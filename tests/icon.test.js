const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { encodePng, encodeIco, encodeBmp, buildInstallerSidebar, crc32, ICON_SIZES } = require('../scripts/icon-lib');
const { drawCritter, critterRows, layout, PIX, TILE, CLAY } = require('../src/shared/critter');

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Splits a PNG into chunks and checks each CRC.
function chunks(png) {
  assert.deepEqual([...png.subarray(0, 8)], SIG);
  const out = [];
  for (let i = 8; i < png.length;) {
    const len = png.readUInt32BE(i), type = png.toString('ascii', i + 4, i + 8);
    const data = png.subarray(i + 8, i + 8 + len);
    assert.equal(png.readUInt32BE(i + 8 + len), crc32(png.subarray(i + 4, i + 8 + len)), `CRC of ${type}`);
    out.push({ type, data });
    i += 12 + len;
  }
  return out;
}

// RGBA pixels of one of our PNGs (unfiltered rows).
function pixels(png) {
  const cs = chunks(png);
  const w = cs[0].data.readUInt32BE(0), h = cs[0].data.readUInt32BE(4);
  const raw = zlib.inflateSync(Buffer.concat(cs.filter(c => c.type === 'IDAT').map(c => c.data)));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) raw.copy(out, y * w * 4, y * (1 + w * 4) + 1, (y + 1) * (1 + w * 4));
  return out;
}

test('crc32 matches the reference value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('PNG has IHDR, IDAT and IEND with valid CRCs and the right pixel data', () => {
  const w = 5, h = 3, rgba = new Uint8Array(w * h * 4).fill(0x7f);
  const png = encodePng(w, h, rgba);
  const cs = chunks(png);
  assert.deepEqual(cs.map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
  assert.deepEqual([cs[0].data.readUInt32BE(0), cs[0].data.readUInt32BE(4), cs[0].data[8], cs[0].data[9]], [w, h, 8, 6]);
  assert.deepEqual([...pixels(png)], [...rgba]);
});

test('ICO lists every size and points at PNG data', () => {
  const sizes = [16, 32, 256];
  const ico = encodeIco(sizes.map(size => ({ size, png: encodePng(size, size, drawCritter(size, { tile: true })) })));
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, sizes.length]);
  sizes.forEach((size, k) => {
    const e = 6 + 16 * k;
    assert.equal(ico[e] || 256, size);
    assert.equal(ico[e + 1] || 256, size);
    assert.equal(ico.readUInt16LE(e + 6), 32);
    const len = ico.readUInt32LE(e + 8), off = ico.readUInt32LE(e + 12);
    assert.ok(off + len <= ico.length);
    assert.deepEqual([...ico.subarray(off, off + 8)], SIG);
  });
});

test('app icon tile: transparent corners, dark tile, clay body, eyes as holes', () => {
  for (const size of [16, 24, 32, 48, 256]) {
    const px = drawCritter(size, { tile: true });
    const at = (x, y) => [...px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
    assert.equal(at(0, 0)[3], 0, `corner transparent at ${size}`);
    assert.deepEqual(at(Math.floor(size / 2), 0), [...TILE, 255], `tile top edge at ${size}`);
    const { scale, ox, oy } = layout(size, true);
    assert.ok(12 * scale >= size * 0.6 && 12 * scale <= size, `critter fills 60-100% of the width at ${size}`);
    assert.deepEqual(at(ox, oy + 3 * scale), [...CLAY, 255], `body at ${size}`);            // row 3: all body
    assert.deepEqual(at(ox + 2 * scale, oy + 4 * scale), [...TILE, 255], `eye at ${size}`);  // row 4, col 2: eye
  }
});

test('tray critter: no tile, status color body, dark eyes, edge-to-edge scale', () => {
  const body = [1, 2, 3];
  const px = drawCritter(32, { body });
  const { scale, ox, oy } = layout(32, false);
  assert.equal(scale, 2);
  const at = (x, y) => [...px.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
  assert.equal(at(0, 0)[3], 0);
  assert.deepEqual(at(ox, oy + 3 * scale), [...body, 255]);
  assert.deepEqual(at(ox + 2 * scale, oy + 4 * scale), [...TILE, 255]);
});

test('too small to draw is an error, not a corrupted image', () => {
  assert.throws(() => drawCritter(10), RangeError);
  assert.doesNotThrow(() => drawCritter(12));
});

test('unknown moods fall back to the panic face', () => {
  assert.deepEqual(critterRows('something-new'), critterRows('panic'));
  assert.deepEqual(critterRows(undefined), critterRows('panic'));
  assert.deepEqual(critterRows('plain'), PIX);
});

test('committed assets/icon.ico and icon.png match the code (run npm run icon)', () => {
  const ico = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.ico'));
  assert.equal(ico.readUInt16LE(4), ICON_SIZES.length);
  ICON_SIZES.forEach((size, k) => {
    const e = 6 + 16 * k;
    const png = ico.subarray(ico.readUInt32LE(e + 12), ico.readUInt32LE(e + 12) + ico.readUInt32LE(e + 8));
    assert.deepEqual(pixels(png), Buffer.from(drawCritter(size, { tile: true })), `pixels of the ${size} px entry`);
  });
  const png = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.png'));
  assert.deepEqual(pixels(png), Buffer.from(drawCritter(256, { tile: true })));
});

test('BMP writer: header, bottom-up rows padded to 4 bytes, BGR order', () => {
  const px = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]); // 2x2
  const bmp = encodeBmp(2, 2, px);
  assert.equal(bmp.toString('latin1', 0, 2), 'BM');
  assert.equal(bmp.readUInt32LE(2), bmp.length);
  assert.equal(bmp.readUInt16LE(28), 24);
  assert.equal(bmp.length, 54 + 8 * 2); // 6 bytes per row padded to 8
  assert.deepEqual([...bmp.subarray(54, 60)], [9, 8, 7, 12, 11, 10]); // last row first
  assert.deepEqual([...bmp.subarray(62, 68)], [3, 2, 1, 6, 5, 4]);
});

test('committed assets/installer-sidebar.bmp matches the code (run npm run icon)', () => {
  const bmp = fs.readFileSync(path.join(__dirname, '..', 'assets', 'installer-sidebar.bmp'));
  assert.equal(bmp.readInt32LE(18), 164);
  assert.equal(bmp.readInt32LE(22), 314);
  assert.deepEqual(bmp, buildInstallerSidebar());
});
