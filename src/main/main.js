'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, screen, nativeTheme, clipboard, session } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { Store } = require('./store');
const { detectTools } = require('./ffmpeg-tools');
const { probe, keyframeNear } = require('./probe');
const { plan, buildStreamArgs, streamMime, describeVideo } = require('./planner');
const { MediaServer } = require('./media-server');
const { buildMenu } = require('./menu');
const formats = require('./formats');
const { RemoteServer } = require('./remote-server');
const { StreamServer } = require('./stream-server');
const { OpenSubtitles, cleanTitle } = require('./opensubtitles');
const { randomPin, lanAddresses } = require('./net-security');
const { Converter, PROFILES } = require('./convert');
const disc = require('./disc');

app.setName('AAPlayer');
if (process.platform === 'win32') app.setAppUserModelId('com.aaplayer.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/* ---------- logging (Tools > Messages) ---------- */
const logLines = [];
function log(module, message) {
  const line = `${new Date().toISOString().slice(11, 23)} ${module}: ${message}`;
  logLines.push(line);
  if (logLines.length > 3000) logLines.splice(0, logLines.length - 3000);
  if (!app.isPackaged) console.log(line);
}

let store;
let tools = null;
let toolsPromise = null;
let server;
let win = null;
let fullscreenInterface = false; // View > Fullscreen Interface: fullscreen but keep menus and controls
let recorder = null;            // Playback > Record: { child, file }
const pendingInputs = [];
const probeCache = new Map();

function ensureTools() {
  if (!toolsPromise) {
    toolsPromise = detectTools(store.settings).then((t) => {
      tools = t;
      log('main', `ffmpeg: ${t.ffmpeg} (${t.ffmpegVersion})`);
      log('main', `ffprobe: ${t.ffprobe} (${t.ffprobeVersion})`);
      log('main', `usable H.264 encoders: ${t.encoders.join(', ') || 'none'}; zscale=${t.hasZscale} tonemap=${t.hasTonemap}`);
      return t;
    }, (e) => { toolsPromise = null; log('error', e.message); throw e; });
  }
  return toolsPromise;
}

/* ---------- command line / second instance ---------- */
function inputsFromArgv(argv, cwd) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  return args.filter((a) => a && !a.startsWith('-') && a !== '.')
    .map((a) => (/^[a-z][a-z0-9+.-]+:\/\//i.test(a) ? a : path.resolve(cwd || process.cwd(), a)))
    .filter((a) => /^[a-z][a-z0-9+.-]+:\/\//i.test(a) || fs.existsSync(a));
}

async function expandInputs(inputs) {
  const out = [];
  for (const input of inputs) {
    let stat = null;
    try { stat = await fsp.stat(input); } catch { /* URL or missing */ }
    if (stat && stat.isDirectory()) out.push(...(await scanDir(input)));
    else out.push(input);
  }
  return out;
}

async function scanDir(dir, depth = 0) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) files.push(...(await scanDir(full, depth + 1)));
    else if (e.isFile() && formats.MEDIA.has(path.extname(e.name).slice(1).toLowerCase())) files.push(full);
  }
  return files;
}

function sendOpen(inputs, play = true) {
  if (!inputs.length) return;
  if (win && !win.webContents.isLoading()) win.webContents.send('cmd', 'open-files', { inputs, play });
  else pendingInputs.push(...inputs);
}

