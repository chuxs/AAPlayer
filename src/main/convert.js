'use strict';
/*
 * Media > Convert / Save… (VLC Ctrl+R): converts or remuxes a file with FFmpeg
 * in the background, reporting progress. Uses the same hardware encoders and
 * 10-bit/HDR handling as the playback pipeline.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { plan, encoderArgs, videoFilters, pickEncoder } = require('./planner');

const PROFILES = {
  'h264-mp4': { label: 'Video – H.264 + AAC (MP4)', ext: 'mp4', kind: 'video' },
  'h265-mp4': { label: 'Video – H.265/HEVC + AAC (MP4)', ext: 'mp4', kind: 'video' },
  'copy-mkv': { label: 'Video – keep all streams, no re-encode (MKV)', ext: 'mkv', kind: 'remux' },
  'copy-mp4': { label: 'Video – keep video, no re-encode (MP4)', ext: 'mp4', kind: 'remux' },
  'mp3': { label: 'Audio – MP3', ext: 'mp3', kind: 'audio' },
  'm4a': { label: 'Audio – AAC (M4A)', ext: 'm4a', kind: 'audio' },
  'opus': { label: 'Audio – Opus', ext: 'opus', kind: 'audio' },
  'flac': { label: 'Audio – FLAC (lossless)', ext: 'flac', kind: 'audio' },
};
const NO_CAPS = { video: {}, audio: {} };
const MP4_COPY_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac', 'alac']);

function hevcArgs(encoder, tenBit, quality) {
  const q = quality === 'high' ? -2 : quality === 'fast' ? 3 : 0;
  switch (encoder) {
    case 'hevc_nvenc': return ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(24 + q), '-b:v', '0', ...(tenBit ? ['-profile:v', 'main10'] : [])];
    case 'hevc_qsv': return ['-c:v', 'hevc_qsv', '-preset', 'medium', '-global_quality', String(24 + q), ...(tenBit ? ['-profile:v', 'main10'] : [])];
    case 'hevc_amf': return ['-c:v', 'hevc_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(22 + q), '-qp_p', String(24 + q)];
    default: return ['-c:v', 'libx265', '-preset', quality === 'fast' ? 'faster' : 'medium', '-crf', String(22 + q), '-x265-params', 'log-level=error'];
  }
}

/**
 * Builds the ffmpeg arguments for a conversion.
 * opts: { profile, output, start, end, quality, maxHeight, audioIndex }
 */
function buildConvertArgs(info, opts, tools) {
  const profile = PROFILES[opts.profile];
  if (!profile) throw new Error('Unknown profile');
  const video = info.video.find((v) => !v.attachedPic);
  const audio = info.audio.find((a) => a.index === opts.audioIndex) || info.audio.find((a) => a.default) || info.audio[0];
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  if (opts.start > 0) args.push('-ss', Number(opts.start).toFixed(3));
  args.push('-i', info.input);
  if (opts.end > 0) args.push('-t', Math.max(0.1, opts.end - (opts.start || 0)).toFixed(3));
  const aBitrate = (a) => ((a && a.channels > 2) ? '384k' : '192k');

  if (profile.kind === 'audio') {
    if (!audio) throw new Error('This file has no audio');
    args.push('-map', `0:${audio.index}`, '-vn', '-sn', '-dn');
    if (opts.profile === 'mp3') args.push('-c:a', 'libmp3lame', '-q:a', opts.quality === 'fast' ? '4' : '2', '-ac', String(Math.min(2, audio.channels || 2)));
    else if (opts.profile === 'm4a') args.push('-c:a', 'aac', '-b:a', audio.channels > 2 ? '384k' : '256k');
    else if (opts.profile === 'opus') args.push('-c:a', 'libopus', '-b:a', audio.channels > 2 ? '256k' : '160k');
    else args.push('-c:a', 'flac');
    args.push('-map_metadata', '0');
  } else if (opts.profile === 'copy-mkv') {
    args.push('-map', '0', '-c', 'copy');
  } else if (opts.profile === 'copy-mp4') {
    if (!video) throw new Error('This file has no video');
    args.push('-map', `0:${video.index}`, '-c:v', 'copy');
    if (video.codec === 'hevc') args.push('-tag:v', 'hvc1');
    if (audio) {
      args.push('-map', `0:${audio.index}`);
      if (MP4_COPY_AUDIO.has(audio.codec)) args.push('-c:a', 'copy');
      else args.push('-c:a', 'aac', '-b:a', aBitrate(audio));
    }
    args.push('-sn', '-dn', '-movflags', '+faststart');
  } else {
    if (!video) throw new Error('This file has no video');
    const p = plan(info, NO_CAPS, { mode: 'compat' });
    const hevc = opts.profile === 'h265-mp4';
    const tenBit = hevc && video.bitDepth > 8 && !p.hdrToSdr;
    args.push('-map', `0:${video.index}`);
    if (hevc) {
      const enc = ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'libx265'].find((e) => (tools.hevcEncoders || []).includes(e)) || 'libx265';
      // 10-bit sources stay 10-bit in HEVC (except AMF); hardware encoders take semi-planar input.
      const fmt = tenBit && enc !== 'hevc_amf'
        ? (enc === 'libx265' ? 'yuv420p10le' : 'p010le')
        : (enc === 'libx265' || enc === 'hevc_nvenc' ? 'yuv420p' : 'nv12');
      const filters = videoFilters(p, video, 'libx264', tools, opts.maxHeight).replace(/format=yuv420p$/, `format=${fmt}`);
      args.push('-vf', filters, ...hevcArgs(enc, tenBit, opts.quality), '-tag:v', 'hvc1');
    } else {
      const enc = pickEncoder(tools.encoders || [], tools.preferredEncoder);
      args.push('-vf', videoFilters(p, video, enc, tools, opts.maxHeight), ...encoderArgs(enc, video.fps, opts.quality));
    }
    if (audio) {
      args.push('-map', `0:${audio.index}`);
      if (audio.codec === 'aac') args.push('-c:a', 'copy');
      else args.push('-c:a', 'aac', '-b:a', aBitrate(audio));
    }
    args.push('-sn', '-dn', '-movflags', '+faststart', '-map_metadata', '0');
  }
  args.push('-progress', 'pipe:1', '-nostats', opts.output);
  return args;
}

