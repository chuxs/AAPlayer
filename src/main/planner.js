'use strict';
/*
 * Playback planner.
 *
 * Decides how a probed media file reaches the Chromium <video> element:
 *   direct    - Chromium opens the file itself (native seeking).
 *   remux     - FFmpeg copies the video into fragmented MP4, audio is copied
 *               or re-encoded to AAC. Cheap: no video decoding at all.
 *   transcode - FFmpeg decodes and re-encodes video to 8-bit 4:2:0 H.264.
 *
 * This is where AAPlayer handles "10bit" releases. The decision is made from
 * the real stream properties reported by ffprobe (codec, profile, pixel
 * format, bit depth, chroma, transfer), never from the file name:
 *   - 10-bit H.264 (High 10 / "Hi10P", common in anime releases) has no
 *     hardware decoder on any GPU; it is copied only if this Chromium can
 *     decode it in software, otherwise transcoded.
 *   - 10-bit HEVC / VP9 / AV1 are copied only when this machine's Chromium
 *     reports it can decode them; otherwise they are transcoded.
 *   - If a copied stream later fails, stalls, or decodes too slowly, the
 *     renderer escalates to 'compat' mode, which always transcodes to 8-bit.
 */

const DIRECT_CONTAINERS = ['mov', 'mp4', 'm4a', '3gp', 'webm', 'mp3', 'flac', 'ogg', 'wav'];

const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);

// Audio codecs that can be copied into fragmented MP4 and decoded by Chromium.
const MP4_AUDIO = new Set(['aac', 'mp3', 'opus', 'flac']);

function videoCodecKey(v) {
  const depth = v.bitDepth > 8 ? '_10' : '';
  switch (v.codec) {
    case 'h264': return 'h264' + depth;
    case 'hevc': return 'hevc' + depth;
    case 'vp9': return 'vp9' + depth;
    case 'av1': return 'av1' + depth;
    case 'vp8': return 'vp8';
    default: return null;
  }
}

/** Returns { copy: boolean, reason: string } for a video stream. */
function canCopyVideo(v, caps, deinterlace = 'auto') {
  if (v.bitDepth > 10)
    return { copy: false, reason: `${v.bitDepth}-bit video is not decodable by Chromium` };
  if (v.chroma !== '420')
    return { copy: false, reason: `4:${v.chroma.slice(1, 2)}:${v.chroma.slice(2)} chroma is not decodable by Chromium` };
  if (v.codec === 'h264' && v.bitDepth > 8) {
    // No GPU decodes 10-bit H.264. Recent Chromium decodes it in software;
    // older builds cannot, and slow machines are caught by the watchdog.
    return caps.video.h264_10
      ? { copy: true, reason: 'H.264 High 10 (10-bit "Hi10P") is decoded in software by Chromium (no GPU supports it)' }
      : { copy: false, reason: 'H.264 High 10 (10-bit "Hi10P") has no GPU decoder and Chromium cannot decode it here' };
  }
  if (v.interlaced && deinterlace !== 'off')
    return { copy: false, reason: 'interlaced video needs deinterlacing' };
  const key = videoCodecKey(v);
  if (!key)
    return { copy: false, reason: `${v.codec} is not a browser codec` };
  if (!caps.video[key])
    return { copy: false, reason: `this machine cannot decode ${describeVideo(v)} natively` };
  return { copy: true, reason: `${describeVideo(v)} is decoded natively` };
}

function canCopyAudio(a, caps, container) {
  if (a.channels > 8)
    return { copy: false, reason: `${a.channels} channels` };
  if (MP4_AUDIO.has(a.codec) && caps.audio[a.codec] !== false)
    return { copy: true, reason: `${a.codec} is decoded natively` };
  if (a.codec === 'vorbis' && container === 'webm' && caps.audio.vorbis)
    return { copy: true, reason: 'vorbis is decoded natively' };
  if ((a.codec === 'ac3' || a.codec === 'eac3') && caps.audio[a.codec])
    return { copy: true, reason: `${a.codec} is decoded natively` };
  return { copy: false, reason: `${a.codec} is not a browser audio codec` };
}

function describeVideo(v) {
  const names = { h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8', mpeg2video: 'MPEG-2',
    mpeg4: 'MPEG-4 Part 2', vc1: 'VC-1', wmv3: 'WMV9', mjpeg: 'MJPEG', prores: 'ProRes' };
  const parts = [names[v.codec] || v.codec];
  if (v.profile) parts.push(v.profile);
  parts.push(`${v.bitDepth}-bit`);
  if (v.isHDR) parts.push('HDR');
  return parts.join(' ');
}

