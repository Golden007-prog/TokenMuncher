// Every relative require() in the main-process and shared code points at a
// file that exists. Most of src/main needs Electron and is never loaded by
// the other tests, so a wrong path would otherwise only show when the app
// starts (v0.9.1 crashed on '../shared/clock' in sources/claude.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src/main', 'src/shared', 'scripts'];

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : /\.(c?js|mjs)$/.test(e.name) ? [p] : [];
  });
}

const resolves = (from, spec) => {
  const base = path.resolve(path.dirname(from), spec);
  return [base, base + '.js', base + '.json', path.join(base, 'index.js')].some(p => fs.existsSync(p) && fs.statSync(p).isFile());
};

test('relative requires and imports resolve to existing files', () => {
  const files = DIRS.flatMap(d => jsFiles(path.join(ROOT, d)));
  assert.ok(files.length > 20, 'found the source files');
  const broken = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:require\(|from\s+|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      if (!resolves(f, m[1])) broken.push(`${path.relative(ROOT, f)}: ${m[1]}`);
    }
  }
  assert.deepEqual(broken, []);
});
