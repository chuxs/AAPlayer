'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildConvertArgs } = require('../src/main/convert');
const { listTitles, detect } = require('../src/main/disc');
const { normalizeProbe } = require('../src/main/probe');

const info = normalizeProbe({
  format: { format_name: 'matroska,webm', duration: '600' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le', width: 1920, height: 808, avg_frame_rate: '24000/1001' },
    { index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 6, sample_rate: '48000' },
    { index: 2, codec_type: 'subtitle', codec_name: 'subrip' },
  ],
}, 'C:/v/movie.mkv');
const tools = { encoders: ['h264_qsv', 'libx264'], hevcEncoders: ['hevc_qsv', 'libx265'] };
const after = (args, flag) => args[args.indexOf(flag) + 1];

test('convert: H.264 is 8-bit via QSV, audio to AAC, progress to stdout', () => {
  const a = buildConvertArgs(info, { profile: 'h264-mp4', output: 'o.mp4', start: 10, end: 70, quality: 'balanced' }, tools);
  assert.equal(after(a, '-ss'), '10.000');
  assert.equal(after(a, '-t'), '60.000');
  assert.equal(after(a, '-c:v'), 'h264_qsv');
  assert.match(after(a, '-vf'), /format=nv12$/);
  assert.equal(after(a, '-c:a'), 'aac');
  assert.deepEqual(a.slice(-4), ['-progress', 'pipe:1', '-nostats', 'o.mp4']);
});

test('convert: HEVC keeps 10-bit; remux and audio profiles', () => {
  const h = buildConvertArgs(info, { profile: 'h265-mp4', output: 'o.mp4' }, tools);
  assert.equal(after(h, '-c:v'), 'hevc_qsv');
  assert.match(after(h, '-vf'), /format=p010le$/);
  assert.equal(after(h, '-profile:v'), 'main10');
  const sw = buildConvertArgs(info, { profile: 'h265-mp4', output: 'o.mp4' }, { hevcEncoders: ['libx265'] });
  assert.match(after(sw, '-vf'), /format=yuv420p10le$/);
  const mkv = buildConvertArgs(info, { profile: 'copy-mkv', output: 'o.mkv' }, tools);
  assert.equal(after(mkv, '-map'), '0');
  const mp4 = buildConvertArgs(info, { profile: 'copy-mp4', output: 'o.mp4' }, tools);
  assert.equal(after(mp4, '-c:v'), 'copy');
  assert.equal(after(mp4, '-tag:v'), 'hvc1');
  const mp3 = buildConvertArgs(info, { profile: 'mp3', output: 'o.mp3' }, tools);
  assert.equal(after(mp3, '-c:a'), 'libmp3lame');
  assert.equal(after(mp3, '-ac'), '2');
  assert.throws(() => buildConvertArgs({ ...info, audio: [] }, { profile: 'flac', output: 'o.flac' }, tools), /no audio/);
});

test('disc: DVD title sets and Blu-ray streams', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aap-disc-'));
  const vts = path.join(root, 'DVD', 'VIDEO_TS');
  fs.mkdirSync(vts, { recursive: true });
  fs.writeFileSync(path.join(vts, 'VTS_01_0.VOB'), Buffer.alloc(10)); // menu: ignored
  fs.writeFileSync(path.join(vts, 'VTS_01_1.VOB'), Buffer.alloc(3000));
  fs.writeFileSync(path.join(vts, 'VTS_01_2.VOB'), Buffer.alloc(3000));
  fs.writeFileSync(path.join(vts, 'VTS_02_1.VOB'), Buffer.alloc(100));
  const dvd = await listTitles(path.join(root, 'DVD'));
  assert.equal(dvd.type, 'dvd');
  assert.equal(dvd.titles[0].id, '01');
  assert.equal(dvd.titles[0].input, `concat:${path.join(vts, 'VTS_01_1.VOB')}|${path.join(vts, 'VTS_01_2.VOB')}`);
  assert.equal((await detect(vts)).type, 'dvd');

  const stream = path.join(root, 'BD', 'BDMV', 'STREAM');
  fs.mkdirSync(stream, { recursive: true });
  fs.writeFileSync(path.join(stream, '00001.m2ts'), Buffer.alloc(21 * 1024 * 1024));
  fs.writeFileSync(path.join(stream, '00002.m2ts'), Buffer.alloc(1024));
  fs.mkdirSync(path.join(root, 'BD', 'AACS'));
  const bd = await listTitles(path.join(root, 'BD'));
  assert.equal(bd.type, 'bluray');
  assert.equal(bd.protected, true);
  assert.equal(bd.titles.length, 1);
  await assert.rejects(listTitles(root), /No VIDEO_TS/);
});
