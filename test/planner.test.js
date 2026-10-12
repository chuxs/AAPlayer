'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProbe, bitDepthOf } = require('../src/main/probe');
const { plan, buildStreamArgs, pickEncoder } = require('../src/main/planner');

const ALL = {
  video: { h264: true, h264_10: false, hevc: true, hevc_10: true, vp9: true, vp9_10: true, av1: true, av1_10: true, vp8: true },
  audio: { aac: true, mp3: true, opus: true, flac: true, vorbis: true, ac3: false, eac3: false },
};
const NO_HEVC10 = { ...ALL, video: { ...ALL.video, hevc_10: false } };

function probeJson({ format = 'matroska,webm', video, audio = [{ codec_name: 'aac', channels: 2 }], subs = [] }) {
  const streams = [];
  let i = 0;
  if (video) streams.push({ index: i++, codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '24000/1001', ...video });
  for (const a of audio) streams.push({ index: i++, codec_type: 'audio', sample_rate: '48000', ...a });
  for (const s of subs) streams.push({ index: i++, codec_type: 'subtitle', ...s });
  return { format: { format_name: format, duration: '1440.5' }, streams };
}

test('bit depth comes from the pixel format, not the file name', () => {
  assert.equal(bitDepthOf({ pix_fmt: 'yuv420p' }), 8);
  assert.equal(bitDepthOf({ pix_fmt: 'yuv420p10le' }), 10);
  assert.equal(bitDepthOf({ pix_fmt: 'yuv444p12le' }), 12);
  assert.equal(bitDepthOf({ pix_fmt: 'p010le' }), 10);
  assert.equal(bitDepthOf({ pix_fmt: 'nv12' }), 8);
  assert.equal(bitDepthOf({ pix_fmt: 'gray10le' }), 10);

  // An 8-bit file that merely has "10bit" in its name is still 8-bit.
  const info = normalizeProbe(probeJson({ video: { codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p' } }),
    'C:/Videos/Show.S01E01.1080p.10bit.mkv');
  assert.equal(info.video[0].bitDepth, 8);
  assert.equal(plan(info, ALL).video.action, 'copy');
});

test('10-bit H.264 (Hi10P) is copied only if Chromium can decode it, else converted to 8-bit', () => {
  const info = normalizeProbe(probeJson({ video: { codec_name: 'h264', profile: 'High 10', pix_fmt: 'yuv420p10le' } }), 'a.mkv');
  const sw = plan(info, { ...ALL, video: { ...ALL.video, h264_10: true } });
  assert.equal(sw.video.action, 'copy');
  assert.equal(plan(info, { ...ALL, video: { ...ALL.video, h264_10: true } }, { mode: 'compat' }).video.action, 'encode');
  const p = plan(info, ALL);
  assert.equal(p.kind, 'transcode');
  assert.equal(p.video.action, 'encode');
  assert.match(p.reasons.join(' '), /Hi10P/);
  const { args } = buildStreamArgs(p, info, 0, { encoders: ['h264_qsv', 'libx264'] });
  assert.ok(args.includes('h264_qsv'));
  assert.match(args[args.indexOf('-vf') + 1], /format=nv12$/);
});

test('10-bit HEVC is copied when the GPU decodes Main10, converted otherwise', () => {
  const json = probeJson({ video: { codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le' },
    audio: [{ codec_name: 'aac', profile: 'HE-AAC', channels: 6 }] });
  const info = normalizeProbe(json, 'A.Monster.Calls.2016.1080p.10bit.BluRay.6CH.x265.HEVC-PSA.mkv');
  const native = plan(info, ALL);
  assert.equal(native.kind, 'remux');
  assert.equal(native.video.action, 'copy');
  assert.equal(native.audio.action, 'copy');
  const { args } = buildStreamArgs(native, info, 100, { encoders: [] });
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 4), ['-c:v', 'copy', '-tag:v', 'hvc1']);
  assert.ok(args.includes('-noaccurate_seek'));

  const fallback = plan(info, NO_HEVC10);
  assert.equal(fallback.kind, 'transcode');
  const compat = plan(info, ALL, { mode: 'compat' });
  assert.equal(compat.kind, 'transcode');
});

test('HDR is tone-mapped when converting', () => {
  const info = normalizeProbe(probeJson({ video: { codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le',
    color_transfer: 'smpte2084', color_primaries: 'bt2020' } }), 'hdr.mkv');
  const p = plan(info, NO_HEVC10);
  assert.equal(p.hdrToSdr, true);
  const { args } = buildStreamArgs(p, info, 0, { encoders: ['libx264'], hasZscale: true, hasTonemap: true });
  assert.match(args[args.indexOf('-vf') + 1], /tonemap=tonemap=hable/);
});

test('MP4 with browser codecs plays directly; AC-3 audio forces remux', () => {
  const mp4 = normalizeProbe(probeJson({ format: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec_name: 'h264', pix_fmt: 'yuv420p' } }), 'a.mp4');
  assert.equal(plan(mp4, ALL).kind, 'direct');
  const ac3 = normalizeProbe(probeJson({ format: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec_name: 'h264', pix_fmt: 'yuv420p' },
    audio: [{ codec_name: 'ac3', channels: 6 }] }), 'a.mp4');
  const p = plan(ac3, ALL);
  assert.equal(p.kind, 'remux');
  assert.equal(p.audio.action, 'encode');
});