function containerKind(info) {
  const fmt = (info.formatName || '').split(',');
  const ext = (info.ext || '').toLowerCase();
  if (fmt.includes('matroska') && ext === 'webm') return 'webm';
  if (fmt.includes('matroska')) return 'matroska';
  if (fmt.includes('mov') || fmt.includes('mp4')) return 'mp4';
  for (const f of fmt) if (DIRECT_CONTAINERS.includes(f)) return f;
  return fmt[0] || 'unknown';
}

/**
 * @param info  normalized probe result (see probe.js)
 * @param caps  { video: {h264, h264_10, hevc, hevc_10, vp9, vp9_10, av1, av1_10, vp8},
 *                audio: {aac, mp3, opus, flac, vorbis, ac3, eac3} }
 * @param opts  { mode: 'auto'|'compat'|'direct', videoIndex, audioIndex, burnSubtitleIndex,
 *                deinterlace: 'off'|'auto'|'on', deinterlaceMode }
 */
function plan(info, caps, opts = {}) {
  const mode = opts.mode || 'auto';
  const reasons = [];
  const container = containerKind(info);
  const pictures = info.video.filter((v) => !v.attachedPic);
  const video = pictures.find((v) => v.index === opts.videoIndex) || pictures[0] || null;
  const deint = opts.deinterlace || 'auto';
  const audio = info.audio.find((a) => a.index === opts.audioIndex) || info.audio.find((a) => a.default) || info.audio[0] || null;
  const burn = opts.burnSubtitleIndex != null ? info.subs.find((s) => s.index === opts.burnSubtitleIndex) : null;

  const result = {
    kind: 'remux',
    container,
    videoIndex: video ? video.index : null,
    audioIndex: audio ? audio.index : null,
    burnSubtitleIndex: burn ? burn.index : null,
    video: { action: video ? 'copy' : 'none' },
    audio: { action: audio ? 'copy' : 'none' },
    hdrToSdr: false,
    deinterlace: false,        // false | 'interlaced' (auto) | 'all' (forced on)
    deinterlaceMode: opts.deinterlaceMode || 'bwdif',
    reasons,
  };

  if (video) {
    const vc = canCopyVideo(video, caps, deint);
    if (mode === 'compat') {
      result.video.action = 'encode';
      reasons.push(`Compatibility mode: ${describeVideo(video)} re-encoded to 8-bit H.264`);
    } else if (deint === 'on') {
      result.video.action = 'encode';
      reasons.push('Deinterlacing forced on -> re-encoded');
    } else if (burn) {
      result.video.action = 'encode';
      reasons.push(`Burning in ${burn.codec} subtitles requires re-encoding the video`);
    } else if (!vc.copy) {
      result.video.action = 'encode';
      reasons.push(`Video: ${vc.reason} -> re-encoded to 8-bit H.264`);
    } else {
      reasons.push(`Video: ${vc.reason}`);
    }
    if (result.video.action === 'encode') {
      result.hdrToSdr = video.isHDR;
      result.deinterlace = deint === 'on' ? 'all' : deint === 'auto' && video.interlaced ? 'interlaced' : false;
    }
  }

  if (audio) {
    const ac = canCopyAudio(audio, caps, container);
    if (!ac.copy) {
      result.audio.action = 'encode';
      reasons.push(`Audio: ${ac.reason} -> re-encoded to AAC`);
    } else {
      reasons.push(`Audio: ${ac.reason}`);
    }
  }

  const firstAudio = info.audio[0];
  const directContainer = container === 'mp4' || container === 'webm' ||
    (!video && ['mp3', 'flac', 'ogg', 'wav', 'mp4', 'webm'].includes(container));
  const audioIsFirst = (!audio || audio === firstAudio) && (!video || video === pictures[0]);
  const wavPcm = audio && container === 'wav' && /^pcm_(s16le|s24le|f32le|u8)$/.test(audio.codec);
  const audioDirectOk = !audio || result.audio.action === 'copy' || wavPcm ||
    (audio.codec === 'vorbis' && container === 'ogg');

  if (mode !== 'compat' && result.video.action !== 'encode' && directContainer &&
      audioIsFirst && audioDirectOk && !info.isUrlStream) {
    result.kind = 'direct';
    reasons.unshift(`Direct playback (${container} container)`);
  } else if (result.video.action === 'encode') {
    result.kind = 'transcode';
  } else {
    result.kind = 'remux';
    if (!video) reasons.unshift(`Streaming ${container} audio through FFmpeg`);
    else if (!directContainer) reasons.unshift(`Remuxing ${container} to fragmented MP4 (no video re-encode)`);
    else if (!audioIsFirst) reasons.unshift('Remuxing to switch audio track');
    else reasons.unshift('Remuxing to fragmented MP4');
  }
  if (mode === 'direct' && result.kind !== 'direct') {
    // The user forced direct playback: hand the file to Chromium as-is.
    result.kind = 'direct';
    result.video.action = video ? 'copy' : 'none';
    result.audio.action = audio ? 'copy' : 'none';
    reasons.unshift('Direct playback forced by user (may fail)');
  }
  return result;
}