class Converter {
  constructor({ log, getTools, getInfo, notify }) {
    this.log = log;
    this.getTools = getTools;
    this.getInfo = getInfo;
    this.notify = notify;
    this.jobs = new Map();
  }

  list() {
    return [...this.jobs.values()].map(({ child, ...j }) => j);
  }

  async start(opts) {
    const tools = this.getTools();
    const info = await this.getInfo(opts.input);
    if (opts.output && fs.existsSync(opts.input) && fs.realpathSync(opts.input) === (fs.existsSync(opts.output) && fs.realpathSync(opts.output))) {
      throw new Error('Output must be a different file than the input');
    }
    const args = buildConvertArgs(info, opts, tools);
    const total = Math.max(0.1, (opts.end > 0 ? opts.end : info.duration) - (opts.start || 0));
    const id = crypto.randomBytes(6).toString('hex');
    const job = { id, input: opts.input, output: opts.output, profile: opts.profile, progress: 0, speed: '', state: 'running', error: '' };
    this.log('convert', `ffmpeg ${args.join(' ')}`);
    const child = spawn(tools.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    job.child = child;
    this.jobs.set(id, job);
    let err = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const [k, v] = line.split('=');
        if (k === 'out_time_us' || k === 'out_time_ms') job.progress = Math.min(0.999, (parseInt(v, 10) / 1e6) / total) || job.progress;
        else if (k === 'speed') job.speed = v.trim();
        else if (k === 'progress') this.emit(job);
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { job.state = 'failed'; job.error = e.message; this.emit(job); });
    child.on('close', (code) => {
      if (job.state === 'cancelled') { fs.rm(job.output, { force: true }, () => {}); }
      else if (code === 0) { job.state = 'done'; job.progress = 1; this.log('convert', `saved ${job.output}`); }
      else { job.state = 'failed'; job.error = (err.trim().split('\n').pop() || `ffmpeg exited ${code}`); this.log('convert', `failed: ${job.error}`); }
      delete job.child;
      this.emit(job);
    });
    this.emit(job);
    return id;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || !job.child) return;
    job.state = 'cancelled';
    try { job.child.stdin.write('q'); } catch { /* ignore */ }
    setTimeout(() => { if (job.child) job.child.kill(); }, 3000);
  }

  clearFinished() {
    for (const [id, j] of this.jobs) if (j.state !== 'running') this.jobs.delete(id);
  }

  cancelAll() { for (const id of this.jobs.keys()) this.cancel(id); }

  emit(job) {
    const { child, ...pub } = job;
    this.notify(pub);
  }
}

module.exports = { Converter, buildConvertArgs, PROFILES };