app.on('second-instance', async (_e, argv, cwd) => {
  sendOpen(await expandInputs(inputsFromArgv(argv, cwd)));
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

/* ---------- window ---------- */
function send(name, arg) { if (win) win.webContents.send('cmd', name, arg); }

let menuState = {};
const menuActions = {
  openFiles: async (multi) => {
    const r = await dialog.showOpenDialog(win, {
      title: multi ? 'Open Multiple Files' : 'Open File',
      properties: ['openFile', ...(multi ? ['multiSelections'] : [])],
      filters: [
        { name: 'Media files', extensions: [...formats.MEDIA] },
        { name: 'Video files', extensions: formats.VIDEO },
        { name: 'Audio files', extensions: formats.AUDIO },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!r.canceled) sendOpen(r.filePaths, true);
  },
  openFolder: async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open Folder', properties: ['openDirectory'] });
    if (!r.canceled) sendOpen(await scanDir(r.filePaths[0]), true);
  },
  openSubtitle: async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open Subtitle', properties: ['openFile'],
      filters: [{ name: 'Subtitles', extensions: formats.SUBTITLE }, { name: 'All files', extensions: ['*'] }],
    });
    if (!r.canceled) send('add-subtitle', r.filePaths[0]);
  },
  clearRecent: () => { store.clearRecent(); refreshMenu(); },
  openClipboard: async () => {
    // Electron may return the clipboard text synchronously or as a promise.
    const text = String((await clipboard.readText()) || '').trim().replace(/^"(.*)"$/, '$1');
    const isUrl = /^[a-z][a-z0-9+.-]+:\/\//i.test(text);
    if (text && !/[\r\n]/.test(text) && (isUrl || fs.existsSync(text))) sendOpen([isUrl ? text : path.resolve(text)], true);
    else send('osd', 'The clipboard does not contain a file path or URL');
  },
  toggleOnTop: () => {
    const on = !win.isAlwaysOnTop();
    win.setAlwaysOnTop(on);
    store.setSettings({ alwaysOnTop: on });
    refreshMenu();
  },
  devtools: () => win.webContents.toggleDevTools(),
  quit: () => app.quit(),
};

function refreshMenu() {
  const st = store.settings;
  const state = {
    saveRecent: st.saveRecent, resumePlayback: st.resumePlayback, deinterlace: st.deinterlace, deinterlaceMode: st.deinterlaceMode,
    fitWindow: st.fitWindow, playlistDocked: st.playlistDocked, statusBar: st.statusBar, advancedControls: st.advancedControls,
    visualization: st.visualization, audioDevice: st.audioDevice, decodeMode: st.decodeMode,
    ...menuState, recording: !!recorder, recent: store.data.recent,
    alwaysOnTop: win ? win.isAlwaysOnTop() : false, fullscreen: win ? win.isFullScreen() : false,
    fullscreenInterface: fullscreenInterface && win && win.isFullScreen(),
  };
  const menu = buildMenu(state, send, menuActions);
  if (win) win.setMenu(menu);
  return menu;
}

function createWindow() {
  const saved = store.data.windowBounds;
  const visible = saved && screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return saved.x < a.x + a.width && saved.x + saved.width > a.x && saved.y < a.y + a.height && saved.y + saved.height > a.y;
  });
  win = new BrowserWindow({
    width: 1100, height: 680, minWidth: 420, minHeight: 300,
    ...(visible ? saved : {}),
    backgroundColor: '#0b0b0f',
    title: 'AAPlayer',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });
  if (store.settings.alwaysOnTop) win.setAlwaysOnTop(true);
  refreshMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  const saveBounds = () => { if (!win.isFullScreen() && !win.isMaximized() && !win.isMinimized()) store.data.windowBounds = win.getBounds(); };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('enter-full-screen', () => { win.setMenuBarVisibility(fullscreenInterface); send('fullscreen-changed', true); refreshMenu(); });
  win.on('leave-full-screen', () => {
    fullscreenInterface = false;
    restoreMenuBar();
    send('fullscreen-changed', false);
    refreshMenu();
  });
  // On Windows the window can finish restoring after 'leave-full-screen'; make sure the menu bar comes back.
  const restoreMenuBar = () => {
    win.setAutoHideMenuBar(false);
    win.setMenuBarVisibility(true);
    for (const ms of [50, 250]) setTimeout(() => { if (win && !win.isFullScreen()) win.setMenuBarVisibility(true); }, ms);
  };
  win.on('resize', () => { if (!win.isFullScreen() && !win.isMenuBarVisible()) win.setMenuBarVisibility(true); });
  win.on('closed', () => { server.closeOwner(1); win = null; });

  // Never navigate away from the player or open new windows (e.g. a dropped link).
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ---------- media ---------- */
async function getInfo(input, force) {
  if (!force && probeCache.has(input)) return probeCache.get(input);
  const t = await ensureTools();
  const info = await probe(t.ffprobe, input);
  probeCache.set(input, info);
  if (probeCache.size > 50) probeCache.delete(probeCache.keys().next().value);
  log('probe', `${info.name}: ${info.formatName}, ${info.duration.toFixed(1)}s, ` +
    info.video.map((v) => `video#${v.index} ${describeVideo(v)} ${v.pixFmt} ${v.width}x${v.height}`).concat(
      info.audio.map((a) => `audio#${a.index} ${a.codec} ${a.channels}ch`)).join('; '));
  return info;
}