/** Picks the video encoder from those detected on this machine. */
function pickEncoder(encoders, preferred) {
  const order = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'];
  if (preferred && preferred !== 'auto' && encoders.includes(preferred)) return preferred;
  return order.find((e) => encoders.includes(e)) || 'libx264';
}

function encoderArgs(encoder, fps, quality) {
  const gop = String(Math.max(12, Math.round((fps || 24) * 2)));
  const q = quality === 'high' ? 0 : quality === 'fast' ? 4 : 2;
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(19 + q), '-b:v', '0',
        '-profile:v', 'high', '-g', gop, '-bf', '2'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', String(20 + q),
        '-look_ahead', '0', '-profile:v', 'high', '-g', gop];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', String(18 + q),
        '-qp_p', String(20 + q), '-profile:v', 'high', '-g', gop];
    default:
      return ['-c:v', 'libx264', '-preset', quality === 'fast' ? 'superfast' : 'veryfast',
        '-crf', String(18 + q), '-profile:v', 'high', '-g', gop, '-threads', '0'];
  }
}

// VLC's Video > Deinterlace mode list, mapped to FFmpeg deinterlacers.
const DEINTERLACE_MODES = {
  bwdif: (d) => `bwdif=mode=send_frame:deint=${d}`,
  bwdif2x: (d) => `bwdif=mode=send_field:deint=${d}`,
  yadif: (d) => `yadif=mode=send_frame:deint=${d}`,
  yadif2x: (d) => `yadif=mode=send_field:deint=${d}`,
  w3fdif: (d) => `w3fdif=deint=${d}`,
  linear: (d) => `yadif=mode=send_frame_nospatial:deint=${d}`,
};
function deinterlaceFilter(mode, which) {
  return (DEINTERLACE_MODES[mode] || DEINTERLACE_MODES.bwdif)(which === 'all' ? 'all' : 'interlaced');
}

/**
 * Builds the video filter chain for re-encoding. Always ends in an 8-bit
 * 4:2:0 format: dithered 10->8 bit conversion is the actual fix for 10-bit
 * sources that the display path cannot handle.
 */
function videoFilters(p, video, encoder, tools, maxHeight) {
  const f = [];
  if (p.deinterlace) f.push(deinterlaceFilter(p.deinterlaceMode, p.deinterlace));
  if (maxHeight && video && video.height > maxHeight) f.push(`scale=-2:${maxHeight}:flags=bicubic`);
  if (p.hdrToSdr && tools.hasZscale && tools.hasTonemap) {
    f.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  }
  const hwUpload = encoder === 'h264_qsv' || encoder === 'h264_amf';
  f.push(`format=${hwUpload ? 'nv12' : 'yuv420p'}`);
  return f.join(',');
}

/**
 * Builds the ffmpeg argument list that streams fragmented MP4 to stdout.
 * @param p      plan() result
 * @param info   probe result
 * @param start  start position in seconds (already snapped to a keyframe for copy)
 * @param tools  { encoders: [], hasZscale, hasTonemap, preferredEncoder, quality, maxHeight }
 */
