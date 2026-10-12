'use strict';
const { Menu, nativeImage, nativeTheme } = require('electron');
const path = require('node:path');

// Menu label (without &) -> icon in src/main/menu-icons/{dark,light}/<name>.png (rendered by scripts/make-menu-icons.js).
// Checkbox and radio items keep their check mark instead of an icon, as in VLC.
const ICONS = {
  'Open File…': 'open-file', 'Open Multiple Files…': 'open-multi', 'Open Folder…': 'open-folder',
  'Open Network Stream…': 'open-network', 'Open Disc…': 'disc', 'Open Capture Device…': 'capture',
  'Open Location from clipboard': 'clipboard', 'Convert / Save…': 'convert', 'Open Recent Media': 'recent', 'Stream…': 'vlm', 'Save Playlist to File…': 'save', 'Quit': 'quit',
  'Chapter': 'chapter', 'Renderer': 'renderer', 'Speed': 'speed', 'Jump Forward': 'forward', 'Jump Backward': 'backward',
  'Jump to Specific Time': 'goto', 'Next Frame': 'frame', 'Play': 'play', 'Pause': 'pause', 'Stop': 'stop', 'Previous': 'prev',
  'Next': 'next', 'Loop': 'loop', 'Loop A→B': 'ab',
  'Audio Track': 'audio-track', 'Audio Device': 'audio-device', 'Stereo Mode': 'stereo', 'Visualizations': 'visualization',
  'Increase Volume': 'volume-up', 'Decrease Volume': 'volume-down',
  'Video Track': 'video-track', 'Set as Wallpaper': 'wallpaper', 'Zoom': 'zoom', 'Aspect Ratio': 'aspect', 'Crop': 'crop',
  'Deinterlace': 'deinterlace', 'Deinterlace mode': 'deinterlace', 'Take Snapshot': 'snapshot', 'Decoding Mode': 'decode',
  'Add Subtitle File…': 'subtitle-add', 'Sub Track': 'subtitle-track', 'Cycle Subtitle Track': 'subtitle-track',
  'Effects and Filters': 'effects', 'Track Synchronization': 'sync', 'Media Information': 'info', 'Codec Information': 'codec',
  'VLM Configuration': 'vlm', 'Messages': 'messages', 'Clear Recent Media': 'clear', 'Customize Interface…': 'customize',
  'Preferences': 'preferences', 'Add Interface': 'remote', 'Web Remote…': 'remote', 'VLsub': 'vlsub', 'Toggle Developer Tools': 'devtools',
  'Help': 'help', 'Keyboard Shortcuts': 'keyboard', 'Check for Updates…': 'update', 'About': 'about', 'Cycle Audio Track': 'audio-track',
};
const iconCache = new Map();
function icon(name) {
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const key = `${theme}/${name}`;
  if (!iconCache.has(key)) iconCache.set(key, nativeImage.createFromPath(path.join(__dirname, 'menu-icons', theme, `${name}.png`)));
  return iconCache.get(key);
}
function decorate(items) {
  for (const it of items) {
    if (it.submenu && Array.isArray(it.submenu)) decorate(it.submenu);
    const name = it.label && ICONS[it.label.replace(/&/g, '')];
    if (name && (!it.type || it.type === 'normal' || it.type === 'submenu')) {
      const img = icon(name);
      if (!img.isEmpty()) it.icon = img;
    }
  }
  return items;
}

/*
 * VLC-style application menu (mirrors VLC 3's Qt menus). Shortcuts follow
 * VLC's Windows defaults (vlc-master/src/libvlc-module.c). Keys are handled in
 * the renderer (works in fullscreen without a menu bar), so accelerators here
 * are display-only (registerAccelerator: false).
 */