async function findExternalSubs(input) {
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(input)) return [];
  const dir = path.dirname(input);
  const base = path.basename(input, path.extname(input)).toLowerCase();
  const entries = await fsp.readdir(dir).catch(() => []);
  const subs = entries.filter((f) => {
    const ext = path.extname(f).slice(1).toLowerCase();
    return formats.SUBTITLE_AUTOLOAD.has(ext) && f.toLowerCase().startsWith(base);
  }).map((f) => path.join(dir, f));
  // Also look in a "Subs" folder next to the file (common for releases).
  for (const sd of ['Subs', 'subs', 'Subtitles']) {
    const sub = path.join(dir, sd);
    const inner = await fsp.readdir(sub).catch(() => []);
    for (const f of inner) {
      if (formats.SUBTITLE_AUTOLOAD.has(path.extname(f).slice(1).toLowerCase())) subs.push(path.join(sub, f));
    }
  }
  return subs;
}

ipcMain.handle('media:prepare', async (_e, { input, opts = {}, caps }) => {
  const t = await ensureTools();
  const info = await getInfo(input, opts.reprobe);
  const mode = opts.mode || store.settings.decodeMode;
  const p = plan(info, caps, { mode, videoIndex: opts.videoIndex, audioIndex: opts.audioIndex, burnSubtitleIndex: opts.burnSubtitleIndex,
    deinterlace: store.settings.deinterlace, deinterlaceMode: store.settings.deinterlaceMode });
  let start = Math.max(0, Math.min(opts.start || 0, Math.max(0, info.duration - 1)));
  let encoder = null;
  let session;
  const video = info.video.find((v) => v.index === p.videoIndex);

  if (p.kind === 'direct') {
    session = server.createSession(1, { kind: 'direct', input, videoIndex: p.videoIndex, isUrlStream: info.isUrlStream });
  } else {
    if (start > 0 && p.video.action === 'copy') start = await keyframeNear(t.ffprobe, input, p.videoIndex, start, info.startTime);
    const built = buildStreamArgs(p, info, start, {
      ...t, preferredEncoder: store.settings.encoder, quality: store.settings.quality, maxHeight: opts.maxHeight || store.settings.maxHeight,
    });
    encoder = built.encoder;
    session = server.createSession(1, {
      kind: p.kind, input, args: built.args, videoIndex: p.videoIndex, audioOnly: !video, isUrlStream: info.isUrlStream,
    });
  }
  log('plan', `${info.name} [${mode}] -> ${p.kind}${encoder ? ` via ${encoder}` : ''} @${start.toFixed(2)}s: ${p.reasons.join(' | ')}`);
  return {
    info, plan: p, url: session.url, mime: p.kind === 'direct' ? null : streamMime(p, info), thumbUrl: video && !video.attachedPic ? session.thumbUrl : null,
    offset: p.kind === 'direct' ? 0 : start, encoder, mode,
    externalSubs: opts.start ? undefined : await findExternalSubs(input),
    resume: store.settings.resumePlayback ? store.getResume(input) : 0,
  };
});

ipcMain.handle('media:stop', () => { server.closeOwner(1); });

/** Converts an embedded or external subtitle to WebVTT text with ffmpeg. */
ipcMain.handle('media:subtitle', async (_e, { input, streamIndex, file }) => {
  const t = await ensureTools();
  const attempt = (charenc) => new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
    if (charenc) args.push('-sub_charenc', charenc);
    if (file) args.push('-i', file, '-map', '0:s:0');
    else args.push('-i', input, '-map', `0:${streamIndex}`);
    args.push('-f', 'webvtt', 'pipe:1');
    const child = spawn(t.ffmpeg, args, { windowsHide: true });
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
  });
  try {
    return await attempt(null);
  } catch (e) {
    if (!file) throw e;
    log('subs', `retrying ${path.basename(file)} as Windows-1252: ${e.message}`);
    return attempt('CP1252');
  }
});

ipcMain.handle('media:expand', (_e, inputs) => expandInputs(inputs));

