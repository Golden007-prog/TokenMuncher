// The mini widget: a small frameless always-on-top window with the critter
// and the most-used limits. It loads the same page as the dashboard with
// ?view=mini. Dragging is done by the page (mouse events -> setPosition),
// because a CSS drag region would swallow double-click and right-click.
const { BrowserWindow, Menu, ipcMain, screen } = require('electron');

const WIDTH = 340;
const OPACITIES = [1, 0.85, 0.7];

class MiniWidget {
  // opts: { settings, save(), preload, indexFile, openDashboard(), onChange(), onShow() }
  constructor(opts) {
    this.o = opts;
    this.win = null;
    this.dragFrom = null;
    this.quitting = false;
    const s = opts.settings;
    s.mini = { on: false, x: null, y: null, opacity: 1, ...(s.mini || {}) };

    ipcMain.on('mini', (e, cmd, arg) => {
      if (cmd === 'toggle') this.toggle();
      if (!this.win || e.sender !== this.win.webContents) return;
      if (cmd === 'hide') this.setOn(false);
      else if (cmd === 'dashboard') this.o.openDashboard();
      else if (cmd === 'size') this.fitHeight(arg);
      else if (cmd === 'menu') this.popupMenu();
      else if (cmd === 'drag-start') this.dragFrom = { mouse: screen.getCursorScreenPoint(), win: this.win.getPosition() };
      else if (cmd === 'drag-move' && this.dragFrom) {
        const p = screen.getCursorScreenPoint();
        this.win.setPosition(this.dragFrom.win[0] + p.x - this.dragFrom.mouse.x, this.dragFrom.win[1] + p.y - this.dragFrom.mouse.y);
      } else if (cmd === 'drag-end' && this.dragFrom) {
        const [x, y] = this.win.getPosition();
        const moved = x !== this.dragFrom.win[0] || y !== this.dragFrom.win[1];
        this.dragFrom = null;
        if (moved) this.rememberPosition(); // a plain click doesn't rewrite settings
      }
    });
  }

  get settings() { return this.o.settings.mini; }
  isOn() { return !!this.settings.on; }
  isVisible() { return !!(this.win && !this.win.isDestroyed() && this.win.isVisible()); }

  // Saved position if it is still on a connected screen, else the bottom-right corner.
  position(height) {
    const { x, y } = this.settings;
    const fits = x != null && screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return x >= a.x - 20 && x + WIDTH <= a.x + a.width + 20 && y >= a.y - 10 && y + 40 <= a.y + a.height;
    });
    if (fits) return { x, y };
    const a = screen.getPrimaryDisplay().workArea;
    return { x: a.x + a.width - WIDTH - 16, y: a.y + a.height - height - 16 };
  }

  create() {
    const height = 150;
    this.win = new BrowserWindow({
      width: WIDTH, height, ...this.position(height),
      frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false, backgroundColor: this.o.background(), title: 'TokenMuncher mini',
      webPreferences: { preload: this.o.preload, contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    this.win.setAlwaysOnTop(true, 'floating');
    this.win.setOpacity(this.settings.opacity || 1);
    this.win.loadFile(this.o.indexFile, { query: { view: 'mini', ...this.o.look() } });
    this.win.once('ready-to-show', () => { if (this.isOn()) this.showNow(); });
    // Alt+F4 on the widget turns it off like ✕ (the window is kept for later).
    this.win.on('close', e => {
      if (this.quitting) return;
      e.preventDefault();
      this.setOn(false);
    });
    this.win.on('query-session-end', () => { this.quitting = true; });
    this.win.on('closed', () => { this.win = null; });
  }

  showNow() {
    if (!this.win) return this.create(); // shows itself when ready
    this.win.showInactive(); // don't steal focus from what the user is doing
    this.o.onShow();
  }

  setOn(on) {
    this.settings.on = !!on;
    this.o.save();
    if (on) this.showNow();
    else if (this.win) { this.rememberPosition(); this.win.hide(); }
    this.o.onChange();
  }

  toggle() { this.setOn(!this.isOn()); }

  // Called at startup.
  init() { if (this.isOn()) this.create(); }

  fitHeight(h) {
    if (!this.win || !(h > 0)) return;
    const height = Math.min(400, Math.ceil(h));
    const [w, cur] = this.win.getContentSize();
    if (cur === height) return;
    const [x, y] = this.win.getPosition();
    const a = screen.getDisplayNearestPoint({ x, y }).workArea;
    // Keep the widget inside the screen when it grows near the bottom edge.
    const ny = Math.min(y, a.y + a.height - height);
    this.win.setContentSize(w, height);
    if (ny !== y) this.win.setPosition(x, ny);
  }

  rememberPosition() {
    if (!this.win || this.win.isDestroyed()) return;
    const [x, y] = this.win.getPosition();
    Object.assign(this.settings, { x, y });
    this.o.save();
  }

  setOpacity(v) {
    this.settings.opacity = v;
    if (this.win) this.win.setOpacity(v);
    this.o.save();
  }

  popupMenu() {
    const op = this.settings.opacity || 1;
    Menu.buildFromTemplate([
      ...OPACITIES.map(v => ({ label: `Opacity ${Math.round(v * 100)}%`, type: 'radio', checked: Math.abs(op - v) < 0.01, click: () => this.setOpacity(v) })),
      { type: 'separator' },
      { label: 'Open dashboard', click: () => this.o.openDashboard() },
      { label: 'Hide widget', click: () => this.setOn(false) }
    ]).popup({ window: this.win });
  }

  send(channel, data) {
    if (this.isVisible()) this.win.webContents.send(channel, data);
  }

  // App is quitting: save the position and let the window go.
  destroy() {
    this.quitting = true;
    if (this.win && !this.win.isDestroyed()) { this.rememberPosition(); this.win.destroy(); }
  }
}

module.exports = { MiniWidget };
