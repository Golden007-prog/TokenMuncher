// Incremental reader for directories of append-only JSONL files.
// Calls onLine(line, filePath) for every complete new line.
const fsp = require('fs').promises;
const path = require('path');

const MARK_BYTES = 32; // bytes before the read position, to recognize the same file after a restart

class JsonlTail {
  constructor(roots, onLine, getCutoff) {
    this.roots = roots;
    this.onLine = onLine;
    this.getCutoff = getCutoff;
    this.files = new Map(); // path -> { offset, mtimeMs, rest, mark?, verify? }
    this.busy = false;
    this.lastFullScan = 0;
    this.changes = 0; // bumped whenever a file offset moves (for the on-disk cache)
    this.linesRead = 0; // since start (diagnostics)
  }

  // Read positions for the on-disk cache. A trailing partial line is not kept
  // (its bytes are re-read next time). Files older than the cutoff are left
  // out: a scan skips them anyway.
  exportState() {
    const cutoff = this.getCutoff();
    const out = [];
    for (const [p, f] of this.files) {
      if (f.mtimeMs < cutoff) continue;
      out.push([p, { offset: f.offset - (f.rest ? f.rest.length : 0), mtimeMs: f.mtimeMs, ino: f.ino || 0, mark: f.mark || null }]);
    }
    return out;
  }

  // Restored positions are checked against the file on the next scan (mark).
  importState(list) {
    this.files = new Map((list || [])
      .filter(e => Array.isArray(e) && e[1] && e[1].offset >= 0)
      .map(([p, f]) => [p, { offset: f.offset, mtimeMs: f.mtimeMs || 0, ino: f.ino || 0, rest: null, mark: f.mark || null, verify: true }]));
  }

  async walk(dir, out) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await this.walk(p, out);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
    return out;
  }

  // full = also look for new files; otherwise only re-check recently modified ones
  async scan(full) {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      let list;
      if (full || now - this.lastFullScan > 10e3) {
        list = [];
        for (const r of this.roots) await this.walk(r, list);
        this.lastFullScan = now;
        const present = new Set(list);
        for (const p of this.files.keys()) if (!present.has(p)) { this.files.delete(p); this.changes++; } // deleted logs
      } else {
        list = [...this.files.entries()].filter(([, f]) => now - f.mtimeMs < 30 * 60e3).map(([p]) => p);
      }
      const cutoff = this.getCutoff();
      for (const p of list) {
        let st;
        try { st = await fsp.stat(p); } catch { continue; }
        let f = this.files.get(p);
        if (!f) {
          f = { offset: st.mtimeMs < cutoff ? st.size : 0, mtimeMs: 0, rest: null };
          this.files.set(p, f);
        }
        // A restored position must belong to the same file: same file id (a replaced
        // file gets a new one) and the same bytes just before the position.
        if (f.verify) {
          f.verify = false;
          const replaced = f.ino && st.ino && f.ino !== st.ino;
          if (replaced || !(await this.sameFile(p, f, st.size))) this.restart(f);
        }
        f.ino = st.ino;
        if (st.size < f.offset) this.restart(f); // rewritten or truncated
        f.mtimeMs = st.mtimeMs;
        if (st.size > f.offset) await this.readFrom(p, f, st.size);
      }
    } finally {
      this.busy = false;
    }
  }

  restart(f) {
    f.offset = 0; f.rest = null; f.mark = null;
    this.changes++;
  }

  // The bytes just before a restored position must still be the ones we read;
  // otherwise the file was replaced while the app was closed.
  async sameFile(p, f, size) {
    if (!f.mark) return true;
    const mark = Buffer.from(f.mark, 'base64');
    if (f.offset > size || f.offset < mark.length) return false;
    let fh;
    try {
      fh = await fsp.open(p, 'r');
      const buf = Buffer.alloc(mark.length);
      await fh.read(buf, 0, mark.length, f.offset - mark.length);
      return buf.equals(mark);
    } catch { return false; } finally { if (fh) await fh.close(); }
  }

  async readFrom(p, f, size) {
    const CHUNK = 8 * 1024 * 1024;
    let fh;
    try { fh = await fsp.open(p, 'r'); } catch { return; }
    try {
      while (f.offset < size) {
        const len = Math.min(CHUNK, size - f.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, f.offset);
        if (!bytesRead) break;
        f.offset += bytesRead;
        this.changes++;
        let data = buf.subarray(0, bytesRead);
        if (f.rest) data = Buffer.concat([f.rest, data]);
        const nl = data.lastIndexOf(10);
        if (nl < 0) { f.rest = data; continue; }
        f.rest = nl + 1 < data.length ? Buffer.from(data.subarray(nl + 1)) : null;
        // Remember the last bytes up to the last complete line (where a restart resumes).
        f.mark = nl + 1 >= MARK_BYTES ? data.subarray(nl + 1 - MARK_BYTES, nl + 1).toString('base64') : null;
        for (const line of data.toString('utf8', 0, nl).split('\n')) {
          if (line.length > 20) { this.linesRead++; this.onLine(line, p); }
        }
      }
    } finally {
      await fh.close();
    }
  }
}

module.exports = { JsonlTail };