ipcMain.handle('media:snapshot', async (_e, { dataUrl, name, time }) => {
  const dir = path.join(app.getPath('pictures'), 'AAPlayer');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date(Math.max(0, time) * 1000).toISOString().slice(11, 19).replace(/:/g, '-');
  const safe = (name || 'snapshot').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  const file = path.join(dir, `${safe}_${stamp}_${Date.now() % 100000}.png`);
  await fsp.writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  log('main', `snapshot saved: ${file}`);
  return file;
});

ipcMain.handle('playlist:save', async (_e, items) => {
  const r = await dialog.showSaveDialog(win, { title: 'Save Playlist', defaultPath: 'playlist.m3u8',
    filters: [{ name: 'M3U playlist', extensions: ['m3u8', 'm3u'] }] });
  if (r.canceled) return null;
  const body = ['#EXTM3U', ...items.flatMap((it) => [`#EXTINF:${Math.round(it.duration || -1)},${it.title || ''}`, it.input])].join('\n');
  await fsp.writeFile(r.filePath, body + '\n', 'utf8');
  return r.filePath;
});

ipcMain.handle('app:init', async () => {
  const startup = [...pendingInputs, ...(await expandInputs(inputsFromArgv(process.argv)))];
  pendingInputs.length = 0;
  let toolInfo = null;
  try { const t = await ensureTools(); toolInfo = { ffmpegVersion: t.ffmpegVersion, encoders: t.encoders }; } catch (e) { toolInfo = { error: e.message }; }
  return { settings: store.settings, startup, tools: toolInfo, version: app.getVersion(), recent: store.data.recent,
    electron: process.versions.electron, chrome: process.versions.chrome };
});

ipcMain.handle('settings:set', (_e, patch) => {
  const allowed = ['decodeMode', 'encoder', 'quality', 'maxHeight', 'resumePlayback', 'volume', 'showRemaining', 'subtitleScale', 'ffmpegPath', 'ffprobePath',
    'saveRecent', 'deinterlace', 'deinterlaceMode', 'fitWindow', 'playlistDocked', 'statusBar', 'advancedControls', 'fullscreenControls',
    'visualization', 'audioDevice', 'eq', 'toolbar', 'tenBitPresenter'];
  const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
  const before = { ffmpegPath: store.settings.ffmpegPath, ffprobePath: store.settings.ffprobePath };
  const s = store.setSettings(clean);
  if (s.ffmpegPath !== before.ffmpegPath || s.ffprobePath !== before.ffprobePath) { toolsPromise = null; tools = null; }
  if ('decodeMode' in clean) menuState.decodeMode = s.decodeMode;
  refreshMenu();
  return s;
});

ipcMain.handle('tools:info', async () => {
  try { return await ensureTools(); } catch (e) { return { error: e.message }; }
});

ipcMain.on('recent:add', (_e, input) => { store.addRecent(input); refreshMenu(); });
ipcMain.on('resume:set', (_e, { input, time, duration }) => store.setResume(input, time, duration));
ipcMain.on('menu:state', (_e, state) => { menuState = state || {}; refreshMenu(); });
ipcMain.on('log', (_e, { module, message }) => log(module || 'ui', String(message)));
ipcMain.handle('log:get', () => logLines.slice());
ipcMain.on('win:title', (_e, title) => { if (win) win.setTitle(title ? `${title} - AAPlayer` : 'AAPlayer'); });
ipcMain.handle('win:fullscreen', (_e, value, withInterface) => {
  if (!win) return false;
  const target = value === undefined ? !win.isFullScreen() : !!value;
  fullscreenInterface = target && !!withInterface;
  // Switching between plain fullscreen and "Fullscreen Interface" while already fullscreen.
  if (target && win.isFullScreen()) win.setMenuBarVisibility(fullscreenInterface);
  win.setFullScreen(target);
  return target;
});
ipcMain.on('win:menu-popup', () => {
  const menu = buildMenu({ ...menuState, recent: store.data.recent, alwaysOnTop: win.isAlwaysOnTop(), fullscreen: win.isFullScreen() }, send, menuActions);
  menu.popup({ window: win });
});
ipcMain.on('win:resize-to-video', (_e, { width, height }) => {
  if (!win || win.isFullScreen() || win.isMaximized()) return;
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const scale = Math.min(1, (area.width * 0.8) / width, (area.height * 0.8) / height);
  win.setContentSize(Math.max(420, Math.round(width * scale)), Math.max(300, Math.round(height * scale)));
});
ipcMain.on('menu:action', (_e, name, arg) => {
  const allowed = ['openFiles', 'openFolder', 'openSubtitle', 'openClipboard', 'quit'];
  if (!allowed.includes(name)) return;
  Promise.resolve().then(() => menuActions[name](arg)).catch((e) => log('error', `${name} failed: ${e.message}`));
});
/*
 * Playback > Record.
 *  - Files: Record marks the current position; Stop copies exactly the range
 *    [start, stop] into an MKV (no re-encode).
 *  - Network streams: captured live (stream copy) until Stop.
 */
