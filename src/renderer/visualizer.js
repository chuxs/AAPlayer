/* Audio visualizations for audio-only media (VLC: Audio > Visualizations). */
(function () {
  'use strict';

  const MODES = [['off', 'Disable'], ['spectrum', 'Spectrum'], ['scope', 'Scope'], ['vumeter', 'VU Meter']];

  class Visualizer {
    constructor(canvas) {
      this.canvas = canvas;
      this.mode = 'off';
      this.analyser = null;
      this.freq = null;
      this.wave = null;
      this.peaks = [0, 0];
      this.raf = 0;
    }

    setMode(mode, analyser) {
      this.mode = mode;
      this.analyser = analyser || this.analyser;
      cancelAnimationFrame(this.raf);
      this.canvas.hidden = mode === 'off' || !this.analyser;
      if (!this.canvas.hidden) this.loop();
    }

    loop() {
      this.raf = requestAnimationFrame(() => this.loop());
      const c = this.canvas;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(c.clientWidth * dpr));
      const h = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const g = c.getContext('2d');
      g.clearRect(0, 0, w, h);
      const a = this.analyser;
      if (!a) return;
      if (this.mode === 'spectrum') this.spectrum(g, a, w, h);
      else if (this.mode === 'scope') this.scope(g, a, w, h);
      else if (this.mode === 'vumeter') this.vumeter(g, a, w, h);
    }

    gradient(g, h) {
      const grad = g.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, '#ff8a3d');
      grad.addColorStop(1, '#ff3d6e');
      return grad;
    }

    spectrum(g, a, w, h) {
      if (!this.freq || this.freq.length !== a.frequencyBinCount) this.freq = new Uint8Array(a.frequencyBinCount);
      a.getByteFrequencyData(this.freq);
      const bars = Math.min(96, Math.floor(w / 8));
      const bw = w / bars;
      g.fillStyle = this.gradient(g, h);
      const n = this.freq.length;
      for (let i = 0; i < bars; i++) {
        // logarithmic frequency axis
        const lo = Math.floor(Math.pow(n, i / bars));
        const hi = Math.max(lo + 1, Math.floor(Math.pow(n, (i + 1) / bars)));
        let v = 0;
        for (let j = lo; j < hi && j < n; j++) v = Math.max(v, this.freq[j]);
        const bh = (v / 255) * h * 0.9;
        g.fillRect(i * bw + 1, h - bh, bw - 2, bh);
      }
    }

    scope(g, a, w, h) {
      if (!this.wave || this.wave.length !== a.fftSize) this.wave = new Uint8Array(a.fftSize);
      a.getByteTimeDomainData(this.wave);
      g.lineWidth = 2 * (window.devicePixelRatio || 1);
      g.strokeStyle = '#ff7a3d';
      g.beginPath();
      for (let i = 0; i < this.wave.length; i++) {
        const x = (i / (this.wave.length - 1)) * w;
        const y = (this.wave[i] / 255) * h;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
    }

    vumeter(g, a, w, h) {
      if (!this.wave || this.wave.length !== a.fftSize) this.wave = new Uint8Array(a.fftSize);
      a.getByteTimeDomainData(this.wave);
      let sum = 0;
      for (const s of this.wave) { const v = (s - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / this.wave.length);
      const db = 20 * Math.log10(rms || 1e-6);
      const level = Math.max(0, Math.min(1, (db + 60) / 60));
      this.peaks[0] = Math.max(level, this.peaks[0] - 0.01);
      const barH = h * 0.18;
      const y = (h - barH) / 2;
      g.fillStyle = '#ffffff1a';
      g.fillRect(w * 0.1, y, w * 0.8, barH);
      g.fillStyle = this.gradient(g, h);
      g.fillRect(w * 0.1, y, w * 0.8 * level, barH);
      g.fillStyle = '#fff';
      g.fillRect(w * 0.1 + w * 0.8 * this.peaks[0] - 2, y, 4, barH);
      g.font = `${Math.round(barH * 0.35)}px Segoe UI, sans-serif`;
      g.fillStyle = '#ccc';
      g.fillText(`${db < -60 ? '-∞' : db.toFixed(1)} dB`, w * 0.1, y - barH * 0.2);
    }
  }

  window.AAPVisualizer = { Visualizer, MODES };
}());
