// A view made of panels in rows (src/shared/layout.js), with an edit mode:
// drag a panel by its ⠿ grip to another place, drag the gap between two panels
// to change their widths, hide panels and bring them back.
import React, { useEffect, useRef, useState } from 'react';
import { move, resize, hide, show, defaults, W_MIN } from '../shared/layout';

const START_PX = 4;      // pointer travel before a press becomes a drag
const SIDE = 0.3;        // left / right 30 % of a panel = beside it; the middle = a row above / below
const MIN_TILE_PX = 140; // narrowest a panel can be dragged in a resize
const EDGE_PX = 48;      // auto-scroll when the pointer is this close to the top / bottom

// Where a dragged panel would land, and the line that shows it (viewport px).
function dropTarget(root, x, y, dragId) {
  const tiles = [...root.querySelectorAll('[data-tile]')]
    .filter(t => t.dataset.tile !== dragId)
    .map(t => ({ id: t.dataset.tile, row: +t.dataset.row, r: t.getBoundingClientRect() }));
  const box = root.getBoundingClientRect();
  if (!tiles.length) return { target: { end: true }, line: null };
  const hLine = yy => ({ left: box.left, top: yy - 2, width: box.width, height: 4 });
  const vLine = (xx, r) => ({ left: xx - 2, top: r.top, width: 4, height: r.height });
  const hit = tiles.find(t => x >= t.r.left && x <= t.r.right && y >= t.r.top && y <= t.r.bottom);
  if (hit) {
    const fx = (x - hit.r.left) / hit.r.width;
    if (fx < SIDE) return { target: { beside: hit.id, side: 'left' }, line: vLine(hit.r.left - 9, hit.r) };
    if (fx > 1 - SIDE) return { target: { beside: hit.id, side: 'right' }, line: vLine(hit.r.right + 9, hit.r) };
    const rowTiles = tiles.filter(t => t.row === hit.row);
    const top = Math.min(...rowTiles.map(t => t.r.top)), bottom = Math.max(...rowTiles.map(t => t.r.bottom));
    return y < (hit.r.top + hit.r.bottom) / 2
      ? { target: { row: hit.id, where: 'above' }, line: hLine(top - 9) }
      : { target: { row: hit.id, where: 'below' }, line: hLine(bottom + 9) };
  }
  // In a gap: between two panels of a row, or between rows, or past the end.
  const rows = [...new Set(tiles.map(t => t.row))].sort((a, b) => a - b).map(row => {
    const ts = tiles.filter(t => t.row === row);
    return { ts, top: Math.min(...ts.map(t => t.r.top)), bottom: Math.max(...ts.map(t => t.r.bottom)) };
  });
  const inRow = rows.find(r => y >= r.top && y <= r.bottom);
  if (inRow) {
    const near = inRow.ts.reduce((a, b) => (Math.abs((a.r.left + a.r.right) / 2 - x) < Math.abs((b.r.left + b.r.right) / 2 - x) ? a : b));
    const left = x < (near.r.left + near.r.right) / 2;
    return { target: { beside: near.id, side: left ? 'left' : 'right' }, line: vLine(left ? near.r.left - 9 : near.r.right + 9, near.r) };
  }
  if (y < rows[0].top) return { target: { row: rows[0].ts[0].id, where: 'above' }, line: hLine(rows[0].top - 9) };
  const above = rows.filter(r => r.bottom < y).pop();
  return { target: { row: above.ts[0].id, where: 'below' }, line: hLine(above.bottom + 9) };
}