function recordFile(title) {
  const dir = path.join(app.getPath('videos'), 'AAPlayer');
  const safe = String(title || 'recording').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  return path.join(dir, `${safe}_rec_${stamp}.mkv`);
}

function runFfmpeg(t, args, onChild) {
  return new Promise((resolve, reject) => {
    const child = spawn(t.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited ${code}`))));
    if (onChild) onChild(child);
  });
}

ipcMain.handle('record:toggle', async (_e, { input, time, title }) => {
  const t = await ensureTools();
  if (recorder) {
    const rec = recorder;
    recorder = null;
    refreshMenu();
    if (rec.child) {
      try { rec.child.stdin.write('q'); } catch { rec.child.kill(); }
      await rec.done.catch(() => {});
    } else {
      const from = Math.min(rec.start, time);
      const dur = Math.abs(time - rec.start);
      if (dur < 0.5) throw new Error('Recording too short');
      await fsp.mkdir(path.dirname(rec.file), { recursive: true });
      await runFfmpeg(t, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', from.toFixed(3), '-i', rec.input, '-t', dur.toFixed(3),
        '-map', '0:v?', '-map', '0:a?', '-map', '0:s?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', rec.file]);
    }
    log('record', `saved ${rec.file}`);
    return { recording: false, file: rec.file };
  }
  const file = recordFile(title);
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(input)) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const rec = { input, file, child: null, done: null };
    rec.done = runFfmpeg(t, ['-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', file],
      (child) => { rec.child = child; });
    rec.done.catch((e) => log('error', `record failed: ${e.message}`)).finally(() => {
      if (recorder === rec) { recorder = null; refreshMenu(); send('record-stopped', file); }
    });
    recorder = rec;
  } else {
    recorder = { input, file, start: time, child: null };
  }
  log('record', `recording ${input} from ${time.toFixed(2)}s -> ${file}`);
  refreshMenu();
  return { recording: true, file };
});

/* Video > Set as Wallpaper: sets the current frame as the Windows desktop background. */
ipcMain.handle('wallpaper:set', async (_e, dataUrl) => {
  if (process.platform !== 'win32') throw new Error('Only supported on Windows');
  const file = path.join(app.getPath('userData'), 'wallpaper.png');
  await fsp.writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  const ps = `Add-Type 'using System.Runtime.InteropServices; public class W { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SystemParametersInfo(int a, int b, string c, int d); }'; if (-not [W]::SystemParametersInfo(20, 0, $env:AAP_WALLPAPER, 3)) { exit 1 }`;
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, env: { ...process.env, AAP_WALLPAPER: file } });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Windows refused to change the wallpaper'))));
  });
  return file;
});

ipcMain.on('shell:show', (_e, file) => shell.showItemInFolder(file));

/* ---------- View > Add Interface > Web Remote ---------- */
let remote;
let remoteStatus = {};
let remoteError = '';
ipcMain.on('remote:status', (_e, status) => { remoteStatus = status || {}; });

function remoteState() {
  const r = store.settings.remote;
  return { enabled: r.enabled, allowLan: r.allowLan, port: r.port, pin: r.pin, running: remote.running,
    urls: remote.running ? remote.urls() : [], error: remoteError, lan: lanAddresses() };
}

async function applyRemote() {
  const r = store.settings.remote;
  remoteError = '';
  try {
    if (r.enabled) {
      if (!/^\d{6}$/.test(r.pin)) store.setSettings({ remote: { ...r, pin: randomPin() } });
      await remote.start(store.settings.remote);
    } else await remote.stop();
  } catch (e) {
    remoteError = e.code === 'EADDRINUSE' ? `Port ${r.port} is already in use` : e.message;
    log('remote', `failed: ${remoteError}`);
  }
  send('remote-active', remote.running);
  return remoteState();
}

ipcMain.handle('remote:get', () => remoteState());
ipcMain.handle('remote:set', async (_e, patch = {}) => {
  const r = { ...store.settings.remote };
  if ('enabled' in patch) r.enabled = !!patch.enabled;
  if ('allowLan' in patch) r.allowLan = !!patch.allowLan;
  if ('port' in patch) { const p = Number(patch.port); if (p >= 1024 && p <= 65535) r.port = p; }
  if (patch.newPin) r.pin = randomPin();
  store.setSettings({ remote: r });
  return applyRemote();
});
ipcMain.on('remote:open', () => {
  if (remote.running) shell.openExternal(`http://localhost:${store.settings.remote.port}/`);
});

/* ---------- Tools > VLM Configuration (stream to the home network) ---------- */
let streams;
function vlmPin() {
  const v = store.settings.vlm;
  if (!/^\d{6}$/.test(v.pin)) store.setSettings({ vlm: { ...v, pin: randomPin() } });
  return store.settings.vlm.pin;
}
ipcMain.handle('vlm:get', () => ({ pin: vlmPin(), port: store.settings.vlm.port, streams: streams.list(), lan: lanAddresses() }));
ipcMain.handle('vlm:add', async (_e, { input, name, mode }) => {
  try {
    await streams.add({ input, name, mode: mode === 'original' ? 'original' : 'compatible', port: store.settings.vlm.port, pin: vlmPin() });
  } catch (e) {
    throw new Error(e.code === 'EADDRINUSE' ? `Port ${store.settings.vlm.port} is already in use` : e.message);
  }
  return { pin: vlmPin(), streams: streams.list() };
});
ipcMain.handle('vlm:remove', async (_e, id) => { await streams.remove(id); return { pin: vlmPin(), streams: streams.list() }; });
ipcMain.handle('vlm:new-pin', () => {
  store.setSettings({ vlm: { ...store.settings.vlm, pin: randomPin() } });
  streams.setPin(store.settings.vlm.pin);
  return { pin: store.settings.vlm.pin, streams: streams.list() };
});
ipcMain.handle('dialog:pick-media', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose media to stream', properties: ['openFile'],
    filters: [{ name: 'Media files', extensions: [...formats.MEDIA] }, { name: 'All files', extensions: ['*'] }] });
  return r.canceled ? null : r.filePaths[0];
});

