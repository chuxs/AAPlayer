/* WebVTT parsing and cue rendering helpers. Used by the renderer (as a classic
 * script, exposed on window.AAPVtt) and by the Node unit tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AAPVtt = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function parseTime(s) {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
    if (!m) return NaN;
    return (parseInt(m[1] || '0', 10) * 3600) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) +
      parseInt(m[4].padEnd(3, '0'), 10) / 1000;
  }

  /** Parses WebVTT text into cues sorted by start time: [{start, end, text}] */
  function parse(text) {
    const cues = [];
    const blocks = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split('\n');
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
      const [a, rest] = lines[i].split('-->');
      const start = parseTime(a);
      const end = parseTime((rest || '').trim().split(/\s+/)[0] || '');
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const body = lines.slice(i + 1).join('\n')
        .replace(/\{\\[^}]*\}/g, '')         // leftover ASS override tags, e.g. {\an8}
        .replace(/\\N/g, '\n').trim();
      if (body) cues.push({ start, end, text: body });
    }
    cues.sort((x, y) => x.start - y.start || x.end - y.end);
    return cues;
  }

  /** Returns the cues active at time t (binary search on start, then scan). */
  function active(cues, t) {
    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) lo = mid + 1; else hi = mid;
    }
    const out = [];
    // Cues are short; look back a bounded window for overlapping ones.
    for (let i = lo - 1; i >= 0 && i >= lo - 50; i--) {
      if (cues[i].end > t) out.unshift(cues[i]);
    }
    return out;
  }

  /** Escapes cue text to HTML, keeping only <i>, <b>, <u> and line breaks. */
  function toHtml(text) {
    const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc
      .replace(/&lt;(\/?)([ibu])(?:\.[^&]*)?&gt;/g, '<$1$2>')
      .replace(/&lt;\/?[a-z][^&]*?&gt;/gi, '')
      .replace(/&amp;(nbsp|amp|lt|gt);/g, '&$1;')
      .replace(/\n/g, '<br>');
  }

  return { parse, active, toHtml, parseTime };
}));