function buildStreamArgs(p, info, start, tools) {
  const video = info.video.find((v) => v.index === p.videoIndex);
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-fflags', '+genpts'];
  if (start > 0) {
    if (p.video.action === 'copy') {
      // `start` is a keyframe. ffmpeg backs input seeks off by 3/23 s for
      // formats that seek by DTS (e.g. Matroska), which would land on the
      // previous keyframe and shift the timeline by seconds, so aim just past it.
      args.push('-ss', (start + 0.2).toFixed(3), '-noaccurate_seek');
    } else {
      args.push('-ss', start.toFixed(3));
    }
  }
  args.push('-i', info.input);

  const encoder = p.video.action === 'encode' ? pickEncoder(tools.encoders || [], tools.preferredEncoder) : null;
  if (p.video.action === 'encode' && p.burnSubtitleIndex != null) {
    const chain = videoFilters(p, video, encoder, tools, tools.maxHeight);
    args.push('-filter_complex',
      `[0:${p.videoIndex}][0:${p.burnSubtitleIndex}]overlay=eof_action=pass:repeatlast=0,${chain}[v]`,
      '-map', '[v]');
  } else if (p.videoIndex != null) {
    args.push('-map', `0:${p.videoIndex}`);
    if (p.video.action === 'encode') args.push('-vf', videoFilters(p, video, encoder, tools, tools.maxHeight));
  }
  if (p.audioIndex != null) args.push('-map', `0:${p.audioIndex}`);

  if (p.video.action === 'copy') {
    args.push('-c:v', 'copy');
    if (video && video.codec === 'hevc') args.push('-tag:v', 'hvc1');
  } else if (p.video.action === 'encode') {
    args.push(...encoderArgs(encoder, video && video.fps, tools.quality));
    args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  }

  if (p.audioIndex != null) {
    const audio = info.audio.find((a) => a.index === p.audioIndex);
    if (p.audio.action === 'copy') {
      args.push('-c:a', 'copy');
    } else {
      const ch = Math.min(audio.channels || 2, 8);
      args.push('-c:a', 'aac', '-b:a', ch > 2 ? '384k' : '192k', '-ac', String(ch));
    }
  }

  args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-max_muxing_queue_size', '2048', '-avoid_negative_ts', 'make_zero',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '1000000', 'pipe:1');
  return { args, encoder };
}

const H264_PROFILE_IDC = { 'Baseline': 66, 'Constrained Baseline': 66, 'Main': 77, 'Extended': 88, 'High': 100,
  'High 10': 110, 'High 10 Intra': 110, 'High 4:2:2': 122, 'High 4:4:4 Predictive': 244 };
const hex2 = (n) => Number(n).toString(16).toUpperCase().padStart(2, '0');
const dec2 = (n) => String(n).padStart(2, '0');

function videoCodecString(v) {
  const level = v.level > 0 ? v.level : 0;
  switch (v.codec) {
    case 'h264': return `avc1.${hex2(H264_PROFILE_IDC[v.profile] || 100)}00${hex2(level || 51)}`;
    case 'hevc': return /10/.test(v.profile) || v.bitDepth > 8 ? `hvc1.2.4.L${level || 153}.B0` : `hvc1.1.6.L${level || 153}.B0`;
    case 'vp9': return `vp09.${v.bitDepth > 8 ? '02' : '00'}.${dec2(level > 0 && level < 100 ? level : 40)}.${dec2(v.bitDepth)}`;
    case 'av1': return `av01.0.${dec2(level >= 0 && level < 32 ? level : 8)}M.${dec2(v.bitDepth)}`;
    default: return v.codec;
  }
}

function audioCodecString(a) {
  switch (a.codec) {
    case 'aac': return a.profile === 'HE-AACv2' ? 'mp4a.40.29' : a.profile === 'HE-AAC' ? 'mp4a.40.5' : 'mp4a.40.2';
    case 'mp3': return 'mp4a.69';
    case 'ac3': return 'ac-3';
    case 'eac3': return 'ec-3';
    default: return a.codec; // opus, flac
  }
}

/** MIME type with codecs for the fragmented MP4 that buildStreamArgs produces (used for MSE). */
function streamMime(p, info) {
  const v = info.video.find((x) => x.index === p.videoIndex);
  const a = info.audio.find((x) => x.index === p.audioIndex);
  const codecs = [];
  if (v) codecs.push(p.video.action === 'encode' ? 'avc1.640033' : videoCodecString(v));
  if (a) codecs.push(p.audio.action === 'encode' ? 'mp4a.40.2' : audioCodecString(a));
  return `${v ? 'video' : 'audio'}/mp4; codecs="${codecs.join(', ')}"`;
}

module.exports = { plan, buildStreamArgs, streamMime, videoCodecString, encoderArgs, videoFilters, canCopyVideo, canCopyAudio, pickEncoder, describeVideo, containerKind, HDR_TRANSFERS };
