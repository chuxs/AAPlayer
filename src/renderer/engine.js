/* AAPlayer playback engine.
 *
 * Wraps the <video> element and the main-process planner:
 *  - direct sessions play the file natively (native seeking);
 *  - remux/transcode sessions play an ffmpeg fMP4 stream that starts at
 *    `offset`, so media time = offset + video.currentTime, and seeks outside
 *    the buffered range restart the stream at the new position.
 *
 * The watchdog is AAPlayer's answer to VLC's "10bit hang": decoding happens
 * outside the UI (ffmpeg process / Chromium GPU process), and if the picture
 * stops advancing or the decoder reports an error, the engine restarts the
 * stream and then escalates to compatibility mode (8-bit H.264 transcode),
 * instead of freezing the player.
 */
(function () {
  'use strict';

  function detectCaps() {
    const ms = (t) => { try { return MediaSource.isTypeSupported(t); } catch { return false; } };
    return {
      video: {
        h264: ms('video/mp4; codecs="avc1.640028"'),
        h264_10: ms('video/mp4; codecs="avc1.6E0028"'),
        hevc: ms('video/mp4; codecs="hvc1.1.6.L120.90"'),
        hevc_10: ms('video/mp4; codecs="hvc1.2.4.L120.90"'),
        vp9: ms('video/webm; codecs="vp09.00.40.08"'),
        vp9_10: ms('video/webm; codecs="vp09.02.40.10"'),
        av1: ms('video/mp4; codecs="av01.0.08M.08"'),
        av1_10: ms('video/mp4; codecs="av01.0.08M.10"'),
        vp8: ms('video/webm; codecs="vp8"'),
      },
      audio: {
        aac: ms('audio/mp4; codecs="mp4a.40.2"'),
        mp3: ms('audio/mpeg'),
        opus: ms('audio/webm; codecs="opus"'),
        flac: ms('audio/mp4; codecs="flac"'),
        vorbis: ms('audio/webm; codecs="vorbis"'),
        ac3: ms('audio/mp4; codecs="ac-3"'),
        eac3: ms('audio/mp4; codecs="ec-3"'),
      },
    };
  }

  /*
   * Feeds an ffmpeg fragmented-MP4 stream into Media Source Extensions.
   * Compared to a plain progressive <video src>, this makes the stream
   * seekable within what has been downloaded (exact seeks, instant short
   * jumps), and bounds memory: reading pauses ~60 s ahead of playback (TCP
   * backpressure then pauses ffmpeg) and already-played data is evicted.
   */
  class MseFeeder {
    constructor(video, url, mime, duration, onFail) {
      this.video = video;
      this.url = url;
      this.mime = mime;
      this.onFail = onFail;
      this.queue = [];
      this.queued = 0;
      this.done = false;
      this.closed = false;
      this.appended = 0;
      this.ms = new MediaSource();
      this.objectUrl = URL.createObjectURL(this.ms);
      this.ms.addEventListener('sourceopen', () => this.open(duration), { once: true });
      video.src = this.objectUrl;
    }

    async open(duration) {
      try {
        this.sb = this.ms.addSourceBuffer(this.mime);
        if (duration > 0) this.ms.duration = duration;
      } catch (e) { this.fail(e); return; }
      this.sb.addEventListener('updateend', () => this.pump());
      this.sb.addEventListener('error', () => this.fail(new Error('SourceBuffer append error')));
      this.abort = new AbortController();
      try {
        const res = await fetch(this.url, { signal: this.abort.signal });
        if (!res.ok || !res.body) throw new Error(`stream request failed (${res.status})`);
        this.reader = res.body.getReader();
      } catch (e) { if (!this.closed) this.fail(e); return; }
      this.readLoop();
    }

    aheadSeconds() {
      const v = this.video;
      const b = v.buffered;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= v.currentTime + 0.5 && b.end(i) >= v.currentTime) return b.end(i) - v.currentTime;
      }
      return 0;
    }

    async readLoop() {
      while (!this.closed) {
        while (!this.closed && (this.aheadSeconds() > 60 || this.queued > 24e6)) {
          await new Promise((r) => setTimeout(r, 250));
        }
        if (this.closed) return;
        let r;
        try { r = await this.reader.read(); } catch (e) { if (!this.closed) this.fail(e); return; }
        if (r.done) { this.done = true; this.pump(); return; }
        this.queue.push(r.value);
        this.queued += r.value.byteLength;
        this.pump();
      }
    }

    pump() {
      if (this.closed || !this.sb || this.sb.updating || this.ms.readyState !== 'open') return;
      const v = this.video;
      const b = this.sb.buffered;
      if (b.length && v.currentTime - b.start(0) > 90) {
        try { this.sb.remove(0, v.currentTime - 30); return; } catch { /* retry on next pump */ }
      }
      if (this.queue.length) {
        const chunk = this.queue.length === 1 ? this.queue[0] : concat(this.queue, this.queued);
        this.queue = [];
        this.queued = 0;
        try {
          this.sb.appendBuffer(chunk);
          this.appended += chunk.byteLength;
        } catch (e) {
          if (e.name === 'QuotaExceededError') {
            this.queue.unshift(chunk);
            this.queued += chunk.byteLength;
            try { this.sb.remove(0, Math.max(0, v.currentTime - 2)); } catch { /* wait for updateend */ }
          } else this.fail(e);
        }
        return;
      }
      if (this.done) { try { this.ms.endOfStream(); } catch { /* already ended */ } }
    }

    fail(e) {
      if (this.closed) return;
      this.close();
      this.onFail(e, this.appended);
    }

    close() {
      this.closed = true;
      try { if (this.abort) this.abort.abort(); } catch { /* ignore */ }
      URL.revokeObjectURL(this.objectUrl);
    }
  }

  function concat(chunks, total) {
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.byteLength; }
    return out;
  }

  const STALL_LIMIT_DIRECT = 8;     // seconds without progress before recovering
  const STALL_LIMIT_STREAM = 15;    // ffmpeg needs time to start / fill a fragment
  const FROZEN_FRAMES_LIMIT = 6;    // time advances but no new video frames

  class Engine extends EventTarget {
    constructor(video) {
      super();
      this.video = video;
      this.caps = detectCaps();
      this.session = null;      // result of aap.prepare()
      this.input = null;
      this.opts = {};
      this.offset = 0;
      this.loadToken = 0;
      this.recoveries = 0;
      this.watch = { last: -1, stalled: 0, frames: -1, frozen: 0, started: false };
      this.wantPlaying = false;
      video.addEventListener('error', () => this.onVideoError());
      video.addEventListener('ended', () => this.onEnded());
      video.addEventListener('playing', () => { this.watch.started = true; });
      for (const ev of ['progress', 'loadeddata', 'timeupdate']) video.addEventListener(ev, () => this.applyPendingSeek());
      setInterval(() => this.tick(), 1000);
    }

    applyPendingSeek() {
      const rel = this.pendingSeek;
      if (rel == null || !this.feeder || this.video.readyState < 1) return;
      if (inBuffered(this.video.buffered, rel)) {
        this.pendingSeek = null;
        this.video.currentTime = rel;
      } else if (this.video.currentTime > rel) {
        this.pendingSeek = null;
      }
    }

    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

    get info() { return this.session ? this.session.info : null; }
    get kind() { return this.session ? this.session.plan.kind : null; }
    get time() { return this.session ? this.offset + (this.video.currentTime || 0) : 0; }
    get duration() {
      const d = this.info && this.info.duration;
      if (d > 0) return d;
      return Number.isFinite(this.video.duration) ? this.video.duration : 0;
    }
    get hasVideo() { return !!(this.info && this.info.video.some((v) => !v.attachedPic)); }

    /** Opens `input` (path or URL). opts: { start, mode, audioIndex, burnSubtitleIndex, maxHeight, autoplay } */
    async load(input, opts = {}) {
      const token = ++this.loadToken;
      this.stopCapture();
      if (input !== this.input) this.recoveries = 0;
      this.input = input;
      this.opts = { ...opts };
      this.emit('loading', { input });
      let session;
      try {
        session = await window.aap.prepare(input, {
          start: opts.start || 0, mode: opts.mode, videoIndex: opts.videoIndex, audioIndex: opts.audioIndex,
          burnSubtitleIndex: opts.burnSubtitleIndex, maxHeight: opts.maxHeight,
        }, this.caps);
      } catch (e) {
        if (token === this.loadToken) this.emit('fatal', { message: cleanError(e) });
        return null;
      }
      if (token !== this.loadToken) return null; // superseded by a newer load
      this.session = session;
      this.offset = session.offset;
      this.resetWatch();
      const v = this.video;
      this.closeFeeder();
      const useMse = session.plan.kind !== 'direct' && session.mime && !this.mseBroken &&
        window.MediaSource && MediaSource.isTypeSupported(session.mime);
      if (useMse) {
        const remaining = session.info.duration > 0 ? session.info.duration - session.offset : 0;
        this.feeder = new MseFeeder(v, session.url, session.mime, remaining, (e, appended) => {
          if (token !== this.loadToken) return;
          window.aap.log('engine', `MSE streaming failed (${e.message}, ${appended} bytes appended, ${session.mime}); using progressive streaming`);
          this.mseBroken = true;
          this.reload({}, null);
        });
      } else {
        if (session.plan.kind !== 'direct') window.aap.log('engine', `progressive streaming (${session.mime || 'no mime'})`);
        v.src = session.url;
      }
      const autoplay = opts.autoplay !== false;
      this.wantPlaying = autoplay;
      if (session.plan.kind === 'direct' && opts.start > 0) {
        v.addEventListener('loadedmetadata', () => { v.currentTime = opts.start; }, { once: true });
      }
      // A stream-copy session starts at the keyframe before the requested
      // time (HEVC keyframes can be 10 s apart): skip ahead to the exact
      // position as soon as that part of the stream has arrived.
      this.pendingSeek = session.plan.kind !== 'direct' && opts.start > session.offset + 0.3
        ? opts.start - session.offset : null;
      if (autoplay) v.play().catch(() => {});
      this.emit('loaded', session);
      return session;
    }

    /**
     * Plays a live MediaStream from a capture device (Media > Open Capture Device).
     * No FFmpeg involved; the stream's tracks are stopped (camera off) on stop/next load.
     */
    loadCapture(stream, label, hasAudio) {
      this.loadToken++;
      this.closeFeeder();
      this.stopCapture();
      const v = this.video;
      v.removeAttribute('src');
      this.captureStream = stream;
      this.input = `capture://${label}`;
      this.opts = {};
      this.offset = 0;
      this.pendingSeek = null;
      const track = stream.getVideoTracks()[0];
      const st = track ? track.getSettings() : {};
      this.session = {
        info: {
          input: this.input, name: label, title: label, duration: 0, startTime: 0, formatName: 'capture', formatLongName: 'Live capture device',
          size: 0, bitRate: 0, chapters: [], subs: [], isUrlStream: true,
          video: track ? [{ index: 0, codec: 'live', profile: '', pixFmt: '', bitDepth: 8, chroma: '420', width: st.width || 0, height: st.height || 0,
            fps: st.frameRate || 0, isHDR: false, interlaced: false, attachedPic: false, title: track.label, lang: '' }] : [],
          audio: hasAudio ? [{ index: 1, codec: 'live', profile: '', channels: 2, layout: '', sampleRate: 48000, title: stream.getAudioTracks()[0].label, lang: '' }] : [],
        },
        plan: { kind: 'capture', videoIndex: track ? 0 : null, audioIndex: hasAudio ? 1 : null, video: { action: 'copy' }, audio: { action: 'copy' },
          reasons: ['Live capture device (played directly, nothing is recorded unless you press Record)'] },
        url: null, thumbUrl: null, offset: 0, encoder: null, mode: 'capture', externalSubs: [], resume: 0, mime: null,
      };
      v.srcObject = stream;
      this.wantPlaying = true;
      v.play().catch(() => {});
      for (const t of stream.getTracks()) t.addEventListener('ended', () => { if (this.captureStream === stream) this.emit('notice', { message: 'Capture device disconnected' }); });
      this.emit('loaded', this.session);
      return this.session;
    }

    stopCapture() {
      if (!this.captureStream) return;
      for (const t of this.captureStream.getTracks()) t.stop();
      this.captureStream = null;
      this.video.srcObject = null;
    }

    /** Reloads the current input at the current position with changed options. */
    reload(patch = {}, reason) {
      if (!this.input || this.kind === 'capture') return null;
      const opts = { ...this.opts, ...patch, start: patch.start !== undefined ? patch.start : this.time,
        autoplay: patch.autoplay !== undefined ? patch.autoplay : !this.video.paused || this.wantPlaying };
      if (reason) this.emit('notice', { message: reason });
      return this.load(this.input, opts);
    }

    play() { this.wantPlaying = true; return this.video.play().catch(() => {}); }
    pause() { this.wantPlaying = false; this.video.pause(); }

    closeFeeder() {
      if (this.feeder) { this.feeder.close(); this.feeder = null; }
    }

    stop() {
      this.loadToken++;
      this.wantPlaying = false;
      this.session = null;
      this.input = null;
      this.pendingSeek = null;
      this.closeFeeder();
      this.stopCapture();
      this.video.removeAttribute('src');
      this.video.load();
      window.aap.stopMedia();
      this.emit('stopped');
    }

    seek(t) {
      if (!this.session || this.kind === 'capture') return;
      const d = this.duration;
      t = Math.max(0, d > 0 ? Math.min(t, d - 0.25) : t);
      if (this.kind === 'direct') {
        this.video.currentTime = t;
      } else {
        // Only MSE streams are seekable; a progressive pipe stream is not.
        const rel = t - this.offset;
        if (this.feeder && rel >= 0 && inBuffered(this.video.buffered, rel)) {
          this.pendingSeek = null;
          this.video.currentTime = rel;
        } else this.reload({ start: t });
      }
      this.resetWatch();
      this.emit('seeked', { time: t });
    }

    setRate(rate) { this.video.playbackRate = rate; this.video.defaultPlaybackRate = rate; }

    resetWatch() {
      this.watch = { last: -1, stalled: 0, frames: -1, frozen: 0, started: false };
    }

    /** Called once per second: detects stalled or frozen playback. */
    tick() {
      const v = this.video;
      if (!this.session || this.kind === 'capture' || !this.wantPlaying || v.ended || document.hidden && v.paused) return;
      if (v.paused && !v.seeking) return;
      const w = this.watch;
      const now = v.currentTime;
      if (now !== w.last) { w.last = now; w.stalled = 0; }
      else w.stalled++;

      let tooSlow = false;
      if (this.hasVideo && typeof v.getVideoPlaybackQuality === 'function') {
        const q = v.getVideoPlaybackQuality();
        const frames = q.totalVideoFrames;
        if (w.stalled === 0 && frames === w.frames && v.readyState >= 2) w.frozen++;
        else w.frozen = 0;
        // Track dropped frames over a sliding ~8 s window: a decoder that
        // cannot keep up (e.g. 10-bit software decoding on a slow CPU).
        w.window = (w.window || []).concat([[q.totalVideoFrames, q.droppedVideoFrames]]).slice(-8);
        if (w.window.length === 8 && v.playbackRate <= 1.01) {
          const total = w.window[7][0] - w.window[0][0];
          const dropped = w.window[7][1] - w.window[0][1];
          tooSlow = total > 40 && dropped / total > 0.35;
        }
        w.frames = frames;
      }

      const limit = this.kind === 'direct' ? STALL_LIMIT_DIRECT : STALL_LIMIT_STREAM;
      if (w.stalled >= limit) {
        this.recover(`Playback stalled for ${w.stalled}s`);
      } else if (w.frozen >= FROZEN_FRAMES_LIMIT) {
        this.recover('Video decoder stopped producing frames', true);
      } else if (tooSlow && (this.opts.mode || this.session.mode) !== 'compat') {
        this.recover('Video decoding cannot keep up (dropping frames)', true);
      }
    }

    onVideoError() {
      if (!this.session || !this.video.getAttribute('src')) return;
      const err = this.video.error;
      const names = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'format not supported' };
      const what = err ? `${names[err.code] || 'error'}${err.message ? `: ${err.message}` : ''}` : 'unknown error';
      window.aap.log('engine', `media element error (${what}) in ${this.kind} mode`);
      this.recover(`Playback failed (${what})`, err && (err.code === 3 || err.code === 4));
    }

    onEnded() {
      if (!this.session) return;
      // A streamed session that ends well before the real end means ffmpeg died.
      const d = this.duration;
      if (this.kind !== 'direct' && d > 0 && this.time < d - 5) {
        this.recover(`Stream ended early at ${fmtTime(this.time)}`);
        return;
      }
      this.emit('ended');
    }

    /**
     * Recovery ladder: (1) restart the same session at the current position,
     * (2) switch to compatibility mode (8-bit H.264 transcode),
     * (3) compatibility mode at 720p with a faster preset, (4) give up.
     */
    recover(reason, decoderProblem) {
      const pos = this.time;
      this.recoveries++;
      const mode = this.opts.mode || this.session.mode;
      window.aap.log('engine', `${reason}; recovery #${this.recoveries} (mode ${mode}, ${this.kind})`);
      if (mode !== 'compat' && (decoderProblem || this.recoveries >= 2)) {
        this.reload({ start: pos, mode: 'compat', autoplay: true },
          `${reason}. Switching to compatibility mode (converting to 8-bit H.264)…`);
      } else if (this.recoveries <= 1 || (mode === 'compat' && this.recoveries === 2)) {
        this.reload({ start: pos, autoplay: true }, `${reason}. Restarting playback…`);
      } else if (!this.opts.maxHeight || this.opts.maxHeight > 720) {
        this.reload({ start: pos, mode: 'compat', maxHeight: 720, autoplay: true },
          `${reason}. Converting at 720p so this machine can keep up…`);
      } else {
        this.wantPlaying = false;
        this.video.pause();
        this.emit('fatal', { message: `${reason}. AAPlayer could not recover playback of this file.` });
      }
    }
  }

  function inBuffered(ranges, t) {
    for (let i = 0; i < ranges.length; i++) if (t >= ranges.start(i) && t <= ranges.end(i) - 0.5) return true;
    return false;
  }

  function cleanError(e) {
    const msg = String((e && e.message) || e);
    return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
  }

  window.AAPEngine = { Engine, detectCaps, fmtTime, cleanError };
}());
