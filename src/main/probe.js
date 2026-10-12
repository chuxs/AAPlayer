'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');
const { HDR_TRANSFERS } = require('./planner');

const IMAGE_SUBS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

function bitDepthOf(stream) {
  const raw = parseInt(stream.bits_per_raw_sample, 10);
  const pixFmt = stream.pix_fmt || '';
  // yuv420p10le, yuv444p12le, gbrp10le, gray10le ...
  const m = /(?:p|gray)(\d{2})(?:le|be)?$/.exec(pixFmt);
  if (m && ['10', '12', '14', '16'].includes(m[1])) return parseInt(m[1], 10);
  // p010le, p016le (semi-planar hardware formats)
  const semi = /^p0(10|12|16)/.exec(pixFmt);
  if (semi) return parseInt(semi[1], 10);
  if (raw > 8 && raw <= 16) return raw;
  return 8;
}

function chromaOf(pixFmt) {
  const f = pixFmt || '';
  if (/^(yuv|yuva|yuvj)444|^gbr|^rgb|^bgr/.test(f)) return '444';
  if (/^(yuv|yuva|yuvj)422|^nv16|^y210|^yuyv|^uyvy/.test(f)) return '422';
  return '420';
}

function fpsOf(stream) {
  for (const key of ['avg_frame_rate', 'r_frame_rate']) {
    const [n, d] = String(stream[key] || '0/0').split('/').map(Number);
    if (n > 0 && d > 0 && n / d < 400) return n / d;
  }
  return 0;
}

function tags(stream) {
  const t = stream.tags || {};
  const get = (k) => t[k] || t[k.toUpperCase()] || '';
  return { lang: get('language'), title: get('title') };
}

/** Converts raw ffprobe JSON into the shape used by the planner and UI. */
function normalizeProbe(json, input) {
  const fmt = json.format || {};
  const streams = json.streams || [];
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) && !/^file:/i.test(input);
  const info = {
    input,
    name: isUrl ? decodeURIComponent(input.split('/').pop().split('?')[0] || input)
      : path.basename(input.startsWith('concat:') ? input.slice(7).split('|')[0] : input), // DVD title: concat:VTS_01_1.VOB|...
    ext: isUrl ? '' : path.extname(input).slice(1).toLowerCase(),
    isUrlStream: isUrl,
    formatName: fmt.format_name || '',
    formatLongName: fmt.format_long_name || '',
    duration: parseFloat(fmt.duration) || 0,
    startTime: parseFloat(fmt.start_time) || 0,
    size: parseInt(fmt.size, 10) || 0,
    bitRate: parseInt(fmt.bit_rate, 10) || 0,
    title: (fmt.tags && (fmt.tags.title || fmt.tags.TITLE)) || '',
    video: [],
    audio: [],
    subs: [],
    // Chapter times are absolute; the player timeline starts at the file's start_time.
    chapters: (json.chapters || []).map((c) => ({
      start: Math.max(0, (parseFloat(c.start_time) || 0) - (parseFloat(fmt.start_time) || 0)),
      end: Math.max(0, (parseFloat(c.end_time) || 0) - (parseFloat(fmt.start_time) || 0)),
      title: (c.tags && c.tags.title) || '',
    })),
  };

  for (const s of streams) {
    const disp = s.disposition || {};
    const common = { index: s.index, codec: s.codec_name || 'unknown', profile: s.profile || '',
      default: !!disp.default, ...tags(s) };
    if (s.codec_type === 'video') {
      const fieldOrder = s.field_order || 'progressive';
      info.video.push({
        ...common,
        pixFmt: s.pix_fmt || '',
        level: typeof s.level === 'number' ? s.level : -1,
        bitDepth: bitDepthOf(s),
        chroma: chromaOf(s.pix_fmt),
        width: s.width || 0,
        height: s.height || 0,
        fps: fpsOf(s),
        transfer: s.color_transfer || '',
        primaries: s.color_primaries || '',
        matrix: s.color_space || '',
        range: s.color_range || '',
        isHDR: HDR_TRANSFERS.has(s.color_transfer || ''),
        interlaced: !['progressive', 'unknown', ''].includes(fieldOrder),
        attachedPic: !!disp.attached_pic,
      });
    } else if (s.codec_type === 'audio') {
      info.audio.push({ ...common, channels: s.channels || 0, layout: s.channel_layout || '',
        sampleRate: parseInt(s.sample_rate, 10) || 0 });
    } else if (s.codec_type === 'subtitle') {
      info.subs.push({ ...common, forced: !!disp.forced, kind: IMAGE_SUBS.has(s.codec_name) ? 'image' : 'text' });
    }
  }
  return info;
}

function probe(ffprobePath, input, timeoutMs = 30000) {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', input];
  return new Promise((resolve, reject) => {
    execFile(ffprobePath, args, { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop()));
        try { resolve(normalizeProbe(JSON.parse(stdout), input)); } catch (e) { reject(e); }
      });
  });
}

/**
 * Returns the time (relative to the file start, like ffmpeg -ss) of the video
 * keyframe at or just around `t`, which is where an ffmpeg stream-copy seek
 * will actually start. Used so the timeline stays exact when remuxing.
 * ffprobe works in absolute timestamps, hence the startTime conversions.
 */
function keyframeNear(ffprobePath, input, streamIndex, t, startTime = 0) {
  if (!(t > 0)) return Promise.resolve(0);
  const abs = t + startTime;
  const args = ['-v', 'error', '-select_streams', String(streamIndex), '-read_intervals', `${abs.toFixed(3)}%+#1`,
    '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'json', input];
  return new Promise((resolve) => {
    execFile(ffprobePath, args, { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(t);
      try {
        const pkt = (JSON.parse(stdout).packets || [])[0];
        const pts = parseFloat(pkt && (pkt.pts_time !== undefined ? pkt.pts_time : pkt.dts_time));
        const rel = pts - startTime;
        resolve(Number.isFinite(rel) && rel >= 0 && Math.abs(rel - t) < 30 ? rel : t);
      } catch { resolve(t); }
    });
  });
}

module.exports = { probe, normalizeProbe, keyframeNear, bitDepthOf, chromaOf };