function buildMenu(state, send, actions) {
  const s = state || {};
  const has = !!s.hasMedia;
  const key = (accelerator) => ({ accelerator, registerAccelerator: false });
  const cmd = (name, arg) => () => send(name, arg);
  const radio = (items, current, name, enabled = true) => items.map(([value, label]) => ({
    label, type: 'radio', checked: current === value, enabled, click: cmd(name, value),
  }));
  const none = (label = 'Empty') => [{ label, enabled: false }];

  const recent = s.saveRecent === false
    ? none('Recent media is turned off (Tools menu)')
    : (s.recent || []).length
      ? [...s.recent.map((r) => ({ label: r.length > 80 ? '…' + r.slice(-79) : r, click: cmd('open-input', r) })),
        { type: 'separator' }, { label: 'Clear', click: () => actions.clearRecent() }]
      : none();

  const media = {
    label: '&Media',
    submenu: [
      { label: 'Open &File…', ...key('Ctrl+O'), click: () => actions.openFiles(false) },
      { label: 'Open &Multiple Files…', ...key('Ctrl+Shift+O'), click: () => actions.openFiles(true) },
      { label: 'Open F&older…', ...key('Ctrl+F'), click: () => actions.openFolder() },
      { label: 'Open &Disc…', ...key('Ctrl+D'), click: cmd('open-disc') },
      { label: 'Open &Network Stream…', ...key('Ctrl+N'), click: cmd('open-network') },
      { label: 'Open &Capture Device…', ...key('Ctrl+C'), click: cmd('open-capture') },
      { label: 'Open &Location from clipboard', ...key('Ctrl+V'), click: () => actions.openClipboard() },
      { label: 'Open &Recent Media', submenu: recent },
      { type: 'separator' },
      { label: 'Save Playlist to &File…', ...key('Ctrl+Y'), click: cmd('save-playlist') },
      { label: 'Con&vert / Save…', ...key('Ctrl+R'), click: cmd('convert') },
      { label: '&Stream…', ...key('Ctrl+S'), click: cmd('vlm', 'current') },
      { type: 'separator' },
      { label: 'Quit at the &end of playlist', type: 'checkbox', checked: !!s.quitAtEnd, click: cmd('quit-at-end-toggle') },
      { label: '&Quit', ...key('Ctrl+Q'), click: () => actions.quit() },
    ],
  };

  const playback = {
    label: 'P&layback',
    submenu: [
      {
        label: '&Chapter', enabled: has && (s.chapters || []).length > 0,
        submenu: (s.chapters || []).length
          ? s.chapters.map((c, i) => ({ label: c.title || `Chapter ${i + 1}`, click: cmd('seek', c.start) }))
          : none('None'),
      },
      {
        label: '&Renderer', submenu: [
          { label: '<Local>', type: 'radio', checked: true },
          { type: 'separator' },
          { label: 'No other renderers found', enabled: false },
        ],
      },
      { type: 'separator' },
      {
        label: 'Sp&eed', enabled: has, submenu: [
          { label: '&Faster', ...key('Plus'), click: cmd('rate-step', 1) },
          { label: 'Faster (fine)', ...key(']'), click: cmd('rate-fine', 0.1) },
          { label: '&Normal Speed', ...key('='), click: cmd('rate', 1) },
          { label: 'Slower (fine)', ...key('['), click: cmd('rate-fine', -0.1) },
          { label: 'Slo&wer', ...key('-'), click: cmd('rate-step', -1) },
        ],
      },
      { type: 'separator' },
      { label: 'Jump &Forward', ...key('Alt+Right'), enabled: has, click: cmd('jump', 10) },
      { label: 'Jump Bac&kward', ...key('Alt+Left'), enabled: has, click: cmd('jump', -10) },
      { label: 'Jump to Specific &Time', ...key('Ctrl+T'), enabled: has, click: cmd('goto-time') },
      { label: 'Next &Frame', ...key('E'), enabled: has, click: cmd('frame-next') },
      { type: 'separator' },
      { label: s.playing ? '&Pause' : '&Play', ...key('Space'), click: cmd('toggle-play') },
      { label: '&Stop', ...key('S'), enabled: has, click: cmd('stop') },
      { label: 'Pre&vious', ...key('P'), click: cmd('prev') },
      { label: 'Ne&xt', ...key('N'), click: cmd('next') },
      { label: 'Re&cord', type: 'checkbox', checked: !!s.recording, ...key('Shift+R'), enabled: has || !!s.recording, click: cmd('record-toggle') },
      { type: 'separator' },
      { label: '&Loop', submenu: radio([['none', 'No Loop'], ['all', 'Loop All'], ['one', 'Loop One']], s.loop || 'none', 'loop') },
      { label: 'Loop &A→B', ...key('Shift+L'), enabled: has, click: cmd('ab-loop') },
      { label: '&Random', type: 'checkbox', checked: !!s.random, ...key('R'), click: cmd('random-toggle') },
    ],
  };

  const devices = [{ id: '', label: 'Default' }, ...(s.audioDevices || [])];
  const audio = {
    label: '&Audio',
    submenu: [
      {
        label: 'Audio &Track', enabled: has && (s.audioTracks || []).length > 0,
        submenu: (s.audioTracks || []).length
          ? s.audioTracks.map((t) => ({ label: t.label, type: 'radio', checked: t.selected, click: cmd('audio-track', t.index) }))
          : none('None'),
      },
      { label: 'Audio &Device', submenu: devices.map((d) => ({ label: d.label, type: 'radio', checked: (s.audioDevice || '') === d.id, click: cmd('audio-device', d.id) })) },
      { label: '&Stereo Mode', submenu: radio([['stereo', 'Stereo'], ['mono', 'Mono'], ['left', 'Left'], ['right', 'Right'], ['reverse', 'Reverse stereo']], s.stereoMode || 'stereo', 'stereo-mode') },
      { type: 'separator' },
      { label: '&Visualizations', submenu: radio([['off', 'Disable'], ['spectrum', 'Spectrum'], ['scope', 'Scope'], ['vumeter', 'VU Meter']], s.visualization || 'off', 'visualization') },
      { type: 'separator' },
      { label: '&Increase Volume', ...key('Ctrl+Up'), click: cmd('volume-step', 0.05) },
      { label: '&Decrease Volume', ...key('Ctrl+Down'), click: cmd('volume-step', -0.05) },
      { label: '&Mute', type: 'checkbox', checked: !!s.muted, ...key('M'), click: cmd('mute-toggle') },
    ],
  };

  const video = {
    label: '&Video',
    submenu: [
      {
        label: 'Video &Track', enabled: has && (s.videoTracks || []).length > 0,
        submenu: (s.videoTracks || []).length
          ? s.videoTracks.map((t) => ({ label: t.label, type: 'radio', checked: t.selected, click: cmd('video-track', t.index) }))
          : none('None'),
      },
      { type: 'separator' },
      { label: '&Fullscreen', type: 'checkbox', checked: !!s.fullscreen, ...key('F'), click: cmd('fullscreen-toggle') },
      { label: 'Always Fit &Window', type: 'checkbox', checked: !!s.fitWindow, click: cmd('fit-window-toggle') },
      { label: 'Set as Wa&llpaper', enabled: has && s.hasVideo, click: cmd('wallpaper') },
      { type: 'separator' },
      {
        label: '&Zoom', enabled: has, submenu: radio([[0.25, '1:4 Quarter'], [0.5, '1:2 Half'], [1, '1:1 Original'], [2, '2:1 Double'], [0, 'Fit to window']],
          s.zoom === undefined ? 0 : s.zoom, 'zoom'),
      },
      {
        label: '&Aspect Ratio', enabled: has, submenu: radio([
          ['default', 'Default'], ['16:9', '16:9'], ['4:3', '4:3'], ['1:1', '1:1'], ['16:10', '16:10'], ['2.21:1', '2.21:1'],
          ['2.35:1', '2.35:1'], ['2.39:1', '2.39:1'], ['5:4', '5:4'], ['fill', 'Stretch to window']], s.aspect || 'default', 'aspect'),
      },
      {
        label: '&Crop', enabled: has, submenu: radio([
          ['default', 'Default'], ['16:10', '16:10'], ['16:9', '16:9'], ['4:3', '4:3'], ['1.85:1', '1.85:1'], ['2.21:1', '2.21:1'],
          ['2.35:1', '2.35:1'], ['2.39:1', '2.39:1'], ['5:3', '5:3'], ['5:4', '5:4'], ['1:1', '1:1']], s.crop || 'default', 'crop'),
      },
      { type: 'separator' },
      { label: '&Deinterlace', submenu: radio([['off', 'Off'], ['auto', 'Automatic'], ['on', 'On']], s.deinterlace || 'auto', 'deinterlace') },
      {
        label: 'Deinterlace &mode', submenu: radio([['bwdif', 'Bwdif'], ['bwdif2x', 'Bwdif (2x)'], ['yadif', 'Yadif'], ['yadif2x', 'Yadif (2x)'],
          ['w3fdif', 'W3FDIF'], ['linear', 'Linear']], s.deinterlaceMode || 'bwdif', 'deinterlace-mode'),
      },
      { type: 'separator' },
      { label: 'Take &Snapshot', ...key('Shift+S'), enabled: has && s.hasVideo, click: cmd('snapshot') },
      { type: 'separator' },
      {
        label: 'D&ecoding Mode', submenu: radio([
          ['auto', 'Auto (native when possible, 8-bit fallback)'],
          ['compat', 'Compatibility (always convert to 8-bit H.264)'],
          ['direct', 'Native only (no conversion)']], s.decodeMode || 'auto', 'decode-mode'),
      },
    ],
  };

  const subtitle = {
    label: 'Subti&tle',
    submenu: [
      { label: 'Add &Subtitle File…', enabled: has, click: () => actions.openSubtitle() },
      {
        label: 'Sub &Track', enabled: has,
        submenu: [
          { label: 'Disable', type: 'radio', checked: !(s.subTracks || []).some((t) => t.selected), click: cmd('sub-track', null) },
          ...(s.subTracks || []).map((t) => ({ label: t.label, type: 'radio', checked: t.selected, click: cmd('sub-track', t.id) })),
        ],
      },
      { label: 'Cycle Subtitle Track', ...key('V'), enabled: has, click: cmd('sub-cycle') },
      { type: 'separator' },
      { label: 'Delay +50 ms', ...key('H'), enabled: has, click: cmd('sub-delay', 0.05) },
      { label: 'Delay −50 ms', ...key('G'), enabled: has, click: cmd('sub-delay', -0.05) },
      { label: 'Bigger Text', ...key('Ctrl+Plus'), click: cmd('sub-scale', 0.1) },
      { label: 'Smaller Text', ...key('Ctrl+-'), click: cmd('sub-scale', -0.1) },
    ],
  };

  const tools = {
    label: 'T&ools',
    submenu: [
      { label: '&Effects and Filters', ...key('Ctrl+E'), click: cmd('effects') },
      { label: '&Track Synchronization', click: cmd('effects', 'sync') },
      { label: '&Media Information', ...key('Ctrl+I'), enabled: has, click: cmd('media-info') },
      { label: '&Codec Information', ...key('Ctrl+J'), enabled: has, click: cmd('media-info', 'codec') },
      { label: '&VLM Configuration', ...key('Ctrl+Shift+W'), click: cmd('vlm') },
      { label: 'M&essages', ...key('Ctrl+M'), click: cmd('messages') },
      { type: 'separator' },
      { label: 'Remember &Recent Media', type: 'checkbox', checked: s.saveRecent !== false, click: cmd('save-recent-toggle') },
      { label: 'Remember Playback &Position', type: 'checkbox', checked: s.resumePlayback !== false, click: cmd('resume-toggle') },
      { label: 'C&lear Recent Media', click: () => actions.clearRecent() },
      { type: 'separator' },
      { label: 'C&ustomize Interface…', click: cmd('customize') },
      { label: '&Preferences', ...key('Ctrl+P'), click: cmd('preferences') },
    ],
  };

  const view = {
    label: 'V&iew',
    submenu: [
      { label: '&Playlist', type: 'checkbox', checked: !!s.playlistVisible, ...key('Ctrl+L'), click: cmd('playlist-toggle') },
      { label: '&Docked Playlist', type: 'checkbox', checked: s.playlistDocked !== false, click: cmd('playlist-dock-toggle') },
      { type: 'separator' },
      { label: 'Always on &Top', type: 'checkbox', checked: !!s.alwaysOnTop, click: () => actions.toggleOnTop() },
      { type: 'separator' },
      { label: '&Minimal Interface', type: 'checkbox', checked: !!s.minimal, ...key('Ctrl+H'), click: cmd('minimal-toggle') },
      { label: '&Fullscreen Interface', type: 'checkbox', checked: !!s.fullscreenInterface, ...key('F11'), click: cmd('fullscreen-interface') },
      { label: '&Advanced Controls', type: 'checkbox', checked: !!s.advancedControls, click: cmd('advanced-controls-toggle') },
      { label: 'Status &Bar', type: 'checkbox', checked: !!s.statusBar, click: cmd('status-bar-toggle') },
      { type: 'separator' },
      { label: 'Add &Interface', submenu: [
        { label: '&Web Remote…', click: cmd('web-remote') },
      ] },
      { type: 'separator' },
      { label: '&VLsub', click: cmd('vlsub') },
      { type: 'separator' },
      { label: 'Toggle &Developer Tools', ...key('Ctrl+Shift+I'), click: () => actions.devtools() },
    ],
  };

  const help = {
    label: '&Help',
    submenu: [
      { label: '&Help', ...key('F1'), click: cmd('help') },
      { label: '&Keyboard Shortcuts', click: cmd('help-keys') },
      { label: 'Check for &Updates…', click: cmd('check-updates') },
      { type: 'separator' },
      { label: '&About', ...key('Shift+F1'), click: cmd('about') },
    ],
  };

  return Menu.buildFromTemplate(decorate([media, playback, audio, video, subtitle, tools, view, help]));
}

module.exports = { buildMenu };
