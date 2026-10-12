/* Audio processing chain (Web Audio):
 *   <video> -> delay -> stereo mode -> preamp -> 10-band EQ -> volume -> analyser -> output device
 * Equalizer bands and presets are VLC's (modules/audio_filter/equalizer_presets.h);
 * VLC stores preamp with +12 dB as "flat", here 0 dB is flat. */
(function () {
  'use strict';

  const EQ_FREQS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
  const EQ_PRESETS = {
    flat: ['Flat', 0, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
    classical: ['Classical', 0, [0, 0, 0, 0, 0, 0, -7.2, -7.2, -7.2, -9.6]],
    club: ['Club', -6, [0, 0, 8, 5.6, 5.6, 5.6, 3.2, 0, 0, 0]],
    dance: ['Dance', -7, [9.6, 7.2, 2.4, 0, 0, -5.6, -7.2, -7.2, 0, 0]],
    fullbass: ['Full bass', -7, [-8, 9.6, 9.6, 5.6, 1.6, -4, -8, -10.4, -11.2, -11.2]],
    fullbasstreble: ['Full bass and treble', -8, [7.2, 5.6, 0, -7.2, -4.8, 1.6, 8, 11.2, 12, 12]],
    fulltreble: ['Full treble', -9, [-9.6, -9.6, -9.6, -4, 2.4, 11.2, 16, 16, 16, 16.8]],
    headphones: ['Headphones', -8, [4.8, 11.2, 5.6, -3.2, -2.4, 1.6, 4.8, 9.6, 12.8, 14.4]],
    largehall: ['Large Hall', -7, [10.4, 10.4, 5.6, 5.6, 0, -4.8, -4.8, -4.8, 0, 0]],
    live: ['Live', -5, [-4.8, 0, 4, 5.6, 5.6, 5.6, 4, 2.4, 2.4, 2.4]],
    party: ['Party', -6, [7.2, 7.2, 0, 0, 0, 0, 0, 0, 7.2, 7.2]],
    pop: ['Pop', -6, [-1.6, 4.8, 7.2, 8, 5.6, 0, -2.4, -2.4, -1.6, -1.6]],
    reggae: ['Reggae', -4, [0, 0, 0, -5.6, 0, 6.4, 6.4, 0, 0, 0]],
    rock: ['Rock', -7, [8, 4.8, -5.6, -8, -3.2, 4, 8.8, 11.2, 11.2, 11.2]],
    ska: ['Ska', -6, [-2.4, -4.8, -4, 0, 4, 5.6, 8.8, 9.6, 11.2, 9.6]],
    soft: ['Soft', -7, [4.8, 1.6, 0, -2.4, 0, 4, 8, 9.6, 11.2, 12]],
    softrock: ['Soft rock', -5, [4, 4, 2.4, 0, -4, -5.6, -3.2, 0, 2.4, 8.8]],
    techno: ['Techno', -7, [8, 5.6, 0, -5.6, -4.8, 0, 8, 9.6, 9.6, 8.8]],
  };
  const STEREO_MODES = [['stereo', 'Stereo'], ['mono', 'Mono'], ['left', 'Left'], ['right', 'Right'], ['reverse', 'Reverse stereo']];
  // [L->L, R->L, L->R, R->R] gains for the 2x2 channel matrix.
  const MATRIX = { mono: [0.5, 0.5, 0.5, 0.5], left: [1, 0, 1, 0], right: [0, 1, 0, 1], reverse: [0, 1, 1, 0] };
  const dbToGain = (db) => Math.pow(10, db / 20);

  class AudioChain {
    constructor(video) {
      this.video = video;
      this.ctx = null;
      this.state = { volume: 1, eq: { enabled: false, preamp: 0, bands: EQ_FREQS.map(() => 0) }, stereo: 'stereo', delay: 0, sinkId: '' };
    }

    get available() { return !!this.ctx; }

    /** Builds the graph on first playback (an AudioContext needs a user gesture / playing media). */
    ensure() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return true; }
      try {
        const ctx = new AudioContext({ latencyHint: 'playback' });
        this.ctx = ctx;
        try { ctx.destination.channelCount = Math.min(8, ctx.destination.maxChannelCount); } catch { /* stereo output */ }
        this.src = ctx.createMediaElementSource(this.video);
        this.delayNode = ctx.createDelay(10);
        this.stereoIn = ctx.createGain();
        this.stereoOut = ctx.createGain();
        this.down = ctx.createGain();
        Object.assign(this.down, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
        this.splitter = ctx.createChannelSplitter(2);
        this.merger = ctx.createChannelMerger(2);
        this.mx = [0, 1, 2, 3].map(() => ctx.createGain());
        this.down.connect(this.splitter);
        this.splitter.connect(this.mx[0], 0); this.mx[0].connect(this.merger, 0, 0); // L->L
        this.splitter.connect(this.mx[1], 1); this.mx[1].connect(this.merger, 0, 0); // R->L
        this.splitter.connect(this.mx[2], 0); this.mx[2].connect(this.merger, 0, 1); // L->R
        this.splitter.connect(this.mx[3], 1); this.mx[3].connect(this.merger, 0, 1); // R->R
        this.merger.connect(this.stereoOut);
        this.preamp = ctx.createGain();
        this.bands = EQ_FREQS.map((f, i) => {
          const b = ctx.createBiquadFilter();
          b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
          b.frequency.value = f;
          b.Q.value = 1.1;
          return b;
        });
        this.volume = ctx.createGain();
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.75;

        this.src.connect(this.delayNode).connect(this.stereoIn);
        this.stereoOut.connect(this.preamp);
        let node = this.preamp;
        for (const b of this.bands) { node.connect(b); node = b; }
        node.connect(this.volume);
        this.volume.connect(ctx.destination);
        this.volume.connect(this.analyser);
        this.applyAll();
        return true;
      } catch (e) {
        window.aap.log('audio', `Web Audio unavailable, effects and >100% volume disabled: ${e.message}`);
        this.ctx = null;
        return false;
      }
    }

    applyAll() {
      this.setVolume(this.state.volume);
      this.setEq(this.state.eq);
      this.setStereoMode(this.state.stereo);
      this.setDelay(this.state.delay);
      if (this.state.sinkId) this.setSink(this.state.sinkId);
    }

    setVolume(v) {
      this.state.volume = v;
      if (this.ctx) { this.video.volume = 1; this.volume.gain.value = v; }
      else this.video.volume = Math.min(1, v);
    }

    setEq(eq) {
      this.state.eq = { enabled: !!eq.enabled, preamp: eq.preamp || 0, bands: eq.bands.slice(0, 10) };
      if (!this.ctx) return;
      const on = this.state.eq.enabled;
      this.preamp.gain.value = on ? dbToGain(this.state.eq.preamp) : 1;
      this.bands.forEach((b, i) => { b.gain.value = on ? this.state.eq.bands[i] : 0; });
    }

    setStereoMode(mode) {
      this.state.stereo = MATRIX[mode] ? mode : 'stereo';
      if (!this.ctx) return;
      try { this.stereoIn.disconnect(); } catch { /* not connected */ }
      if (this.state.stereo === 'stereo') {
        this.stereoIn.connect(this.stereoOut); // untouched, keeps 5.1/7.1
      } else {
        MATRIX[this.state.stereo].forEach((g, i) => { this.mx[i].gain.value = g; });
        this.stereoIn.connect(this.down);
      }
    }

    /** Audio delay in seconds (VLC's "audio track synchronization"; positive = audio later). */
    setDelay(sec) {
      this.state.delay = Math.max(0, Math.min(10, sec));
      if (this.ctx) this.delayNode.delayTime.value = this.state.delay;
    }

    async setSink(id) {
      this.state.sinkId = id || '';
      try {
        if (this.ctx && typeof this.ctx.setSinkId === 'function') await this.ctx.setSinkId(this.state.sinkId);
        else if (typeof this.video.setSinkId === 'function') await this.video.setSinkId(this.state.sinkId);
        return true;
      } catch (e) {
        window.aap.log('audio', `cannot switch audio device: ${e.message}`);
        return false;
      }
    }

    static async devices() {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        return list.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
          .map((d, i) => ({ id: d.deviceId, label: d.label || `Audio device ${i + 1}` }));
      } catch { return []; }
    }
  }

  window.AAPAudio = { AudioChain, EQ_FREQS, EQ_PRESETS, STEREO_MODES };
}());
