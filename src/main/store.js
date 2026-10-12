'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  settings: {
    decodeMode: 'auto',        // auto | compat | direct
    encoder: 'auto',           // auto | h264_nvenc | h264_qsv | h264_amf | libx264
    quality: 'balanced',       // high | balanced | fast
    maxHeight: 0,              // 0 = keep source resolution when transcoding
    resumePlayback: true,
    saveRecent: true,          // Tools > Remember Recent Media (privacy)
    deinterlace: 'auto',       // off | auto | on
    deinterlaceMode: 'bwdif',
    fitWindow: false,          // Video > Always Fit Window
    playlistDocked: true,
    statusBar: false,
    advancedControls: false,
    fullscreenControls: true,  // View > Fullscreen Interface
    tenBitPresenter: 'auto',   // auto | off: draw 10-bit SDR video via canvas (Intel P010 display bug)
    visualization: 'off',
    audioDevice: '',
    eq: { enabled: false, preset: 'flat', preamp: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    toolbar: null,             // Tools > Customize Interface: [{ id, visible }]
    remote: { enabled: false, allowLan: false, port: 8085, pin: '' },   // View > Add Interface > Web Remote
    vlm: { port: 8086, pin: '' },                                       // Tools > VLM Configuration
    opensubtitles: { apiKey: '', username: '', language: 'en' },        // View > VLsub
    volume: 1,
    alwaysOnTop: false,
    showRemaining: false,
    subtitleScale: 1,
    ffmpegPath: '',
    ffprobePath: '',
  },
  recent: [],
  resume: {},
  windowBounds: null,
};

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'aaplayer.json');
    this.data = structuredClone(DEFAULTS);
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...saved, settings: { ...DEFAULTS.settings, ...(saved.settings || {}) } };
      for (const k of ['remote', 'vlm', 'opensubtitles']) this.data.settings[k] = { ...DEFAULTS.settings[k], ...(saved.settings || {})[k] };
    } catch { /* first run or unreadable: use defaults */ }
    this.timer = null;
  }

  get settings() { return this.data.settings; }

  setSettings(patch) {
    Object.assign(this.data.settings, patch);
    // Privacy: turning these off also forgets what was already stored.
    if (patch.saveRecent === false) this.data.recent = [];
    if (patch.resumePlayback === false) this.data.resume = {};
    this.save();
    return this.data.settings;
  }

  addRecent(input) {
    if (!this.data.settings.saveRecent) return;
    this.data.recent = [input, ...this.data.recent.filter((r) => r !== input)].slice(0, 20);
    this.save();
  }

  clearRecent() { this.data.recent = []; this.save(); }

  getResume(input) { return this.data.resume[input] || 0; }

  setResume(input, seconds, duration) {
    if (!this.data.settings.resumePlayback) return;
    const keep = seconds > 30 && (!duration || seconds < duration - 30);
    if (keep) this.data.resume[input] = Math.floor(seconds);
    else delete this.data.resume[input];
    const keys = Object.keys(this.data.resume);
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete this.data.resume[k];
    this.save();
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }

  flush() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) { console.error('store save failed', e); }
  }
}

module.exports = { Store };
