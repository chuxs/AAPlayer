/* Canvas presenter for 10-bit SDR video.
 *
 * On Intel GPUs (seen on Arc 130T), Chromium's on-screen path for 10-bit
 * (P010) video does not clamp luma below legal black: those pixels wrap and
 * show up as white specks/blotches in dark areas. The decoded frames are fine
 * (a canvas copy of the same frame is clean), so for 10-bit SDR video AAPlayer
 * draws every decoded frame onto a canvas and shows that instead. Decoding
 * stays on the GPU; only the faulty presentation step is replaced.
 */
(function () {
  'use strict';

  class CanvasPresenter {
    constructor(video, canvas) {
      this.video = video;
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      this.active = false;
      this.handle = 0;
      this.draw = this.draw.bind(this);
      video.addEventListener('seeked', () => { if (this.active) this.paint(); });
      video.addEventListener('loadeddata', () => { if (this.active) this.paint(); });
    }

    setActive(on) {
      if (on === this.active) return;
      this.active = on;
      this.canvas.hidden = !on;
      this.video.classList.toggle('presented', on);
      if (on) { this.schedule(); this.paint(); }
      else if (this.handle && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.handle);
    }

    schedule() {
      if (!this.active) return;
      this.handle = this.video.requestVideoFrameCallback(this.draw);
    }

    draw() {
      this.paint();
      this.schedule();
    }

    paint() {
      const v = this.video;
      if (!v.videoWidth) return;
      if (this.canvas.width !== v.videoWidth || this.canvas.height !== v.videoHeight) {
        this.canvas.width = v.videoWidth;
        this.canvas.height = v.videoHeight;
      }
      this.ctx.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
    }
  }

  window.AAPPresenter = { CanvasPresenter };
}());