test('choosing a second audio track remuxes; image subtitles burn in', () => {
  const info = normalizeProbe(probeJson({ format: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec_name: 'h264', pix_fmt: 'yuv420p' },
    audio: [{ codec_name: 'aac', channels: 2 }, { codec_name: 'aac', channels: 2 }],
    subs: [{ codec_name: 'hdmv_pgs_subtitle' }] }), 'a.mp4');
  assert.equal(plan(info, ALL, { audioIndex: 2 }).kind, 'remux');
  const burn = plan(info, ALL, { burnSubtitleIndex: 3 });
  assert.equal(burn.kind, 'transcode');
  const { args } = buildStreamArgs(burn, info, 0, { encoders: ['libx264'] });
  assert.match(args[args.indexOf('-filter_complex') + 1], /^\[0:0\]\[0:3\]overlay/);
});

test('encoder preference', () => {
  assert.equal(pickEncoder(['h264_qsv', 'libx264']), 'h264_qsv');
  assert.equal(pickEncoder(['h264_qsv', 'libx264'], 'libx264'), 'libx264');
  assert.equal(pickEncoder([], 'h264_nvenc'), 'libx264');
});

test('second video track forces remux; deinterlace off/auto/on', () => {
  const json = probeJson({ format: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec_name: 'h264', pix_fmt: 'yuv420p' } });
  json.streams.push({ index: 5, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1280, height: 720 });
  const info = normalizeProbe(json, 'a.mp4');
  assert.equal(plan(info, ALL).kind, 'direct');
  const p = plan(info, ALL, { videoIndex: 5 });
  assert.equal(p.kind, 'remux');
  assert.equal(p.videoIndex, 5);

  const tv = normalizeProbe(probeJson({ format: 'mpegts', video: { codec_name: 'h264', pix_fmt: 'yuv420p', field_order: 'tt' } }), 'tv.ts');
  assert.equal(plan(tv, ALL).deinterlace, 'interlaced');
  assert.equal(plan(tv, ALL, { deinterlace: 'off' }).video.action, 'copy');
  const forced = plan(info, ALL, { deinterlace: 'on', deinterlaceMode: 'yadif2x' });
  assert.equal(forced.kind, 'transcode');
  const { args } = buildStreamArgs(forced, info, 0, { encoders: ['libx264'] });
  assert.match(args[args.indexOf('-vf') + 1], /^yadif=mode=send_field:deint=all,/);
});
