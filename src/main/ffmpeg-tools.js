'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function run(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Packaged builds keep binaries outside the asar archive.
function unpacked(p) {
  return p ? p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1') : p;
}

// Matching ffmpeg + ffprobe 6.1 builds shipped with the app (ffmpeg-ffprobe-static).
function bundled(key) {
  try { return unpacked(require('ffmpeg-ffprobe-static')[key]); } catch { return null; }
}
const bundledFfmpeg = () => bundled('ffmpegPath');
const bundledFfprobe = () => bundled('ffprobePath');

async function whichAll(name) {
  const r = await run(process.platform === 'win32' ? 'where' : 'which', process.platform === 'win32' ? [name] : ['-a', name]);
  return r.ok ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
}

/** Parses "ffmpeg version 6.1.1-..." / "version N-123074-g..." into a sortable number. */
function versionScore(text) {
  const m = /version\s+(\S+)/.exec(text || '');
  if (!m) return -1;
  const v = m[1];
  if (/^N-\d+/.test(v)) return 1000 + parseInt(v.slice(2), 10) / 1e6; // git master builds: newest
  const n = /^(\d+)\.(\d+)/.exec(v.replace(/^n/, ''));
  return n ? parseInt(n[1], 10) + parseInt(n[2], 10) / 100 : 0;
}

async function pickNewest(candidates) {
  const seen = new Set();
  let best = null;
  for (const c of candidates) {
    if (!c || seen.has(c.toLowerCase()) || !fs.existsSync(c)) continue;
    seen.add(c.toLowerCase());
    const r = await run(c, ['-version'], 8000);
    if (!r.ok) continue;
    const score = versionScore(r.stdout);
    if (!best || score > best.score) best = { path: c, score, version: (r.stdout.split('\n')[0] || '').trim() };
  }
  return best;
}

/** Tries a one-second test encode to see if a hardware H.264 encoder actually works here. */
async function encoderWorks(ffmpeg, encoder) {
  const fmt = /_nvenc$/.test(encoder) ? 'yuv420p' : 'nv12';
  const r = await run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=640x360:rate=30', '-t', '0.5', '-vf', `format=${fmt}`, '-c:v', encoder, '-f', 'null', '-'], 20000);
  return r.ok && !/error/i.test(r.stderr);
}

/**
 * Locates ffmpeg/ffprobe (settings override > newest of PATH and bundled)
 * and detects usable encoders and filters.
 */
async function detectTools(settings = {}) {
  // A path chosen in Preferences wins when it works; otherwise use the newest found.
  const ffmpeg = (settings.ffmpegPath && await pickNewest([settings.ffmpegPath])) ||
    await pickNewest([...(await whichAll('ffmpeg')), bundledFfmpeg()]);
  const ffprobe = (settings.ffprobePath && await pickNewest([settings.ffprobePath])) ||
    await pickNewest([...(await whichAll('ffprobe')), bundledFfprobe()]);
  if (!ffmpeg || !ffprobe) throw new Error('FFmpeg/ffprobe not found. Reinstall AAPlayer or set their paths in Preferences.');

  const [enc, filt] = await Promise.all([
    run(ffmpeg.path, ['-hide_banner', '-encoders']),
    run(ffmpeg.path, ['-hide_banner', '-filters']),
  ]);
  const listed = (name) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(enc.stdout);
  const hw = ['h264_nvenc', 'h264_qsv', 'h264_amf'].filter(listed);
  const working = await Promise.all(hw.map((e) => encoderWorks(ffmpeg.path, e)));
  const encoders = hw.filter((_, i) => working[i]);
  if (listed('libx264')) encoders.push('libx264');
  // HEVC encoders for Media > Convert / Save
  const hwHevc = ['hevc_nvenc', 'hevc_qsv', 'hevc_amf'].filter(listed);
  const hevcWorking = await Promise.all(hwHevc.map((e) => encoderWorks(ffmpeg.path, e)));
  const hevcEncoders = hwHevc.filter((_, i) => hevcWorking[i]);
  if (listed('libx265')) hevcEncoders.push('libx265');

  const hasFilter = (name) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(filt.stdout);
  return {
    ffmpeg: ffmpeg.path,
    ffmpegVersion: ffmpeg.version,
    ffprobe: ffprobe.path,
    ffprobeVersion: ffprobe.version,
    encoders,
    hevcEncoders,
    audioEncoders: ['libmp3lame', 'libopus', 'flac', 'aac'].filter(listed),
    hasZscale: hasFilter('zscale'),
    hasTonemap: hasFilter('tonemap'),
  };
}

module.exports = { detectTools, versionScore, run, unpacked, bundledFfmpeg };
