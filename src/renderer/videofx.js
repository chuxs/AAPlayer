/* Video effects (VLC: Tools > Effects and Filters > Video Effects), applied on the GPU
 * as CSS/SVG filters so they work in every decoding mode without re-encoding. */
(function () {
  'use strict';

  const DEFAULTS = { brightness: 1, contrast: 1, saturation: 1, hue: 0, gamma: 1, sharpen: 0, transform: 'none' };
  const TRANSFORMS = [['none', 'None'], ['rotate90', 'Rotate by 90°'], ['rotate180', 'Rotate by 180°'], ['rotate270', 'Rotate by 270°'],
    ['hflip', 'Flip horizontally'], ['vflip', 'Flip vertically']];
  const SVG_NS = 'http://www.w3.org/2000/svg';

  class VideoFx {
    constructor() {
      this.state = { ...DEFAULTS };
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.style.position = 'absolute';
      svg.innerHTML = `<filter id="aap-fx" color-interpolation-filters="sRGB">
        <feComponentTransfer><feFuncR type="gamma" amplitude="1" exponent="1"/><feFuncG type="gamma" amplitude="1" exponent="1"/><feFuncB type="gamma" amplitude="1" exponent="1"/></feComponentTransfer>
        <feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="0 0 0 0 1 0 0 0 0"/></filter>`;
      document.body.appendChild(svg);
      this.svg = svg;
    }

    get active() { return Object.keys(DEFAULTS).some((k) => this.state[k] !== DEFAULTS[k]); }

    set(patch) { Object.assign(this.state, patch); }
    reset() { this.state = { ...DEFAULTS }; }

    /** CSS `filter` value for the <video>. */
    filter() {
      const s = this.state;
      const parts = [];
      if (s.gamma !== 1 || s.sharpen > 0) {
        const exp = String(1 / s.gamma);
        for (const fn of this.svg.querySelectorAll('feFuncR,feFuncG,feFuncB')) fn.setAttribute('exponent', exp);
        const k = s.sharpen; // unsharp-style kernel
        this.svg.querySelector('feConvolveMatrix').setAttribute('kernelMatrix',
          `0 ${-k} 0 ${-k} ${1 + 4 * k} ${-k} 0 ${-k} 0`);
        parts.push('url(#aap-fx)');
      }
      if (s.brightness !== 1) parts.push(`brightness(${s.brightness})`);
      if (s.contrast !== 1) parts.push(`contrast(${s.contrast})`);
      if (s.saturation !== 1) parts.push(`saturate(${s.saturation})`);
      if (s.hue) parts.push(`hue-rotate(${s.hue}deg)`);
      return parts.join(' ');
    }

    /** { rotate: degrees, sx, sy } */
    geometry() {
      const t = this.state.transform;
      return {
        rotate: t === 'rotate90' ? 90 : t === 'rotate180' ? 180 : t === 'rotate270' ? 270 : 0,
        sx: t === 'hflip' ? -1 : 1,
        sy: t === 'vflip' ? -1 : 1,
      };
    }
  }

  window.AAPVideoFx = { VideoFx, DEFAULTS, TRANSFORMS };
}());
