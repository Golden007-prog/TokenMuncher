// Minimal PNG and ICO writers for the app icon (no image libraries needed).
const zlib = require('zlib');
const { drawCritter, TILE } = require('../src/shared/critter');

const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// rgba: width*height*4 bytes (Buffer or Uint8Array). Returns a PNG file (8-bit RGBA, no filtering).
function encodePng(width, height, pixels) {
  const rgba = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

// images: [{ size, png }]. Returns an ICO file with PNG-compressed entries.
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size; // 0 means 256
    e.writeUInt16LE(1, 4);   // color planes
    e.writeUInt16LE(32, 6);  // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map(i => i.png)]);
}

// The app icon files: { ico, png } where png is the 256 px image.
function buildAppIcon() {
  const images = ICON_SIZES.map(size => ({ size, png: encodePng(size, size, drawCritter(size, { tile: true })) }));
  return { ico: encodeIco(images), png: images[images.length - 1].png };
}

// 24-bit BMP (bottom-up rows padded to 4 bytes); alpha is dropped.
function encodeBmp(width, height, pixels) {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + stride * height);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      buf[row + x * 3] = pixels[i + 2]; buf[row + x * 3 + 1] = pixels[i + 1]; buf[row + x * 3 + 2] = pixels[i];
    }
  }
  return buf;
}

// Left image of the installer and uninstaller wizard (NSIS wants 164x314):
// the critter on the app background instead of electron-builder's generic art.
const SIDEBAR = { width: 164, height: 314, critter: 128, top: 72 };
function buildInstallerSidebar() {
  const { width, height, critter, top } = SIDEBAR;
  const px = new Uint8Array(width * height * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = TILE[0]; px[i + 1] = TILE[1]; px[i + 2] = TILE[2]; px[i + 3] = 255; }
  const c = drawCritter(critter);
  const left = Math.round((width - critter) / 2);
  for (let y = 0; y < critter; y++) {
    for (let x = 0; x < critter; x++) {
      const j = (y * critter + x) * 4;
      if (!c[j + 3]) continue;
      px.set(c.subarray(j, j + 4), ((top + y) * width + left + x) * 4);
    }
  }
  return encodeBmp(width, height, px);
}

module.exports = { crc32, encodePng, encodeIco, encodeBmp, buildAppIcon, buildInstallerSidebar, ICON_SIZES };