/* ---------- View > VLsub (OpenSubtitles) ---------- */
let vlsub;
const isUrlInput = (s) => /^[a-z][a-z0-9+.-]+:\/\//i.test(String(s || ''));
ipcMain.handle('vlsub:suggest', (_e, input) => cleanTitle(isUrlInput(input) ? decodeURIComponent(String(input).split('/').pop()) : path.basename(String(input || ''))));
ipcMain.handle('vlsub:search', (_e, q) => vlsub.search(store.settings.opensubtitles.apiKey, {
  file: q.useHash && q.input && !isUrlInput(q.input) ? q.input : null,
  query: q.query, languages: q.languages, useHash: !!q.useHash,
}));
ipcMain.handle('vlsub:download', (_e, { fileId, input, language }) => vlsub.download(store.settings.opensubtitles.apiKey, {
  fileId, video: input, language, fallbackDir: path.join(app.getPath('userData'), 'subtitles'),
}));
ipcMain.handle('vlsub:login', async (_e, { username, password }) => {
  const r = await vlsub.login(store.settings.opensubtitles.apiKey, username, password);
  store.setSettings({ opensubtitles: { ...store.settings.opensubtitles, username } });
  return r;
});
ipcMain.handle('vlsub:logout', () => { vlsub.logout(); return true; });
ipcMain.handle('vlsub:get', () => {
  const o = store.settings.opensubtitles;
  return { apiKey: o.apiKey, username: o.username, language: o.language, loggedIn: !!vlsub.token };
});
ipcMain.handle('vlsub:config', (_e, patch = {}) => {
  const o = { ...store.settings.opensubtitles };
  if (typeof patch.apiKey === 'string') o.apiKey = patch.apiKey.trim();
  if (typeof patch.language === 'string') o.language = patch.language;
  store.setSettings({ opensubtitles: o });
  return { apiKey: o.apiKey, username: o.username, language: o.language, loggedIn: !!vlsub.token };
});