// defs: id -> { name, min (px basis), max? (px), render(ctx) -> element or null }
export function LayoutView({ view, layout, defs, ctx, edit, onChange, onDone }) {
  const root = useRef(null);
  const [preview, setPreview] = useState(null); // layout while a gap is dragged
  const [drag, setDrag] = useState(null);       // { id, name, x, y, line }
  const shown = preview || layout;

  // A running drag (move or resize) can be cancelled from outside: when edit
  // mode ends or the view goes away mid-drag.
  const active = useRef(null);
  useEffect(() => () => { if (active.current) active.current(); }, []);
  useEffect(() => { if (!edit && active.current) active.current(); }, [edit]);

  // Follows one pointer on `el` with pointer capture, so the drag also ends
  // when the button is released outside the window. done(true) on release,
  // done(false) when cancelled or the capture is lost.
  const track = (el, e, onMove, done) => {
    if (active.current) active.current();
    const id = e.pointerId;
    try { el.setPointerCapture(id); } catch { /* not capturable (synthetic event) */ }
    let over = false;
    const finish = ok => {
      if (over) return;
      over = true;
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('lostpointercapture', cancel);
      try { el.releasePointerCapture(id); } catch { /* already released */ }
      active.current = null;
      done(ok);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('lostpointercapture', cancel);
    active.current = () => finish(false);
  };

  // ── moving a panel ──
  const startMove = (e, id) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY;
    let state = null, last = { x: x0, y: y0 }, raf = 0;
    const scroller = root.current.closest('.content');
    const edge = y => { const r = scroller.getBoundingClientRect(); return y < r.top + EDGE_PX ? -1 : y > r.bottom - EDGE_PX ? 1 : 0; };
    // Auto-scroll only once the pointer has been away from the edges: a panel
    // grabbed near the bottom must not start scrolling right away.
    let armed = edge(y0) === 0;
    const update = () => {
      if (!root.current) return;
      const t = dropTarget(root.current, last.x, last.y, id);
      state = { id, name: defs[id] ? defs[id].name : id, x: last.x, y: last.y, line: t.line, target: t.target };
      setDrag(state);
    };
    const scroll = () => { // keep scrolling while the pointer rests near an edge
      if (!state || !root.current) return;
      const dir = edge(last.y);
      if (!dir) armed = true;
      else if (armed) { scroller.scrollTop += dir * 14; update(); }
      raf = requestAnimationFrame(scroll);
    };
    track(e.currentTarget, e, ev => {
      last = { x: ev.clientX, y: ev.clientY };
      if (!state && Math.hypot(last.x - x0, last.y - y0) < START_PX) return;
      if (!state) raf = requestAnimationFrame(scroll);
      update();
    }, ok => {
      cancelAnimationFrame(raf);
      if (ok && state) onChange(move(layout, id, state.target));
      state = null;
      setDrag(null);
    });
  };

  // ── resizing two neighbours ──
  // A panel is min + its weight's share of the row's free space (flex-grow
  // over the min basis), so the weights are worked out from the widths the
  // gap is dragged to: the gap then stays under the pointer.
  const startResize = (e, a, b) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rowEls = [...root.current.querySelectorAll(`[data-row="${e.currentTarget.dataset.row}"][data-tile]`)];
    const width = id => rowEls.find(t => t.dataset.tile === id).getBoundingClientRect().width;
    const row = layout.rows.find(r => r.some(p => p.id === a.id));
    const free = row.reduce((s, p) => s + Math.max(0, width(p.id) - defs[p.id].min), 0);
    const W = row.reduce((s, p) => s + p.w, 0);
    const La = width(a.id), Lb = width(b.id), minA = defs[a.id].min, minB = defs[b.id].min, sum = a.w + b.w;
    const x0 = e.clientX;
    let next = layout;
    track(e.currentTarget, e, ev => {
      let wa;
      if (free > 1) {
        // the space a and b take beyond their minimums, shared as the pointer says
        const spare = (La - minA) + (Lb - minB);
        const sa = Math.min(spare - free * W_MIN / W, Math.max(free * W_MIN / W, La - minA + ev.clientX - x0));
        wa = sum * sa / spare;
      } else { // squeezed below the minimums (narrow window): plain proportions
        const na = Math.min(La + Lb - MIN_TILE_PX, Math.max(MIN_TILE_PX, La + ev.clientX - x0));
        wa = sum * na / (La + Lb);
      }
      next = resize(layout, a.id, wa, b.id, sum - wa);
      setPreview(next);
    }, ok => {
      setPreview(null);
      if (ok && next !== layout) onChange(next);
    });
  };

  useEffect(() => { if (!edit) { setDrag(null); setPreview(null); } }, [edit]);

  const rows = shown.rows.map((row, ri) => {
    const tiles = [];
    row.forEach((p, i) => {
      const def = defs[p.id];
      if (!def) return;
      const el = def.render(ctx);
      if (!el && !edit) return; // nothing to show (e.g. no monthly limits): no empty frame
      if (edit && i > 0) tiles.push(<div key={'g' + p.id} data-row={ri} className="gutter" title="drag to resize" onPointerDown={e => startResize(e, row[i - 1], p)} />);
      tiles.push(
        <div key={p.id} data-tile={p.id} data-row={ri} className={'tile' + (edit ? ' editing' : '') + (drag && drag.id === p.id ? ' dragging' : '')}
          style={{ flex: `${p.w} 1 ${def.min}px`, maxWidth: def.max }}>
          {edit && (
            <div className="tile-bar">
              <span className="grip" title="drag to move" onPointerDown={e => startMove(e, p.id)}>⠿ {def.name}</span>
              <span className="tile-x" title="hide this panel" onClick={() => onChange(hide(layout, p.id))}>✕</span>
            </div>
          )}
          {el || <div className="panel tile-empty"><span className="legend">{def.name}</span>nothing to show right now</div>}
        </div>
      );
    });
    return tiles.length ? <div key={'r' + ri} className={'row' + (edit ? ' editing' : '')}>{tiles}</div> : null;
  });

  return (
    <div ref={root} className="layout">
      {edit && (
        <div className="layout-bar">
          <span><b>editing layout</b> · drag ⠿ to move a panel · drag the gaps to resize · ✕ hides</span>
          {shown.hidden.length > 0 && (
            <span>hidden: {shown.hidden.map(id => (
              <span key={id} className="key chip-add" onClick={() => onChange(show(layout, id))}>[+ {defs[id] ? defs[id].name : id}]</span>
            ))}</span>
          )}
          <span className="key" onClick={() => onChange(defaults(view))}>[reset to default]</span>
          <span className="key" onClick={onDone}>[done]</span>
        </div>
      )}
      {rows}
      {drag && drag.line && <div className="drop-line" style={drag.line} />}
      {drag && <div className="drag-ghost" style={{ left: drag.x + 12, top: drag.y + 12 }}>⠿ {drag.name}</div>}
    </div>
  );
}