/* ---------- Media > Convert / Save… ---------- */
let converter;
ipcMain.handle('convert:profiles', () => Object.entries(PROFILES).map(([id, p]) => ({ id, label: p.label, ext: p.ext, kind: p.kind })));
ipcMain.handle('convert:start', (_e, opts) => converter.start(opts));
ipcMain.handle('convert:cancel', (_e, id) => converter.cancel(id));
ipcMain.handle('convert:list', () => converter.list());
ipcMain.handle('convert:clear', () => { converter.clearFinished(); return converter.list(); });
ipcMain.handle('dialog:save-path', async (_e, { defaultName, ext }) => {
  const dir = path.join(app.getPath('videos'), 'AAPlayer');
  const r = await dialog.showSaveDialog(win, { title: 'Save converted file as', defaultPath: path.join(dir, defaultName),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (r.canceled || !r.filePath) return null;
  await fsp.mkdir(path.dirname(r.filePath), { recursive: true });
  return r.filePath;
});

/* ---------- Media > Open Disc… ---------- */
ipcMain.handle('disc:scan', () => disc.scanDrives());
ipcMain.handle('disc:titles', (_e, folder) => disc.listTitles(folder));
ipcMain.handle('dialog:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a DVD/Blu-ray folder (VIDEO_TS or BDMV)', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

/* ---------- Media > Open Capture Device… ----------
 * Camera/microphone access is denied unless the user just picked a device in
 * Open Capture Device (the renderer "arms" capture for a few seconds). */
let captureArmedUntil = 0;
ipcMain.on('capture:arm', () => { captureArmedUntil = Date.now() + 8000; });
ipcMain.handle('record:save-blob', async (_e, { data, ext }) => {
  const dir = path.join(app.getPath('videos'), 'AAPlayer');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(dir, `capture_${stamp}.${ext === 'mp4' ? 'mp4' : 'webm'}`);
  await fsp.writeFile(file, Buffer.from(data));
  log('record', `saved ${file}`);
  return file;
});
function installPermissionHandlers() {
  const ALWAYS = new Set(['clipboard-sanitized-write', 'speaker-selection']);
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALWAYS.has(permission) || permission === 'media');
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (ALWAYS.has(permission)) return callback(true);
    if (permission === 'media') {
      const ok = Date.now() < captureArmedUntil;
      log('main', `${ok ? 'allowed' : 'denied'} camera/microphone request (${(details.mediaTypes || []).join(', ') || 'media'})`);
      captureArmedUntil = 0;
      return callback(ok);
    }
    log('main', `denied permission request: ${permission}`);
    callback(false);
  });
}

ipcMain.on('app:quit', () => app.quit());

/* ---------- lifecycle ---------- */
app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'));
  menuState.decodeMode = store.settings.decodeMode;
  server = new MediaServer({ getTools: () => tools, log });
  remote = new RemoteServer({ log, onCommand: (cmd, arg) => send(cmd, arg), getStatus: () => remoteStatus });
  streams = new StreamServer({ log, getTools: () => tools, getInfo: async (input) => { await ensureTools(); return getInfo(input); } });
  converter = new Converter({ log, getTools: () => tools, getInfo: async (input) => { await ensureTools(); return getInfo(input); },
    notify: (job) => send('convert-progress', job) });
  installPermissionHandlers();
  vlsub = new OpenSubtitles({ log, userAgent: `AAPlayer v${app.getVersion()}` });
  await server.listen();
  log('main', `AAPlayer ${app.getVersion()} (Electron ${process.versions.electron}, Chromium ${process.versions.chrome}); media server on 127.0.0.1:${server.port}`);
  ensureTools().catch(() => {});
  createWindow();
  nativeTheme.on('updated', () => refreshMenu()); // switch menu icons between dark/light
  win.webContents.once('did-finish-load', () => { if (store.settings.remote.enabled) applyRemote(); });
});

app.on('open-file', (e, file) => { e.preventDefault(); sendOpen([file]); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (remote) remote.stop();
  if (streams) streams.closeAll();
  if (converter) converter.cancelAll();
  if (recorder) { try { recorder.child.stdin.write('q'); } catch { /* ignore */ } } if (store) store.flush(); if (server) server.close(); });
