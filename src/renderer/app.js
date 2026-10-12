/* AAPlayer UI controller: playlist, controls, hotkeys, subtitles, dialogs. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const aap = window.aap;
  const Vtt = window.AAPVtt;
  const { Engine, fmtTime, cleanError } = window.AAPEngine;

  const video = $('video');
  const stage = $('stage');
  const engine = new Engine(video);

  // VLC's rate steps (src/player/player.c), trimmed to what Chromium supports.
  const RATES = [0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4, 8];
  const ASPECTS = ['default', '16:9', '4:3', '16:10', '21:9', '2.35:1', '2.39:1', '1:1', 'fill'];
  // VLC jump sizes: extrashort 3s, short 10s, medium 60s, long 300s.
  const JUMP = { xs: 3, s: 10, m: 60, l: 300 };

  const state = {
    settings: {},
    tools: null,
    playlist: [],          // { input, title, duration }
    current: -1,
    selected: -1,
    loop: 'none',          // none | all | one
    random: false,
    history: [],
    volume: 1,
    muted: false,
    aspect: 'default',
    crop: 'default',
    zoom: 0,
    minimal: false,
    stereoMode: 'stereo',
    audioDevices: [],
    recording: false,
    ab: { a: null, b: null },
    fullscreen: false,
    fullscreenInterface: false,
    loadedInput: null,
    firstMediaShown: false,
    subs: { tracks: [], selected: null, cues: [], delay: 0, cache: new Map(), html: '' },
  };

  /* ================= helpers ================= */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isUrl = (s) => /^[a-z][a-z0-9+.-]+:\/\//i.test(s);
  function titleOf(input) {
    if (isUrl(input)) { try { return decodeURIComponent(new URL(input).pathname.split('/').pop()) || input; } catch { return input; } }
    return input.split(/[\\/]/).pop();
  }
  function fmtBytes(n) {
    if (!n) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  }
  function parseTimeInput(s) {
    const parts = String(s).trim().split(':').map(Number);
    if (!parts.length || parts.some((p) => !Number.isFinite(p) || p < 0)) return NaN;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }

  let osdTimer = null;
  function osd(text, ms = 1400, long = false) {
    const el = $('osd');
    el.textContent = text;
    el.classList.toggle('long', long);
    el.classList.add('show');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  function flash(icon) {
    const el = $('flash');
    el.innerHTML = `<svg><use href="#i-${icon}"/></svg>`;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  /* ================= audio (volume up to 200%, EQ, stereo mode, device) ================= */
  const { AudioChain, EQ_FREQS, EQ_PRESETS } = window.AAPAudio;
  const audioChain = new AudioChain(video);
  const viz = new window.AAPVisualizer.Visualizer($('viz'));
  const vfx = new window.AAPVideoFx.VideoFx();
  const presenter = new window.AAPPresenter.CanvasPresenter(video, $('vcanvas'));
  /** 10-bit SDR video decoded natively is shown through a canvas (see presenter.js). */
  function updatePresenter() {
    const s = engine.session;
    const v = s && s.info.video.find((x) => x.index === s.plan.videoIndex);
    const on = !!(v && s.plan.video.action === 'copy' && v.bitDepth > 8 && !v.isHDR && state.settings.tenBitPresenter !== 'off');
    presenter.setActive(on);
    if (on !== presenter.logged) { presenter.logged = on; if (on) aap.log('ui', '10-bit SDR video: presenting through canvas (Intel P010 display fix)'); }
  }
  function ensureAudioGraph() {
    const fresh = !audioChain.available;
    if (audioChain.ensure() && fresh) {
      applyVolume();
      setVisualization(state.settings.visualization || 'off', true);
    }
  }
  function applyVolume() {
    audioChain.setVolume(state.volume);
    video.muted = state.muted;
    const pct = Math.round(state.volume * 100);
    const fill = $('volume-fill');
    fill.style.width = `${(state.volume / 2) * 100}%`;
    fill.classList.toggle('boost', state.volume > 1);
    fill.style.setProperty('--boost-size', `${(2 / state.volume) * 50 * 2}%`);
    $('volume-text').textContent = state.muted ? 'Muted' : `${pct}%`;
    $('volume').setAttribute('aria-valuenow', String(pct));
    $('btn-mute').innerHTML = `<svg><use href="#i-${state.muted || state.volume === 0 ? 'mute' : 'vol'}"/></svg>`;
  }
  function setVolume(v, show = true) {
    state.volume = Math.round(Math.max(0, Math.min(2, v)) * 100) / 100;
    if (state.volume > 0) state.muted = false;
    applyVolume();
    if (show) osd(`Volume ${Math.round(state.volume * 100)}%`);
    saveSettingSoon({ volume: state.volume });
  }
  let settingsTimer = null;
  let pendingSettings = {};
  function saveSettingSoon(patch) {
    Object.assign(pendingSettings, patch);
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => { aap.setSettings(pendingSettings); pendingSettings = {}; }, 600);
  }

  /* ================= playlist ================= */
  async function openInputs(inputs, play = true) {
    if (!inputs || !inputs.length) return;
    let expanded;
    try { expanded = await aap.expand(inputs); } catch { expanded = inputs; }
    if (!expanded.length) { osd('No playable media found'); return; }
    const first = state.playlist.length;
    for (const input of expanded) state.playlist.push({ input, title: titleOf(input), duration: 0 });
    renderPlaylist();
    if (play) playIndex(first);
    else if (state.current < 0) playIndex(first);
  }

  function saveResume() {
    if (engine.input && engine.duration > 0) aap.setResume(engine.input, engine.time, engine.duration);
  }

  async function playIndex(i, opts = {}) {
    if (i < 0 || i >= state.playlist.length) return;
    saveResume();
    state.current = i;
    state.selected = i;
    if (state.history[state.history.length - 1] !== i) state.history.push(i);
    const item = state.playlist[i];
    state.loadedInput = null;
    clearSubs();
    hidePopover();
    $('resume-bar').hidden = true;
    stage.classList.remove('no-media');
    $('spinner').hidden = false;
    aap.setTitle(item.title);
    renderPlaylist();
    if (item.capture) await startCapture(item.capture, item.title);
    else await engine.load(item.input, { start: opts.start || 0, autoplay: opts.autoplay !== false });
  }

  function nextIndex(dir) {
    const n = state.playlist.length;
    if (!n) return -1;
    if (state.random && dir > 0) {
      if (n === 1) return 0;
      let r;
      do { r = Math.floor(Math.random() * n); } while (r === state.current);
      return r;
    }
    if (state.random && dir < 0 && state.history.length > 1) {
      state.history.pop();
      return state.history[state.history.length - 1];
    }
    const j = state.current + dir;
    if (j >= n) return state.loop === 'all' ? 0 : -1;
    if (j < 0) return state.loop === 'all' ? n - 1 : 0;
    return j;
  }

  function next() { const j = nextIndex(1); if (j >= 0) playIndex(j); else osd('End of playlist'); }
  function prev() {
    if (engine.time > 5 && !state.random) { engine.seek(0); return; }
    const j = nextIndex(-1);
    if (j >= 0) playIndex(j);
  }

  function stop() {
    if (typeof captureRecorder !== 'undefined' && captureRecorder) captureRecorder.stop();
    saveResume();
    engine.stop();
    clearSubs();
    state.loadedInput = null;
    stage.classList.add('no-media');
    $('audio-art').hidden = true;
    $('spinner').hidden = true;
    $('mode-chip').hidden = true;
    $('resume-bar').hidden = true;
    $('audio-art').classList.remove('spin');
    $('time-cur').textContent = '0:00';
    $('time-dur').textContent = '--:--';
    for (const id of ['seek-fill', 'seek-buffer']) $(id).style.width = '0';
    $('seek-knob').style.left = '0';
    $('seek-chapters').innerHTML = '';
    aap.setTitle('');
    viz.setMode('off');
    presenter.setActive(false);
    renderStatusBar();
    updatePlayButton();
    pushMenuState();
  }

  let plFilter = '';
  let dragFrom = -1;
  function renderPlaylist() {
    const list = $('pl-list');
    list.innerHTML = '';
    const f = plFilter.toLowerCase();
    state.playlist.forEach((item, i) => {
      if (f && !item.title.toLowerCase().includes(f)) return;
      const li = document.createElement('li');
      li.dataset.index = String(i);
      li.draggable = !f;
      li.className = (i === state.current ? 'current ' : '') + (i === state.selected ? 'sel' : '');
      li.innerHTML = `<span class="t" title="${esc(item.input)}">${esc(item.title)}</span><span class="d">${item.duration ? fmtTime(item.duration) : ''}</span><button class="rm" title="Remove">✕</button>`;
      list.appendChild(li);
    });
    $('pl-count').textContent = state.playlist.length ? `(${state.playlist.length})` : '';
    $('pl-empty').hidden = state.playlist.length > 0;
    pushMenuState();
  }

  function removeFromPlaylist(i) {
    if (i < 0 || i >= state.playlist.length) return;
    state.playlist.splice(i, 1);
    state.history = state.history.filter((h) => h !== i).map((h) => (h > i ? h - 1 : h));
    if (i === state.current) { state.current = -1; stop(); }
    else if (i < state.current) state.current--;
    if (state.selected >= state.playlist.length) state.selected = state.playlist.length - 1;
    renderPlaylist();
  }

  function movePlaylistItem(from, to) {
    if (from === to || from < 0 || to < 0) return;
    const [item] = state.playlist.splice(from, 1);
    state.playlist.splice(to, 0, item);
    const fix = (idx) => {
      if (idx === from) return to;
      if (from < idx && idx <= to) return idx - 1;
      if (to <= idx && idx < from) return idx + 1;
      return idx;
    };
    state.current = fix(state.current);
    state.selected = fix(state.selected);
    state.history = state.history.map(fix);
    renderPlaylist();
  }

  function togglePlaylist(force) {
    const pl = $('playlist');
    pl.hidden = force === undefined ? !pl.hidden : !force;
    $('btn-playlist').classList.toggle('on', !pl.hidden);
    requestAnimationFrame(layoutVideo);
    pushMenuState();
  }

  /* ================= engine events ================= */
  engine.addEventListener('loading', () => { $('spinner').hidden = false; });

  engine.addEventListener('loaded', async (e) => {
    const s = e.detail;
    const info = s.info;
    const item = state.playlist[state.current];
    const firstLoad = state.loadedInput !== info.input;
    state.loadedInput = info.input;
    if (item && item.input === info.input) {
      item.duration = info.duration;
      if (info.title && !isUrl(info.input)) item.title = titleOf(info.input);
    }
    updateModeChip();
    updatePresenter();
    renderChapters();
    setVisualization(state.settings.visualization || 'off', true);
    const audioOnly = !engine.hasVideo;
    $('audio-art').hidden = !audioOnly;
    if (audioOnly) {
      $('audio-title').textContent = info.title || titleOf(info.input);
      const a = info.audio[0];
      $('audio-sub').textContent = a ? `${a.codec.toUpperCase()} · ${a.channels} ch · ${(a.sampleRate / 1000).toFixed(1)} kHz` : '';
    }

    if (firstLoad) {
      if (s.plan.kind !== 'capture') aap.addRecent(info.input);
      setupSubtitleTracks(s);
      if (s.resume > 0 && (engine.opts.start || 0) === 0) {
        engine.seek(s.resume);
        $('resume-text').textContent = `Resumed at ${fmtTime(s.resume)}`;
        $('resume-bar').hidden = false;
        setTimeout(() => { $('resume-bar').hidden = true; }, 9000);
      }
      if ((!state.firstMediaShown || state.settings.fitWindow) && engine.hasVideo) {
        state.firstMediaShown = true;
        fitWindowToVideo();
      }
      state.ab = { a: null, b: null };
      for (const btn of [$('adv-ab'), $('tb-ab')]) { btn.textContent = 'A→B'; btn.classList.remove('on'); }
      const v = info.video.find((x) => !x.attachedPic);
      if (v && v.bitDepth > 8 && s.plan.kind !== 'direct') {
        osd(s.plan.video.action === 'encode'
          ? `${v.bitDepth}-bit video: converting to 8-bit (${s.encoder || 'software'})`
          : `${v.bitDepth}-bit video: decoding natively`, 3000, true);
      }
    }
    renderPlaylist();
    pushMenuState();
  });

  engine.addEventListener('notice', (e) => osd(e.detail.message, 4500, true));
  engine.addEventListener('fatal', (e) => {
    $('spinner').hidden = true;
    osd(e.detail.message, 8000, true);
    aap.log('ui', `fatal: ${e.detail.message}`);
    updatePlayButton();
  });
  engine.addEventListener('ended', () => {
    saveResume();
    if (state.loop === 'one') { engine.seek(0); engine.play(); return; }
    const j = nextIndex(1);
    if (j >= 0) playIndex(j);
    else if (state.quitAtEnd) aap.quit(); // Media > Quit at the end of playlist
    else stop();
  });

  video.addEventListener('play', () => { ensureAudioGraph(); updatePlayButton(); });
  video.addEventListener('pause', updatePlayButton);
  video.addEventListener('playing', () => { $('spinner').hidden = true; $('audio-art').classList.add('spin'); updatePlayButton(); });
  video.addEventListener('waiting', () => { $('spinner').hidden = false; });
  video.addEventListener('canplay', () => { $('spinner').hidden = true; });
  video.addEventListener('pause', () => $('audio-art').classList.remove('spin'));
  video.addEventListener('loadedmetadata', layoutVideo);
  video.addEventListener('ratechange', () => { $('btn-speed').textContent = `${video.playbackRate.toFixed(2)}×`; });

  function updatePlayButton() {
    const playing = !video.paused && !!engine.session;
    $('btn-play').innerHTML = `<svg><use href="#i-${playing ? 'pause' : 'play'}"/></svg>`;
    pushMenuState();
  }

  function updateModeChip() {
    const s = engine.session;
    const chip = $('mode-chip');
    if (!s) { chip.hidden = true; return; }
    const v = s.info.video.find((x) => x.index === s.plan.videoIndex);
    const depth = v ? ` · ${v.bitDepth}-bit` : '';
    const labels = { capture: 'Live capture', direct: 'Native', remux: 'Native (remux)', transcode: `Converting → 8-bit H.264${s.encoder ? ` (${s.encoder.replace('h264_', '').replace('libx264', 'CPU')})` : ''}` };
    chip.textContent = `${labels[s.plan.kind]}${depth}`;
    chip.classList.toggle('warn', s.plan.kind === 'transcode');
    chip.hidden = false;
  }

  /* ================= time / seek bar ================= */
  let showRemaining = false;
  let seekDrag = null;
  function renderTime() {
    const d = engine.duration;
    const t = seekDrag ? seekDrag.t : engine.time;
    $('time-cur').textContent = fmtTime(t);
    $('time-dur').textContent = d ? (showRemaining ? `-${fmtTime(d - t)}` : fmtTime(d)) : '--:--';
    const pct = d ? Math.min(100, (t / d) * 100) : 0;
    $('seek-fill').style.width = `${pct}%`;
    $('seek-knob').style.left = `${pct}%`;
    const seek = $('seek');
    seek.setAttribute('aria-valuemax', String(Math.round(d)));
    seek.setAttribute('aria-valuenow', String(Math.round(t)));
    // buffered range of the current stream, mapped to media time
    let bufEnd = 0;
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= video.currentTime + 0.5) bufEnd = Math.max(bufEnd, b.end(i));
    }
    const bufPct = d ? Math.min(100, ((engine.offset + bufEnd) / d) * 100) : 0;
    $('seek-buffer').style.left = d && engine.kind !== 'direct' ? `${(engine.offset / d) * 100}%` : '0';
    $('seek-buffer').style.width = `${Math.max(0, bufPct - (d && engine.kind !== 'direct' ? (engine.offset / d) * 100 : 0))}%`;
  }

  function renderChapters() {
    const box = $('seek-chapters');
    box.innerHTML = '';
    const info = engine.info;
    if (!info || !info.duration) return;
    for (const c of info.chapters) {
      if (c.start <= 0.5) continue;
      const span = document.createElement('span');
      span.style.left = `${(c.start / info.duration) * 100}%`;
      box.appendChild(span);
    }
  }

  function seekPosFromEvent(e) {
    const r = $('seek').getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    return { x, t: x * engine.duration };
  }

  let thumbTimer = null;
  let thumbWanted = '';
  function showSeekTip(e) {
    if (!engine.session || !engine.duration) return;
    const { x, t } = seekPosFromEvent(e);
    const tip = $('seek-tip');
    tip.hidden = false;
    const r = $('seek').getBoundingClientRect();
    const half = 100;
    tip.style.left = `${Math.max(half - 10, Math.min(r.width - half + 10, x * r.width))}px`;
    $('seek-tip-time').textContent = fmtTime(t);
    const ch = (engine.info.chapters || []).filter((c) => c.start <= t).pop();
    $('seek-tip-chapter').textContent = ch && ch.title ? ch.title : '';
    const img = $('seek-thumb');
    if (engine.session.thumbUrl) {
      const url = `${engine.session.thumbUrl}?t=${(Math.round(t / 2) * 2)}`;
      if (url !== thumbWanted) {
        thumbWanted = url;
        clearTimeout(thumbTimer);
        thumbTimer = setTimeout(() => { if (thumbWanted === url) img.src = url; }, 90);
      }
    } else img.removeAttribute('src');
  }

  $('seek').addEventListener('pointermove', (e) => {
    showSeekTip(e);
    if (seekDrag) { seekDrag.t = seekPosFromEvent(e).t; renderTime(); }
  });
  $('seek').addEventListener('pointerleave', () => { if (!seekDrag) $('seek-tip').hidden = true; });
  $('seek').addEventListener('pointerdown', (e) => {
    if (!engine.session || !engine.duration) return;
    $('seek').setPointerCapture(e.pointerId);
    seekDrag = { t: seekPosFromEvent(e).t };
    $('seek').classList.add('drag');
    renderTime();
  });
  $('seek').addEventListener('pointerup', (e) => {
    if (!seekDrag) return;
    const t = seekPosFromEvent(e).t;
    seekDrag = null;
    $('seek').classList.remove('drag');
    $('seek-tip').hidden = true;
    engine.seek(t);
  });
  $('seek').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.stopPropagation(); e.preventDefault(); jump(e.key === 'ArrowLeft' ? -JUMP.s : JUMP.s); }
  });
  $('time-dur').addEventListener('click', () => {
    showRemaining = !showRemaining;
    saveSettingSoon({ showRemaining });
    renderTime();
  });

  function jump(sec) {
    if (!engine.session) return;
    const t = Math.max(0, engine.time + sec);
    engine.seek(t);
    osd(`${sec > 0 ? '+' : '−'}${Math.abs(sec)}s  ${fmtTime(t)} / ${fmtTime(engine.duration)}`);
  }

  /* ================= volume slider ================= */
  function volFromEvent(e) {
    const r = $('volume').getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 2;
  }
  let volDrag = false;
  $('volume').addEventListener('pointerdown', (e) => { volDrag = true; $('volume').setPointerCapture(e.pointerId); setVolume(snapVol(volFromEvent(e))); });
  $('volume').addEventListener('pointermove', (e) => { if (volDrag) setVolume(snapVol(volFromEvent(e))); });
  $('volume').addEventListener('pointerup', () => { volDrag = false; });
  $('volume').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setVolume(state.volume - 0.05); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setVolume(state.volume + 0.05); }
  });
  function snapVol(v) { return Math.abs(v - 1) < 0.04 ? 1 : v; }

  /* ================= subtitles ================= */
  function clearSubs() {
    state.subs.tracks = [];
    state.subs.selected = null;
    state.subs.cues = [];
    state.subs.delay = 0;
    state.subs.cache.clear();
    state.subs.html = '';
    $('subtitles').innerHTML = '';
  }

  function setupSubtitleTracks(session) {
    const info = session.info;
    const langName = (code) => {
      if (!code || code === 'und') return '';
      try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
    };
    state.subs.tracks = [
      ...(session.externalSubs || []).map((file, i) => ({
        id: `x${i}`, file, kind: 'text', label: `${file.split(/[\\/]/).pop()} (external)`,
      })),
      ...info.subs.map((s, i) => ({
        id: `s${s.index}`, streamIndex: s.index, kind: s.kind, default: s.default, forced: s.forced,
        label: [`Track ${i + 1}`, s.title, langName(s.lang), s.codec === 'hdmv_pgs_subtitle' ? 'PGS' : s.codec.toUpperCase(),
          s.kind === 'image' ? 'image, burned in' : '', s.forced ? 'forced' : ''].filter(Boolean).join(' · '),
      })),
    ];
    const pick = state.subs.tracks.find((t) => t.file) ||
      state.subs.tracks.find((t) => t.kind === 'text' && t.forced) ||
      state.subs.tracks.find((t) => t.kind === 'text' && t.default);
    if (pick) selectSub(pick.id, true);
    pushMenuState();
  }

  function addSubtitleFile(file) {
    if (!engine.session) return;
    const id = `x${Date.now()}`;
    state.subs.tracks.unshift({ id, file, kind: 'text', label: `${file.split(/[\\/]/).pop()} (external)` });
    selectSub(id);
  }

  async function selectSub(id, quiet) {
    const track = state.subs.tracks.find((t) => t.id === id) || null;
    const burning = engine.opts.burnSubtitleIndex != null;
    state.subs.selected = track ? track.id : null;
    state.subs.cues = [];
    state.subs.html = '';
    $('subtitles').innerHTML = '';
    pushMenuState();
    if (!track) {
      if (burning) engine.reload({ burnSubtitleIndex: null });
      if (!quiet) osd('Subtitles disabled');
      return;
    }
    if (track.kind === 'image') {
      engine.reload({ burnSubtitleIndex: track.streamIndex }, 'Image subtitles are burned into the picture (converting video)…');
      return;
    }
    if (burning) engine.reload({ burnSubtitleIndex: null });
    try {
      let cues = state.subs.cache.get(track.id);
      if (!cues) {
        const text = await aap.subtitle(track.file ? { file: track.file } : { input: engine.input, streamIndex: track.streamIndex });
        cues = Vtt.parse(text);
        state.subs.cache.set(track.id, cues);
      }
      if (state.subs.selected !== track.id) return;
      state.subs.cues = cues;
      if (!quiet) osd(`Subtitle: ${track.label}`, 2000, true);
    } catch (e) {
      osd(`Could not load subtitle: ${cleanError(e)}`, 5000, true);
    }
  }

  function cycleSub(dir = 1) {
    const ids = [null, ...state.subs.tracks.map((t) => t.id)];
    const i = ids.indexOf(state.subs.selected);
    selectSub(ids[(i + dir + ids.length) % ids.length]);
  }

  function renderSubs() {
    const cues = state.subs.cues;
    if (!cues.length) return;
    const active = Vtt.active(cues, engine.time - state.subs.delay);
    const html = active.map((c) => `<span class="cue">${Vtt.toHtml(c.text)}</span>`).join('<br>');
    if (html !== state.subs.html) { state.subs.html = html; $('subtitles').innerHTML = html; }
  }

  function setSubScale(scale) {
    state.settings.subtitleScale = Math.max(0.5, Math.min(3, Math.round(scale * 10) / 10));
    document.documentElement.style.setProperty('--sub-scale', String(state.settings.subtitleScale));
    saveSettingSoon({ subtitleScale: state.settings.subtitleScale });
  }

  /* ================= audio tracks / rate / video ================= */
  function audioTracks() {
    const s = engine.session;
    if (!s) return [];
    return s.info.audio.map((a, i) => {
      let lang = a.lang && a.lang !== 'und' ? a.lang : '';
      try { if (lang) lang = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) || lang; } catch { /* keep code */ }
      return {
        index: a.index, selected: a.index === s.plan.audioIndex,
        label: [`Track ${i + 1}`, a.title, lang, a.codec.toUpperCase(), a.layout || `${a.channels} ch`].filter(Boolean).join(' · '),
      };
    });
  }
  function setAudioTrack(index) {
    if (!engine.session || index === engine.session.plan.audioIndex) return;
    const t = audioTracks().find((x) => x.index === index);
    engine.reload({ audioIndex: index });
    if (t) osd(`Audio: ${t.label}`, 2000, true);
  }
  function cycleAudio() {
    const tracks = audioTracks();
    if (tracks.length < 2) { osd(tracks.length ? 'Only one audio track' : 'No audio'); return; }
    const i = tracks.findIndex((t) => t.selected);
    setAudioTrack(tracks[(i + 1) % tracks.length].index);
  }

  function setRate(r) {
    r = Math.max(0.0625, Math.min(16, Math.round(r * 100) / 100));
    engine.setRate(r);
    osd(`Speed ${r.toFixed(2)}×`);
    pushMenuState();
  }
  function rateStep(dir) {
    const cur = video.playbackRate;
    const list = dir > 0 ? RATES.filter((r) => r > cur + 0.001) : RATES.filter((r) => r < cur - 0.001).reverse();
    if (list.length) setRate(list[0]);
  }

  async function snapshot() {
    if (!engine.hasVideo || !video.videoWidth) return;
    try {
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      const file = await aap.snapshot(c.toDataURL('image/png'), titleOf(engine.input).replace(/\.[^.]+$/, ''), engine.time);
      osd(`Snapshot saved: ${file.split(/[\\/]/).pop()}`, 2500, true);
    } catch (e) {
      osd(`Snapshot failed: ${cleanError(e)}`, 3000, true);
    }
  }

  function frameNext() {
    if (!engine.session || !engine.hasVideo) return;
    engine.pause();
    const v = engine.info.video.find((x) => !x.attachedPic);
    const step = 1 / ((v && v.fps) || 25);
    video.currentTime = Math.min(video.currentTime + step, Number.isFinite(video.duration) ? video.duration : Infinity);
    osd('Next frame');
  }

  async function setFullscreen(value, withInterface = false) {
    if (!withInterface && state.fullscreenInterface) { state.fullscreenInterface = false; document.body.classList.remove('fs-interface'); }
    const fs = await aap.fullscreen(value, withInterface);
    state.fullscreen = fs;
    document.body.classList.toggle('fullscreen', fs);
    $('btn-fullscreen').innerHTML = `<svg><use href="#i-${fs ? 'unfull' : 'full'}"/></svg>`;
  }

  function togglePlay() {
    if (!engine.session) {
      if (state.playlist.length) playIndex(Math.max(0, state.current));
      else aap.menuAction('openFiles', false);
      return;
    }
    if (video.paused) { engine.play(); flash('play'); } else { engine.pause(); flash('pause'); }
  }

  function setDecodeMode(mode) {
    state.settings.decodeMode = mode;
    aap.setSettings({ decodeMode: mode });
    const names = { auto: 'Auto', compat: 'Compatibility (8-bit H.264)', direct: 'Native only' };
    if (engine.session) engine.reload({ mode }, `Decoding mode: ${names[mode]}`);
    else osd(`Decoding mode: ${names[mode]}`);
  }

  /* ================= popovers (speed / audio / subs) ================= */
  function showPopover(anchor, sections) {
    const pop = $('popover');
    pop.innerHTML = '';
    for (const sec of sections) {
      if (sec.title) { const h = document.createElement('h3'); h.textContent = sec.title; pop.appendChild(h); }
      for (const it of sec.items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = it.label;
        if (it.selected) b.classList.add('sel');
        b.addEventListener('click', () => { hidePopover(); it.action(); });
        pop.appendChild(b);
      }
    }
    pop.hidden = false;
    const sr = stage.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = `${Math.max(8, Math.min(sr.width - w - 8, ar.left - sr.left + ar.width / 2 - w / 2))}px`;
  }
  function hidePopover() { $('popover').hidden = true; }
  document.addEventListener('pointerdown', (e) => {
    if (!$('popover').hidden && !$('popover').contains(e.target) && !e.target.closest('#btn-speed,#btn-audio,#btn-subs')) hidePopover();
  });

  $('btn-speed').addEventListener('click', (e) => {
    if (!$('popover').hidden) return hidePopover();
    showPopover(e.currentTarget, [{ title: 'Playback speed', items: RATES.filter((r) => r <= 4).map((r) => ({
      label: `${r.toFixed(2)}×${r === 1 ? ' (normal)' : ''}`, selected: Math.abs(video.playbackRate - r) < 0.01, action: () => setRate(r) })) }]);
  });
  $('btn-audio').addEventListener('click', (e) => {
    if (!$('popover').hidden) return hidePopover();
    const tracks = audioTracks();
    showPopover(e.currentTarget, [{ title: 'Audio track', items: tracks.length
      ? tracks.map((t) => ({ label: t.label, selected: t.selected, action: () => setAudioTrack(t.index) }))
      : [{ label: 'No audio', action: () => {} }] }]);
  });
  $('btn-subs').addEventListener('click', (e) => {
    if (!$('popover').hidden) return hidePopover();
    showPopover(e.currentTarget, [
      { title: 'Subtitles', items: [{ label: 'Off', selected: !state.subs.selected, action: () => selectSub(null) },
        ...state.subs.tracks.map((t) => ({ label: t.label, selected: t.id === state.subs.selected, action: () => selectSub(t.id) }))] },
      { items: [{ label: 'Add subtitle file…', action: () => aap.menuAction('openSubtitle') }] },
    ]);
  });

  /* ================= buttons ================= */
  $('btn-play').addEventListener('click', togglePlay);
  $('adv-record').addEventListener('click', () => toggleRecord());
  $('adv-snapshot').addEventListener('click', () => snapshot());
  $('adv-ab').addEventListener('click', () => abLoop());
  $('adv-frame').addEventListener('click', () => frameNext());
  $('adv-effects').addEventListener('click', () => openEffects());
  $('tb-record').addEventListener('click', () => toggleRecord());
  $('tb-snapshot').addEventListener('click', () => snapshot());
  $('tb-ab').addEventListener('click', () => abLoop());
  $('tb-frame').addEventListener('click', () => frameNext());
  $('tb-effects').addEventListener('click', () => openEffects());
  $('btn-stop').addEventListener('click', stop);
  $('btn-next').addEventListener('click', next);
  $('btn-prev').addEventListener('click', prev);
  $('btn-playlist').addEventListener('click', () => togglePlaylist());
  $('btn-fullscreen').addEventListener('click', () => setFullscreen());
  $('btn-mute').addEventListener('click', () => { state.muted = !state.muted; applyVolume(); });
  $('btn-loop').addEventListener('click', () => setLoop({ none: 'all', all: 'one', one: 'none' }[state.loop]));
  $('btn-random').addEventListener('click', () => setRandom(!state.random));
  $('mode-chip').addEventListener('click', () => showMediaInfo('codec'));
  $('resume-restart').addEventListener('click', () => { $('resume-bar').hidden = true; engine.seek(0); });
  $('resume-dismiss').addEventListener('click', () => { $('resume-bar').hidden = true; });

  function setLoop(mode) {
    state.loop = mode;
    $('btn-loop').classList.toggle('on', mode !== 'none');
    $('loop-badge').textContent = mode === 'one' ? '1' : '';
    osd({ none: 'Loop: off', all: 'Loop: all', one: 'Loop: one' }[mode]);
    pushMenuState();
  }
  function setRandom(on) {
    state.random = on;
    $('btn-random').classList.toggle('on', on);
    osd(on ? 'Random: on' : 'Random: off');
    pushMenuState();
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    const action = a.dataset.action;
    if (action === 'open-file') aap.menuAction('openFiles', true);
    else if (action === 'open-folder') aap.menuAction('openFolder');
    else if (action === 'open-network') showNetworkDialog();
  });

  // playlist interactions
  const plList = $('pl-list');
  plList.addEventListener('dblclick', (e) => {
    const li = e.target.closest('li');
    if (li) playIndex(Number(li.dataset.index));
  });
  plList.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const i = Number(li.dataset.index);
    if (e.target.closest('.rm')) { removeFromPlaylist(i); return; }
    state.selected = i;
    renderPlaylist();
  });
  plList.addEventListener('keydown', (e) => {
    if (e.key === 'Delete') { e.stopPropagation(); removeFromPlaylist(state.selected); }
    else if (e.key === 'Enter') { e.stopPropagation(); playIndex(state.selected); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      state.selected = Math.max(0, Math.min(state.playlist.length - 1, state.selected + (e.key === 'ArrowDown' ? 1 : -1)));
      renderPlaylist();
    }
  });
  plList.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    dragFrom = Number(li.dataset.index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-aap-index', String(dragFrom));
  });
  plList.addEventListener('dragover', (e) => {
    if (dragFrom < 0) return;
    e.preventDefault();
    e.stopPropagation();
    plList.querySelectorAll('.dragover').forEach((n) => n.classList.remove('dragover'));
    const li = e.target.closest('li');
    if (li) li.classList.add('dragover');
  });
  plList.addEventListener('drop', (e) => {
    if (dragFrom < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const li = e.target.closest('li');
    const to = li ? Number(li.dataset.index) : state.playlist.length - 1;
    movePlaylistItem(dragFrom, to);
    dragFrom = -1;
  });
  plList.addEventListener('dragend', () => { dragFrom = -1; plList.querySelectorAll('.dragover').forEach((n) => n.classList.remove('dragover')); });
  $('pl-search').addEventListener('input', (e) => { plFilter = e.target.value; renderPlaylist(); });
  $('pl-search').addEventListener('keydown', (e) => e.stopPropagation());
  $('pl-clear').addEventListener('click', () => { state.playlist = []; state.history = []; state.current = -1; state.selected = -1; stop(); renderPlaylist(); });
  $('pl-save').addEventListener('click', savePlaylist);
  async function savePlaylist() {
    if (!state.playlist.length) { osd('Playlist is empty'); return; }
    const file = await aap.savePlaylist(state.playlist.map(({ input, title, duration }) => ({ input, title, duration })));
    if (file) osd(`Playlist saved: ${file.split(/[\\/]/).pop()}`, 2500, true);
  }

  /* ================= stage mouse ================= */
  let idleTimer = null;
  function showControls() {
    stage.classList.add('controls-visible');
    stage.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (video.paused || !engine.session || state.fullscreenInterface || $('controls').matches(':hover') || !$('popover').hidden || seekDrag) { showControls(); return; }
      stage.classList.remove('controls-visible');
      stage.classList.add('idle');
    }, 2500);
  }
  stage.addEventListener('pointermove', showControls);
  stage.addEventListener('pointerdown', showControls);
  stage.addEventListener('pointerleave', () => {
    if (!video.paused && engine.session) { stage.classList.remove('controls-visible'); }
  });
  showControls();

  let clickTimer = null;
  video.addEventListener('click', () => {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(togglePlay, 220);
  });
  video.addEventListener('dblclick', () => { clearTimeout(clickTimer); setFullscreen(); });
  $('audio-art').addEventListener('dblclick', () => setFullscreen());
  $('audio-art').addEventListener('click', () => togglePlay());
  stage.addEventListener('wheel', (e) => {
    if (e.target.closest('#popover, #empty')) return;
    e.preventDefault();
    if (e.ctrlKey) { setSubScale((state.settings.subtitleScale || 1) + (e.deltaY < 0 ? 0.1 : -0.1)); osd(`Subtitle size ${Math.round(state.settings.subtitleScale * 100)}%`); }
    else setVolume(state.volume + (e.deltaY < 0 ? 0.05 : -0.05));
  }, { passive: false });
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input, textarea, dialog')) return;
    e.preventDefault();
    aap.popupMenu();
  });

  /* ================= drag & drop ================= */
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (dragFrom >= 0 || !e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('text/uri-list')) return;
    dragDepth++;
    $('drop-hint').hidden = false;
  });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-hint').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop-hint').hidden = true;
    if (dragFrom >= 0) return;
    const paths = [...e.dataTransfer.files].map((f) => aap.pathForFile(f)).filter(Boolean);
    if (!paths.length) {
      const uri = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split(/\r?\n/).find((l) => isUrl(l.trim()));
      if (uri) openInputs([uri.trim()]);
      return;
    }
    const subExt = /\.(srt|ass|ssa|vtt|sub|smi|sami|ttml|dfxp|stl)$/i;
    if (engine.session && paths.every((p) => subExt.test(p))) { paths.forEach(addSubtitleFile); return; }
    openInputs(paths, true);
  });

  /* ================= dialogs ================= */
  function showDialog(title, bodyHtml, buttons = [{ label: 'Close', value: 'close', primary: true }]) {
    const dlg = $('dialog');
    $('dialog-title').textContent = title;
    $('dialog-body').innerHTML = bodyHtml;
    const footer = $('dialog-footer');
    footer.innerHTML = '';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.value = b.value;
      btn.textContent = b.label;
      if (b.primary) btn.className = 'primary';
      footer.appendChild(btn);
    }
    if (dlg.open) dlg.close();
    dlg.returnValue = '';
    dlg.showModal();
    const focus = dlg.querySelector('[autofocus]');
    if (focus) focus.focus();
    return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true }));
  }

  $('dialog').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('input:not([type=checkbox]):not([type=radio])')) return;
    e.preventDefault();
    const target = e.target.dataset.enter ? $(e.target.dataset.enter) : $('dialog-footer').querySelector('button.primary');
    if (target) target.click();
  });

  async function showNetworkDialog() {
    const r = await showDialog('Open Network Stream',
      `<label class="field">Network URL<input id="net-url" type="url" placeholder="https://example.com/video.mkv" autofocus></label>
       <p style="color:var(--muted);margin:4px 0 0">HTTP(S), HLS (.m3u8), RTSP, RTMP and other URLs FFmpeg understands.</p>`,
      [{ label: 'Cancel', value: 'cancel' }, { label: 'Play', value: 'ok', primary: true }]);
    const url = ($('net-url') && $('net-url').value || '').trim();
    if (r === 'ok' && url) openInputs([url]);
  }

  async function showGotoDialog() {
    if (!engine.session) return;
    const r = await showDialog('Go to Time',
      `<label class="field">Time (h:mm:ss)<input id="goto-time" type="text" value="${fmtTime(engine.time)}" autofocus></label>`,
      [{ label: 'Cancel', value: 'cancel' }, { label: 'Go', value: 'ok', primary: true }]);
    if (r !== 'ok') return;
    const t = parseTimeInput($('goto-time').value);
    if (Number.isFinite(t)) engine.seek(t); else osd('Invalid time');
  }

  function showMediaInfo(tab) {
    const s = engine.session;
    if (!s) return;
    const info = s.info;
    const row = (k, v) => (v || v === 0 ? `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>` : '');
    const v = info.video.find((x) => x.index === s.plan.videoIndex);
    let diag = '';
    if (v && v.bitDepth > 8) {
      diag = s.plan.video.action === 'encode'
        ? `<div class="note">This is <b>${v.bitDepth}-bit</b> video (${esc(v.pixFmt)}). AAPlayer decodes it in a separate
          FFmpeg process and converts it to dithered 8-bit H.264 (${esc((s.plan.reasons.find((r) => r.startsWith('Video:') || r.startsWith('Compat')) || '').replace(/^Video: /, ''))}).
          A stuck decoder can only stall that process, and the watchdog restarts it, so the player itself cannot freeze.</div>`
        : `<div class="note ok">This is <b>${v.bitDepth}-bit</b> video decoded natively by Chromium
          (${esc((s.plan.reasons.find((r) => r.startsWith('Video:')) || '').replace(/^Video: /, ''))}).
          If it stalls, fails or drops frames, AAPlayer switches to compatibility mode (8-bit conversion) automatically.</div>`;
    }
    const general = `<h3>General</h3><table>
      ${row('File', info.input)}${row('Title', info.title)}${row('Container', info.formatLongName || info.formatName)}
      ${row('Duration', info.duration ? fmtTime(info.duration) : 'unknown')}${row('Size', fmtBytes(info.size))}
      ${row('Overall bitrate', info.bitRate ? `${Math.round(info.bitRate / 1000)} kb/s` : '')}
      ${row('Chapters', info.chapters.length || '')}</table>`;
    const streams = [
      ...info.video.map((x) => `<h3>Stream ${x.index} · Video${x.attachedPic ? ' (cover art)' : ''}</h3><table>
        ${row('Codec', `${x.codec}${x.profile ? ` (${x.profile})` : ''}`)}${row('Resolution', `${x.width}×${x.height}`)}
        ${row('Frame rate', x.fps ? `${x.fps.toFixed(3)} fps` : '')}${row('Pixel format', x.pixFmt)}
        ${row('Bit depth', `${x.bitDepth}-bit`)}${row('Chroma', `4:${x.chroma.slice(1, 2)}:${x.chroma.slice(2)}`)}
        ${row('Color', [x.primaries, x.transfer, x.matrix, x.range].filter(Boolean).join(' / ') || 'unspecified')}
        ${row('HDR', x.isHDR ? 'yes' : '')}${row('Interlaced', x.interlaced ? 'yes' : '')}
        ${row('Language', x.lang)}${row('Title', x.title)}</table>`),
      ...info.audio.map((x) => `<h3>Stream ${x.index} · Audio${x.index === s.plan.audioIndex ? ' (playing)' : ''}</h3><table>
        ${row('Codec', `${x.codec}${x.profile ? ` (${x.profile})` : ''}`)}${row('Channels', `${x.channels}${x.layout ? ` (${x.layout})` : ''}`)}
        ${row('Sample rate', x.sampleRate ? `${x.sampleRate} Hz` : '')}${row('Language', x.lang)}${row('Title', x.title)}</table>`),
      ...info.subs.map((x) => `<h3>Stream ${x.index} · Subtitle</h3><table>
        ${row('Codec', x.codec)}${row('Type', x.kind === 'image' ? 'image (burned in when selected)' : 'text')}
        ${row('Language', x.lang)}${row('Title', x.title)}${row('Flags', [x.default && 'default', x.forced && 'forced'].filter(Boolean).join(', '))}</table>`),
    ].join('');
    const kindNames = { direct: 'Direct (native file playback)', remux: 'Remux (FFmpeg, video copied)', transcode: 'Transcode (FFmpeg → 8-bit H.264)' };
    const playback = `<h3>Playback engine</h3><table>
      ${row('Decoding mode', { auto: 'Auto', compat: 'Compatibility', direct: 'Native only' }[engine.opts.mode || s.mode] || s.mode)}
      ${row('Pipeline', kindNames[s.plan.kind])}${row('Video', s.plan.video.action)}${row('Audio', s.plan.audio.action)}
      ${row('Encoder', s.encoder || '')}${row('HDR → SDR tone mapping', s.plan.hdrToSdr ? 'yes' : '')}
      ${row('Deinterlace', s.plan.deinterlace ? 'yes' : '')}${row('Recoveries', engine.recoveries || '')}</table>
      <ul class="reasons">${s.plan.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
    const body = tab === 'codec' ? diag + playback + streams : general + diag + playback + streams;
    showDialog(tab === 'codec' ? 'Codec Information' : 'Media Information', body);
  }

  async function showMessages() {
    const lines = await aap.getLog();
    await showDialog('Messages', `<pre class="log" id="log-pre">${esc(lines.slice(-800).join('\n'))}</pre>`,
      [{ label: 'Close', value: 'close', primary: true }]);
  }

  async function showPreferences() {
    const t = await aap.toolsInfo();
    const s = state.settings;
    const encs = (t && t.encoders) || [];
    const opt = (value, label, cur) => `<option value="${esc(value)}"${String(cur) === String(value) ? ' selected' : ''}>${esc(label)}</option>`;
    const encName = { h264_nvenc: 'NVIDIA NVENC', h264_qsv: 'Intel Quick Sync', h264_amf: 'AMD AMF', libx264: 'x264 (CPU)' };
    const r = await showDialog('Preferences', `
      <h3>Playback</h3>
      <label class="field">Decoding mode<select id="pf-mode">
        ${opt('auto', 'Auto: native when possible, 8-bit fallback', s.decodeMode)}
        ${opt('compat', 'Compatibility: always convert to 8-bit H.264', s.decodeMode)}
        ${opt('direct', 'Native only: never convert', s.decodeMode)}</select>
        <small>Auto converts 10-bit H.264 and anything this machine cannot decode, and falls back automatically if native decoding stalls.</small></label>
      <label class="field">10-bit display fix<select id="pf-tenbit">${opt('auto', 'On: draw 10-bit video through a canvas', s.tenBitPresenter || 'auto')}${opt('off', 'Off: use the GPU video layer directly', s.tenBitPresenter || 'auto')}</select>
        <small>Fixes white specks in dark areas of 10-bit video on some Intel GPUs.</small></label>
      <label class="field">Recent media<select id="pf-recent">${opt('true', 'Remember recently played media', s.saveRecent !== false)}${opt('false', 'Do not remember (private)', s.saveRecent !== false)}</select></label>
      <label class="field">Resume playback<select id="pf-resume">${opt('true', 'Continue where I left off', s.resumePlayback)}${opt('false', 'Always start from the beginning', s.resumePlayback)}</select></label>
      <h3>Conversion (compatibility mode)</h3>
      <label class="field">Video encoder<select id="pf-encoder">${opt('auto', `Auto${encs[0] ? ` (${encName[encs[0]] || encs[0]})` : ''}`, s.encoder)}
        ${encs.map((e) => opt(e, encName[e] || e, s.encoder)).join('')}</select>
        <small>Hardware encoders found working on this machine: ${esc(encs.filter((e) => e !== 'libx264').map((e) => encName[e]).join(', ') || 'none')}</small></label>
      <label class="field">Quality<select id="pf-quality">${opt('high', 'High', s.quality)}${opt('balanced', 'Balanced', s.quality)}${opt('fast', 'Fast (slower machines)', s.quality)}</select></label>
      <label class="field">Maximum height<select id="pf-maxh">${opt(0, 'Same as source', s.maxHeight)}${opt(2160, '2160p', s.maxHeight)}${opt(1440, '1440p', s.maxHeight)}${opt(1080, '1080p', s.maxHeight)}${opt(720, '720p', s.maxHeight)}</select></label>
      <h3>FFmpeg</h3>
      <label class="field">ffmpeg path<input id="pf-ffmpeg" type="text" value="${esc(s.ffmpegPath)}" placeholder="Automatic"><small>${esc(t && t.ffmpeg ? `${t.ffmpeg} — ${t.ffmpegVersion}` : (t && t.error) || '')}</small></label>
      <label class="field">ffprobe path<input id="pf-ffprobe" type="text" value="${esc(s.ffprobePath)}" placeholder="Automatic"><small>${esc(t && t.ffprobe ? `${t.ffprobe} — ${t.ffprobeVersion}` : '')}</small></label>`,
    [{ label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'save', primary: true }]);
    if (r !== 'save') return;
    const patch = {
      decodeMode: $('pf-mode').value, resumePlayback: $('pf-resume').value === 'true', saveRecent: $('pf-recent').value === 'true', tenBitPresenter: $('pf-tenbit').value, encoder: $('pf-encoder').value,
      quality: $('pf-quality').value, maxHeight: Number($('pf-maxh').value),
      ffmpegPath: $('pf-ffmpeg').value.trim(), ffprobePath: $('pf-ffprobe').value.trim(),
    };
    const modeChanged = patch.decodeMode !== s.decodeMode;
    const convChanged = patch.encoder !== s.encoder || patch.quality !== s.quality || patch.maxHeight !== s.maxHeight;
    state.settings = await aap.setSettings(patch);
    updatePresenter();
    osd('Preferences saved');
    if (engine.session && (modeChanged || (convChanged && engine.kind === 'transcode'))) engine.reload({ mode: patch.decodeMode });
  }

  const KEY_HELP = [
    ['Space', 'Play / Pause'], ['S', 'Stop'], ['N / P', 'Next / Previous'], ['F, double-click', 'Fullscreen'], ['Esc', 'Leave fullscreen'],
    ['← / →', 'Jump 10 s'], ['Shift+← / →', 'Jump 3 s'], ['Alt+← / →', 'Jump 10 s'], ['Ctrl+← / →', 'Jump 1 min'], ['Ctrl+Alt+← / →', 'Jump 5 min'],
    ['↑ / ↓, Ctrl+↑ / ↓, wheel', 'Volume'], ['M', 'Mute'], ['+ / -', 'Faster / Slower'], ['[ / ]', 'Speed fine'], ['=', 'Normal speed'],
    ['E', 'Next frame'], ['T', 'Show position'], ['B', 'Cycle audio track'], ['V / Shift+V', 'Cycle subtitles / toggle'],
    ['H / G', 'Subtitle delay ±50 ms'], ['Ctrl+wheel', 'Subtitle size'], ['A', 'Cycle aspect ratio'], ['Shift+S', 'Snapshot'],
    ['L', 'Loop mode'], ['R', 'Random'], ['Ctrl+O / Ctrl+F / Ctrl+N', 'Open file / folder / stream'], ['Ctrl+L', 'Playlist'],
    ['Ctrl+H', 'Minimal interface'], ['Ctrl+I / Ctrl+J', 'Media / codec information'], ['Ctrl+M', 'Messages'], ['Ctrl+P', 'Preferences'],
    ['Ctrl+T', 'Go to time'], ['Ctrl+Y', 'Save playlist'], ['Ctrl+E', 'Effects and filters'], ['Shift+R', 'Record'],
    ['Shift+L', 'Loop A→B'], ['Ctrl+D', 'Open disc'], ['Ctrl+C', 'Open capture device'], ['Ctrl+V', 'Open location from clipboard'],
    ['Ctrl+R', 'Convert / Save'], ['Ctrl+S', 'Stream'], ['F11', 'Fullscreen interface'], ['F1', 'Help'], ['Shift+F1', 'About'], ['Ctrl+Q', 'Quit'],
  ];

  async function showAbout() {
    const t = await aap.toolsInfo();
    showDialog('About AAPlayer', `
      <div style="display:flex;gap:16px;align-items:center"><svg style="width:64px;height:64px"><use href="#i-logo"/></svg>
      <div><b style="font-size:18px">AAPlayer ${esc(state.version || '')}</b><br><span style="color:var(--muted)">A VLC-inspired media player built with Electron, Chromium media and FFmpeg.</span></div></div>
      <h3>Components</h3><table>
      <tr><th>Electron</th><td>${esc(state.electron)}</td></tr><tr><th>Chromium</th><td>${esc(state.chrome)}</td></tr>
      <tr><th>FFmpeg</th><td>${esc((t && t.ffmpegVersion) || '')}</td></tr></table>
      <h3>Credits</h3><p style="line-height:1.5">Behaviour, hotkeys and format lists follow VLC media player by the VideoLAN team.
      AAPlayer is not affiliated with VideoLAN. Licensed under the GNU GPL v2 or later.</p>`);
  }

  /* ================= hotkeys (VLC Windows defaults) ================= */
  function keyName(e) {
    let k = e.key;
    if (k === ' ') k = 'Space';
    else if (k.length === 1) k = k.toLowerCase();
    return `${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey && k.length > 1 ? 'Shift+' : ''}${e.shiftKey && k.length === 1 && /[a-z]/.test(k) ? 'Shift+' : ''}${k}`;
  }

  const HOTKEYS = {
    'Space': togglePlay, 'MediaPlayPause': togglePlay, 's': stop, 'MediaStop': stop,
    'n': next, 'MediaTrackNext': next, 'p': prev, 'MediaTrackPrevious': prev,
    'f': () => setFullscreen(), 'F11': () => setFullscreen(), 'Escape': () => setFullscreen(false),
    'ArrowRight': () => jump(JUMP.s), 'ArrowLeft': () => jump(-JUMP.s),
    'Shift+ArrowRight': () => jump(JUMP.xs), 'Shift+ArrowLeft': () => jump(-JUMP.xs),
    'Alt+ArrowRight': () => jump(JUMP.s), 'Alt+ArrowLeft': () => jump(-JUMP.s),
    'Ctrl+ArrowRight': () => jump(JUMP.m), 'Ctrl+ArrowLeft': () => jump(-JUMP.m),
    'Ctrl+Alt+ArrowRight': () => jump(JUMP.l), 'Ctrl+Alt+ArrowLeft': () => jump(-JUMP.l),
    'ArrowUp': () => setVolume(state.volume + 0.05), 'ArrowDown': () => setVolume(state.volume - 0.05),
    'Ctrl+ArrowUp': () => setVolume(state.volume + 0.05), 'Ctrl+ArrowDown': () => setVolume(state.volume - 0.05),
    'm': () => { state.muted = !state.muted; applyVolume(); osd(state.muted ? 'Muted' : `Volume ${Math.round(state.volume * 100)}%`); pushMenuState(); },
    '+': () => rateStep(1), '-': () => rateStep(-1), '=': () => setRate(1),
    ']': () => setRate(video.playbackRate + 0.1), '[': () => setRate(video.playbackRate - 0.1),
    'e': frameNext,
    't': () => engine.session && osd(`${fmtTime(engine.time)} / ${fmtTime(engine.duration)}`, 2000),
    'b': cycleAudio, 'v': () => cycleSub(1),
    'Shift+v': () => selectSub(state.subs.selected ? null : (state.subs.tracks[0] || {}).id || null),
    'h': () => { state.subs.delay += 0.05; osd(`Subtitle delay ${Math.round(state.subs.delay * 1000)} ms`); },
    'g': () => { state.subs.delay -= 0.05; osd(`Subtitle delay ${Math.round(state.subs.delay * 1000)} ms`); },
    'a': () => setAspect(ASPECTS[(ASPECTS.indexOf(state.aspect) + 1) % ASPECTS.length]),
    'Shift+s': snapshot,
    'l': () => setLoop({ none: 'all', all: 'one', one: 'none' }[state.loop]),
    'r': () => setRandom(!state.random),
    'Ctrl+o': () => aap.menuAction('openFiles', false), 'Ctrl+Shift+o': () => aap.menuAction('openFiles', true),
    'Ctrl+f': () => aap.menuAction('openFolder'), 'Ctrl+n': showNetworkDialog,
    'Ctrl+l': () => togglePlaylist(), 'Ctrl+h': () => toggleMinimal(),
    'Ctrl+i': () => showMediaInfo(), 'Ctrl+j': () => showMediaInfo('codec'),
    'Ctrl+m': showMessages, 'Ctrl+p': showPreferences, 'Ctrl+t': showGotoDialog, 'Ctrl+y': savePlaylist,
    'Ctrl+q': () => aap.menuAction('quit'), 'F1': () => showHelp(), 'Shift+F1': () => showAbout(),
    'Ctrl+e': () => openEffects(), 'Ctrl+d': () => showDiscDialog(), 'Ctrl+c': () => showCaptureDialog(),
    'Ctrl+v': () => aap.menuAction('openClipboard'), 'Ctrl+r': () => showConvertDialog(), 'Ctrl+s': () => showVlmDialog(true), 'Ctrl+Shift+w': () => showVlmDialog(false), 'Shift+r': () => toggleRecord(), 'Shift+l': () => abLoop(), 'F11': () => toggleFullscreenInterface(),
    'Ctrl+0': () => { setSubScale(1); osd('Subtitle size 100%'); },
    'Ctrl+=': () => { setSubScale((state.settings.subtitleScale || 1) + 0.1); osd(`Subtitle size ${Math.round(state.settings.subtitleScale * 100)}%`); },
    'Ctrl+-': () => { setSubScale((state.settings.subtitleScale || 1) - 0.1); osd(`Subtitle size ${Math.round(state.settings.subtitleScale * 100)}%`); },
  };

  document.addEventListener('keydown', (e) => {
    if ($('dialog').open) return; // the dialog handles its own keys (Esc closes)
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    const name = keyName(e);
    const fn = HOTKEYS[name];
    if (!fn) return;
    e.preventDefault();
    if (e.target.closest && e.target.closest('button') && (name === 'Space' || name === 'Enter')) e.target.blur();
    fn();
    showControls();
  });

  function toggleMinimal() {
    state.minimal = !state.minimal;
    stage.classList.toggle('minimal', state.minimal);
    pushMenuState();
  }

  /* ================= menu commands from main ================= */
  const COMMANDS = {
    'open-files': ({ inputs, play }) => openInputs(inputs, play),
    'open-input': (input) => openInputs([input]),
    'open-network': showNetworkDialog,
    'save-playlist': savePlaylist,
    'toggle-play': togglePlay, 'stop': stop, 'next': next, 'prev': prev,
    'rate-step': rateStep, 'rate-fine': (d) => setRate(video.playbackRate + d), 'rate': setRate,
    'jump': jump, 'goto-time': showGotoDialog, 'frame-next': frameNext, 'seek': (t) => engine.seek(t),
    'loop': setLoop, 'random-toggle': () => setRandom(!state.random),
    'audio-track': setAudioTrack, 'audio-cycle': cycleAudio,
    'volume-step': (d) => setVolume(state.volume + d), 'mute-toggle': HOTKEYS.m,
    'fullscreen-toggle': () => setFullscreen(),
    'fullscreen-changed': (fs) => {
      state.fullscreen = fs;
      if (!fs && state.fullscreenInterface) { state.fullscreenInterface = false; document.body.classList.remove('fs-interface'); pushMenuState(); }
      document.body.classList.toggle('fullscreen', fs); $('btn-fullscreen').innerHTML = `<svg><use href="#i-${fs ? 'unfull' : 'full'}"/></svg>`; },
    'aspect': setAspect, 'aspect-cycle': HOTKEYS.a, 'zoom': (z) => { state.zoom = z; layoutVideo(); pushMenuState(); },
    'snapshot': snapshot, 'decode-mode': setDecodeMode,
    'add-subtitle': addSubtitleFile, 'sub-track': (id) => selectSub(id), 'sub-cycle': () => cycleSub(1),
    'sub-delay': (d) => { state.subs.delay += d; osd(`Subtitle delay ${Math.round(state.subs.delay * 1000)} ms`); },
    'sub-scale': (d) => { setSubScale((state.settings.subtitleScale || 1) + d); osd(`Subtitle size ${Math.round(state.settings.subtitleScale * 100)}%`); },
    'media-info': showMediaInfo, 'messages': showMessages, 'preferences': showPreferences,
    'playlist-toggle': () => togglePlaylist(), 'minimal-toggle': toggleMinimal,
    'help-keys': () => showDialog('Keyboard Shortcuts', `<div class="keys">${KEY_HELP.map(([k, d]) => `<div><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join('')}</div>`),
    'about': showAbout, 'help': showHelp, 'check-updates': checkUpdates,
    'video-track': setVideoTrack, 'audio-device': setAudioDevice, 'stereo-mode': setStereoMode, 'visualization': (m) => setVisualization(m),
    'crop': setCrop, 'fit-window-toggle': () => { setSetting({ fitWindow: !state.settings.fitWindow }); if (state.settings.fitWindow && engine.session) fitWindowToVideo(); },
    'wallpaper': setWallpaper,
    'deinterlace': (v) => setDeinterlace({ deinterlace: v }, `Deinterlace: ${{ off: 'Off', auto: 'Automatic', on: 'On' }[v]}`),
    'deinterlace-mode': (v) => setDeinterlace({ deinterlaceMode: v }, `Deinterlace mode: ${v}`),
    'record-toggle': toggleRecord,
    'record-stopped': (file) => { state.recording = false; $('adv-record').classList.remove('on'); $('tb-record').classList.remove('on'); osd(`Recording saved: ${String(file).split(/[\\/]/).pop()}`, 4000, true); pushMenuState(); },
    'ab-loop': abLoop, 'effects': (tab) => openEffects(tab),
    'open-disc': showDiscDialog, 'open-capture': showCaptureDialog, 'convert': showConvertDialog,
    'quit-at-end-toggle': () => { state.quitAtEnd = !state.quitAtEnd; osd(state.quitAtEnd ? 'Quit at the end of playlist: on' : 'Quit at the end of playlist: off'); pushMenuState(); },
    'osd': (text) => osd(String(text), 3000, true), 'convert-progress': onConvertProgress,
    'volume-set': (v) => setVolume(v), 'play-index': (i) => playIndex(Math.trunc(i)),
    'remote-active': (on) => { remoteActive = !!on; }, 'web-remote': showRemoteDialog,
    'vlm': (arg) => showVlmDialog(arg === 'current'), 'vlsub': showVlsubDialog, 'customize': showCustomize,
    'save-recent-toggle': () => { const on = state.settings.saveRecent === false; setSetting({ saveRecent: on }); osd(on ? 'Recent media: on' : 'Recent media: off (history cleared)', 2500, true); },
    'resume-toggle': () => { const on = state.settings.resumePlayback === false; setSetting({ resumePlayback: on }); osd(on ? 'Remember position: on' : 'Remember position: off (positions cleared)', 2500, true); },
    'playlist-dock-toggle': () => { setSetting({ playlistDocked: state.settings.playlistDocked === false }); applyViewSettings(); togglePlaylist(true); },
    'status-bar-toggle': () => { setSetting({ statusBar: !state.settings.statusBar }); applyViewSettings(); renderStatusBar(); },
    'advanced-controls-toggle': () => { setSetting({ advancedControls: !state.settings.advancedControls }); applyViewSettings(); },
    'fullscreen-interface': toggleFullscreenInterface,
  };
  aap.onCommand((name, arg) => {
    const fn = COMMANDS[name];
    if (fn) fn(arg);
  });

  let menuTimer = null;
  function pushMenuState() {
    clearTimeout(menuTimer);
    menuTimer = setTimeout(() => {
      const s = engine.session;
      aap.setMenuState({
        hasMedia: !!s, hasVideo: engine.hasVideo, playing: !!s && !video.paused,
        audioTracks: audioTracks(), videoTracks: videoTracks(),
        subTracks: state.subs.tracks.map((t) => ({ id: t.id, label: t.label, selected: t.id === state.subs.selected })),
        chapters: s ? s.info.chapters : [], loop: state.loop, random: state.random, muted: state.muted,
        aspect: state.aspect, crop: state.crop, zoom: state.zoom, decodeMode: state.settings.decodeMode,
        playlistVisible: !$('playlist').hidden, minimal: state.minimal,
        stereoMode: state.stereoMode, audioDevices: state.audioDevices, audioDevice: state.settings.audioDevice || '',
        visualization: state.settings.visualization || 'off', deinterlace: state.settings.deinterlace,
        deinterlaceMode: state.settings.deinterlaceMode, fitWindow: !!state.settings.fitWindow,
        saveRecent: state.settings.saveRecent !== false, resumePlayback: state.settings.resumePlayback !== false,
        playlistDocked: state.settings.playlistDocked !== false, statusBar: !!state.settings.statusBar,
        advancedControls: !!state.settings.advancedControls, recording: state.recording, quitAtEnd: !!state.quitAtEnd,
        fullscreenInterface: state.fullscreenInterface,
      });
    }, 80);
  }

  function setSetting(patch) {
    Object.assign(state.settings, patch);
    aap.setSettings(patch);
    pushMenuState();
  }

  /* ================= video tracks ================= */
  function videoTracks() {
    const s = engine.session;
    if (!s) return [];
    return s.info.video.filter((v) => !v.attachedPic).map((v, i) => ({
      index: v.index, selected: v.index === s.plan.videoIndex,
      label: [`Track ${i + 1}`, v.title, v.lang && v.lang !== 'und' ? v.lang : '', `${v.codec.toUpperCase()} ${v.width}×${v.height}`].filter(Boolean).join(' · '),
    }));
  }
  function setVideoTrack(index) {
    if (!engine.session || index === engine.session.plan.videoIndex) return;
    engine.reload({ videoIndex: index }, 'Switching video track…');
  }

  /* ================= audio device / stereo / visualizations ================= */
  async function refreshAudioDevices() {
    state.audioDevices = await AudioChain.devices();
    pushMenuState();
  }
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', refreshAudioDevices);

  async function setAudioDevice(id) {
    const ok = await audioChain.setSink(id);
    if (!ok) { osd('Could not switch audio device'); return; }
    setSetting({ audioDevice: id });
    const d = state.audioDevices.find((x) => x.id === id);
    osd(`Audio device: ${d ? d.label : 'Default'}`, 2000, true);
  }

  function setStereoMode(mode) {
    ensureAudioGraph();
    audioChain.setStereoMode(mode);
    state.stereoMode = mode;
    osd(`Stereo mode: ${{ stereo: 'Stereo', mono: 'Mono', left: 'Left', right: 'Right', reverse: 'Reverse stereo' }[mode]}`);
    pushMenuState();
  }

  function setVisualization(mode, quiet) {
    if (!quiet) setSetting({ visualization: mode });
    viz.setMode(engine.session && !engine.hasVideo ? mode : 'off', audioChain.analyser);
    $('audio-art').classList.toggle('has-viz', !$('viz').hidden);
    if (!quiet) osd(mode === 'off' ? 'Visualizations off' : `Visualization: ${mode === 'vumeter' ? 'VU Meter' : mode[0].toUpperCase() + mode.slice(1)}`);
  }

  /* ================= geometry: aspect, crop, zoom, rotate/flip ================= */
  function ratioOf(str) {
    const [a, b] = String(str).split(':').map(Number);
    return a > 0 && b > 0 ? a / b : 0;
  }
  function layoutVideo() {
    const s = video.style;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const geo = vfx.geometry();
    const filter = vfx.filter();
    const plain = state.aspect === 'default' && state.crop === 'default' && !state.zoom && !geo.rotate && geo.sx === 1 && geo.sy === 1;
    if (!vw || !vh || plain) { s.cssText = ''; s.filter = filter; $('vcanvas').style.cssText = s.cssText; return; }
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    const quarter = geo.rotate === 90 || geo.rotate === 270;
    const availW = quarter ? H : W;
    const availH = quarter ? W : H;
    let w; let h; let fit = 'fill';
    if (state.aspect === 'fill' && state.crop === 'default') { w = availW; h = availH; }
    else {
      const crop = ratioOf(state.crop);
      const r = crop || ratioOf(state.aspect) || vw / vh;
      if (crop) fit = 'cover';
      if (state.zoom) { h = (vh * state.zoom) / (window.devicePixelRatio || 1); w = h * r; }
      else { w = Math.min(availW, availH * r); h = w / r; }
    }
    s.cssText = `object-fit:${fit};width:${w}px;height:${h}px;left:${(W - w) / 2}px;top:${(H - h) / 2}px;` +
      `transform:rotate(${geo.rotate}deg) scale(${geo.sx},${geo.sy})`;
    s.filter = filter;
    $('vcanvas').style.cssText = s.cssText;
  }
  new ResizeObserver(layoutVideo).observe(stage);

  function setAspect(a) {
    state.aspect = a;
    layoutVideo();
    osd(`Aspect ratio: ${a === 'default' ? 'Default' : a === 'fill' ? 'Stretch' : a}`);
    pushMenuState();
  }
  function setCrop(c) {
    state.crop = c;
    layoutVideo();
    osd(`Crop: ${c === 'default' ? 'Default' : c}`);
    pushMenuState();
  }

  function fitWindowToVideo() {
    const v = engine.info && engine.info.video.find((x) => x.index === engine.session.plan.videoIndex);
    if (v && v.width && v.height) aap.resizeToVideo(v.width, v.height);
  }

  /* ================= deinterlace (applied by the FFmpeg pipeline) ================= */
  function setDeinterlace(patch, label) {
    setSetting(patch);
    if (engine.session) engine.reload({}, label);
    else osd(label);
  }

  /* ================= record / A-B loop / wallpaper ================= */
  async function toggleRecord() {
    if (engine.kind === 'capture' || captureRecorder) { toggleCaptureRecord(); return; }
    if (!state.recording && !engine.session) return;
    try {
      const r = await aap.recordToggle({ input: engine.input, time: engine.time, title: titleOf(engine.input || '') });
      state.recording = r.recording;
      osd(r.recording ? 'Recording…' : `Recording saved: ${r.file.split(/[\\/]/).pop()}`, r.recording ? 1500 : 4000, true);
    } catch (e) { osd(`Record failed: ${cleanError(e)}`, 4000, true); }
    for (const id of ['adv-record', 'tb-record']) $(id).classList.toggle('on', state.recording);
    renderStatusBar();
    pushMenuState();
  }

  function abLoop() {
    if (!engine.session) return;
    const ab = state.ab;
    if (ab.a == null) { ab.a = engine.time; osd(`A-B loop: A = ${fmtTime(ab.a)}`); }
    else if (ab.b == null) {
      if (engine.time <= ab.a + 0.2) { osd('B must be after A'); return; }
      ab.b = engine.time; osd(`A-B loop: ${fmtTime(ab.a)} → ${fmtTime(ab.b)}`); engine.seek(ab.a);
    } else { state.ab = { a: null, b: null }; osd('A-B loop off'); }
    for (const btn of [$('adv-ab'), $('tb-ab')]) {
      btn.classList.toggle('on', state.ab.a != null);
      btn.textContent = state.ab.b != null ? 'A↔B' : state.ab.a != null ? 'A→?' : 'A→B';
    }
  }

  async function setWallpaper() {
    if (!engine.hasVideo || !video.videoWidth) return;
    try {
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      await aap.setWallpaper(c.toDataURL('image/png'));
      osd('Current frame set as desktop wallpaper', 2500, true);
    } catch (e) { osd(`Wallpaper failed: ${cleanError(e)}`, 4000, true); }
  }

  /* ================= view: dock, status bar, advanced controls, fullscreen interface ================= */
  function applyViewSettings() {
    $('playlist').classList.toggle('floating', state.settings.playlistDocked === false);
    $('statusbar').hidden = !state.settings.statusBar;
    $('advanced-row').hidden = !state.settings.advancedControls;
    requestAnimationFrame(layoutVideo);
  }
  function renderStatusBar() {
    if ($('statusbar').hidden) return;
    const s = engine.session;
    $('sb-rec').hidden = !state.recording;
    if (!s) { $('sb-mode').textContent = 'Stopped'; $('sb-info').textContent = ''; $('sb-time').textContent = ''; $('sb-rate').textContent = ''; return; }
    $('sb-mode').textContent = $('mode-chip').textContent;
    const v = s.info.video.find((x) => x.index === s.plan.videoIndex);
    const a = s.info.audio.find((x) => x.index === s.plan.audioIndex);
    $('sb-info').textContent = [v && `${v.width}×${v.height}${v.fps ? ` ${v.fps.toFixed(2)} fps` : ''}`, a && `${a.codec.toUpperCase()} ${a.channels}ch`].filter(Boolean).join(' · ');
    $('sb-rate').textContent = `${video.playbackRate.toFixed(2)}×`;
    $('sb-time').textContent = `${fmtTime(engine.time)} / ${fmtTime(engine.duration)}`;
  }
  async function toggleFullscreenInterface() {
    const on = !state.fullscreenInterface;
    state.fullscreenInterface = on;
    document.body.classList.toggle('fs-interface', on);
    await setFullscreen(on, on);
    pushMenuState();
  }

  /* ================= Effects and Filters / Track Synchronization ================= */
  let fxTab = 'audio';
  function slider(id, label, min, max, step, value, unit = '') {
    return `<label class="fx-row"><span>${esc(label)}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}"><output for="${id}">${value}${unit}</output></label>`;
  }
  function renderFx() {
    $('fx-tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === fxTab));
    const body = $('fx-body');
    if (fxTab === 'audio') {
      const eq = audioChain.state.eq;
      const preset = state.settings.eq && state.settings.eq.preset;
      body.innerHTML = `
        <div class="fx-head"><label><input type="checkbox" id="eq-on" ${eq.enabled ? 'checked' : ''}> Enable equalizer</label>
          <select id="eq-preset">${preset === 'custom' ? '<option value="custom" selected>Custom</option>' : ''}${Object.entries(EQ_PRESETS).map(([k, [name]]) => `<option value="${k}"${k === preset ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></div>
        <div class="eq ${eq.enabled ? '' : 'off'}">
          <div class="eq-band"><input type="range" id="eq-pre" min="-20" max="20" step="0.1" value="${eq.preamp}"><span>${eq.preamp.toFixed(1)} dB</span><b>Preamp</b></div>
          ${EQ_FREQS.map((f, i) => `<div class="eq-band"><input type="range" data-band="${i}" min="-20" max="20" step="0.1" value="${eq.bands[i]}"><span>${eq.bands[i].toFixed(1)} dB</span><b>${f >= 1000 ? `${f / 1000}k` : f}</b></div>`).join('')}
        </div>
        <h3>Stereo mode</h3>
        <div class="seg">${[['stereo', 'Stereo'], ['mono', 'Mono'], ['left', 'Left'], ['right', 'Right'], ['reverse', 'Reverse']].map(([k, n]) => `<button type="button" data-stereo="${k}" class="${state.stereoMode === k ? 'on' : ''}">${n}</button>`).join('')}</div>`;
      const saveEq = (patch) => {
        const next = { ...audioChain.state.eq, ...patch };
        ensureAudioGraph();
        audioChain.setEq(next);
        setSetting({ eq: { enabled: next.enabled, preamp: next.preamp, bands: next.bands, preset: patch.preset || (state.settings.eq || {}).preset || 'flat' } });
      };
      $('eq-on').addEventListener('change', (e) => { saveEq({ enabled: e.target.checked }); renderFx(); });
      $('eq-preset').addEventListener('change', (e) => {
        if (!EQ_PRESETS[e.target.value]) return;
        const [, preamp, bands] = EQ_PRESETS[e.target.value];
        saveEq({ enabled: true, preamp, bands: bands.slice(), preset: e.target.value });
        renderFx();
      });
      $('eq-pre').addEventListener('input', (e) => { saveEq({ preamp: Number(e.target.value) }); e.target.nextElementSibling.textContent = `${Number(e.target.value).toFixed(1)} dB`; });
      body.querySelectorAll('[data-band]').forEach((el) => el.addEventListener('input', (e) => {
        const bands = audioChain.state.eq.bands.slice();
        bands[Number(e.target.dataset.band)] = Number(e.target.value);
        saveEq({ bands, preset: 'custom' });
        e.target.nextElementSibling.textContent = `${Number(e.target.value).toFixed(1)} dB`;
      }));
      body.querySelectorAll('[data-stereo]').forEach((b) => b.addEventListener('click', () => { setStereoMode(b.dataset.stereo); renderFx(); }));
    } else if (fxTab === 'video') {
      const v = vfx.state;
      body.innerHTML = `<h3>Image adjustment</h3>
        ${slider('vf-brightness', 'Brightness', 0, 2, 0.01, v.brightness)}${slider('vf-contrast', 'Contrast', 0, 2, 0.01, v.contrast)}
        ${slider('vf-saturation', 'Saturation', 0, 3, 0.01, v.saturation)}${slider('vf-hue', 'Hue', -180, 180, 1, v.hue, '°')}
        ${slider('vf-gamma', 'Gamma', 0.2, 3, 0.01, v.gamma)}${slider('vf-sharpen', 'Sharpen', 0, 2, 0.01, v.sharpen)}
        <h3>Geometry</h3>
        <label class="fx-row"><span>Transform</span><select id="vf-transform">${window.AAPVideoFx.TRANSFORMS.map(([k, n]) => `<option value="${k}"${k === v.transform ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <div class="fx-actions"><button type="button" id="vf-reset">Reset</button></div>`;
      for (const k of ['brightness', 'contrast', 'saturation', 'hue', 'gamma', 'sharpen']) {
        $(`vf-${k}`).addEventListener('input', (e) => {
          vfx.set({ [k]: Number(e.target.value) });
          e.target.nextElementSibling.textContent = `${e.target.value}${k === 'hue' ? '°' : ''}`;
          layoutVideo();
        });
      }
      $('vf-transform').addEventListener('change', (e) => { vfx.set({ transform: e.target.value }); layoutVideo(); });
      $('vf-reset').addEventListener('click', () => { vfx.reset(); layoutVideo(); renderFx(); });
    } else {
      body.innerHTML = `<h3>Audio/Video</h3>
        ${slider('sync-audio', 'Audio delay (s)', 0, 10, 0.05, audioChain.state.delay.toFixed(2))}
        <p class="fx-note">Delays the audio when it plays ahead of the picture.</p>
        <h3>Subtitles/Video</h3>
        ${slider('sync-sub', 'Subtitle delay (s)', -30, 30, 0.05, state.subs.delay.toFixed(2))}
        <div class="fx-actions"><button type="button" id="sync-reset">Reset</button></div>`;
      $('sync-audio').addEventListener('input', (e) => { ensureAudioGraph(); audioChain.setDelay(Number(e.target.value)); e.target.nextElementSibling.textContent = Number(e.target.value).toFixed(2); });
      $('sync-sub').addEventListener('input', (e) => { state.subs.delay = Number(e.target.value); state.subs.html = ''; e.target.nextElementSibling.textContent = Number(e.target.value).toFixed(2); });
      $('sync-reset').addEventListener('click', () => { audioChain.setDelay(0); state.subs.delay = 0; state.subs.html = ''; renderFx(); });
    }
  }
  function openEffects(tab) {
    fxTab = tab || fxTab;
    renderFx();
    const d = $('fx-dialog');
    if (!d.open) d.show();
  }
  $('fx-tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { fxTab = b.dataset.tab; renderFx(); } });
  $('fx-close').addEventListener('click', () => $('fx-dialog').close());
  $('fx-dialog').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('fx-dialog').close(); e.stopPropagation(); });

  /* ================= help / updates ================= */
  function showHelp() {
    showDialog('Help', `
      <h3>Playing media</h3><p>Open files with <kbd>Ctrl+O</kbd>, a folder with <kbd>Ctrl+F</kbd>, or drop files on the window. Drop a subtitle file onto a playing video to add it.</p>
      <h3>10-bit and difficult files</h3><p>AAPlayer decodes natively when it can and converts to 8-bit H.264 when it can't. If playback stalls or fails, it recovers by itself. <b>Tools › Codec Information</b> (<kbd>Ctrl+J</kbd>) shows why; <b>Video › Decoding Mode</b> forces a mode.</p>
      <h3>Privacy</h3><p>Turn off <b>Tools › Remember Recent Media</b> and <b>Remember Playback Position</b> to stop AAPlayer storing what you play. Turning them off also deletes what was stored.</p>
      <h3>Shortcuts</h3><div class="keys">${KEY_HELP.map(([k, d]) => `<div><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join('')}</div>`);
  }
  function checkUpdates() {
    showDialog('Check for Updates', `<p>You are running <b>AAPlayer ${esc(state.version || '')}</b>.</p>
      <p>No update server is configured for this build, so AAPlayer can't check for newer versions.</p>`);
  }

  /* ================= Tools > Customize Interface (toolbar editor) ================= */
  const TB_ITEMS = [
    ['play', 'Play / Pause', true], ['prev', 'Previous', true], ['stop', 'Stop', true], ['next', 'Next', true],
    ['loop', 'Loop', true], ['random', 'Random', true], ['playlist', 'Playlist', true],
    ['record', 'Record', false], ['snapshot', 'Snapshot', false], ['ab', 'Loop A→B', false], ['frame', 'Next frame', false],
    ['effects', 'Effects and Filters', false], ['mode', 'Decoding mode badge', true], ['spacer', '— Flexible space —', true],
    ['speed', 'Speed', true], ['audio', 'Audio track', true], ['subs', 'Subtitles', true], ['mute', 'Mute', true],
    ['volume', 'Volume slider', true], ['fullscreen', 'Fullscreen', true],
  ];
  const TB_LABEL = Object.fromEntries(TB_ITEMS.map(([id, label]) => [id, label]));
  function toolbarConfig() {
    const saved = Array.isArray(state.settings.toolbar) ? state.settings.toolbar.filter((t) => TB_LABEL[t.id]) : [];
    const missing = TB_ITEMS.filter(([id]) => !saved.some((t) => t.id === id)).map(([id, , visible]) => ({ id, visible }));
    return [...saved, ...missing];
  }
  function applyToolbar(config = toolbarConfig()) {
    const bar = $('toolbar');
    for (const { id, visible } of config) {
      const el = bar.querySelector(`[data-tb="${id}"]`);
      if (!el) continue;
      bar.appendChild(el);
      el.classList.toggle('tb-hidden', !visible);
    }
  }
  async function showCustomize() {
    let config = toolbarConfig();
    const render = () => {
      $('cust-list').innerHTML = config.map((t, i) => `<li data-i="${i}"><label><input type="checkbox" ${t.visible ? 'checked' : ''}> ${esc(TB_LABEL[t.id])}</label>
        <span><button type="button" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button type="button" data-move="1" ${i === config.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button></span></li>`).join('');
      applyToolbar(config); // live preview
    };
    const done = showDialog('Customize Interface', `<p class="muted">Choose which buttons appear on the bottom toolbar and their order. Items before the flexible space sit on the left.</p>
      <ul id="cust-list" class="cust-list"></ul><div class="fx-actions"><button type="button" id="cust-reset">Reset to default</button></div>`,
    [{ label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'save', primary: true }]);
    render();
    $('cust-list').addEventListener('change', (e) => { const li = e.target.closest('li'); config[Number(li.dataset.i)].visible = e.target.checked; applyToolbar(config); });
    $('cust-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-move]');
      if (!b) return;
      const i = Number(b.closest('li').dataset.i);
      const j = i + Number(b.dataset.move);
      [config[i], config[j]] = [config[j], config[i]];
      render();
    });
    $('cust-reset').addEventListener('click', () => { config = TB_ITEMS.map(([id, , visible]) => ({ id, visible })); render(); });
    if (await done === 'save') { setSetting({ toolbar: config }); osd('Toolbar saved'); }
    applyToolbar();
  }

  /* ================= View > Add Interface > Web Remote ================= */
  let remoteActive = false;
  setInterval(() => {
    if (!remoteActive) return;
    const s = engine.session;
    aap.remoteStatus({
      hasMedia: !!s, title: s ? (state.playlist[state.current] || {}).title || titleOf(engine.input || '') : '',
      playing: !!s && !video.paused, time: engine.time, duration: engine.duration, volume: state.volume, muted: state.muted,
      rate: video.playbackRate, playlist: state.playlist.slice(0, 500).map((p, i) => ({ title: p.title, current: i === state.current })),
    });
  }, 1000);

  async function showRemoteDialog() {
    let r = await aap.remoteGet();
    const render = () => {
      $('rm-body').innerHTML = `
        <label class="check"><input type="checkbox" id="rm-enabled" ${r.enabled ? 'checked' : ''}> Enable web remote</label>
        <label class="check"><input type="checkbox" id="rm-lan" ${r.allowLan ? 'checked' : ''}> Allow other devices on my network</label>
        <label class="field">Port<input type="text" id="rm-port" value="${r.port}" inputmode="numeric"></label>
        <h3>PIN</h3>
        <div class="pin-row"><span class="pin">${r.pin ? esc(r.pin) : '— (created when enabled)'}</span><button type="button" id="rm-newpin">New PIN</button></div>
        <p class="muted">Every browser must enter this PIN, including on this PC.${r.allowLan ? ' Windows may ask you to allow AAPlayer through the firewall.' : ''}</p>
        ${r.error ? `<div class="note">${esc(r.error)}</div>` : ''}
        <h3>Status</h3>
        <p>${r.running ? 'Running at:' : 'Off'}</p>
        ${r.running ? `<ul class="url-list">${r.urls.map((u) => `<li><code>${esc(u)}</code> <button type="button" data-copy="${esc(u)}">Copy</button></li>`).join('')}</ul>
          <button type="button" id="rm-open">Open on this PC</button>` : ''}`;
      const update = async (patch) => { r = await aap.remoteSet(patch); render(); pushMenuState(); };
      $('rm-enabled').addEventListener('change', (e) => update({ enabled: e.target.checked }));
      $('rm-lan').addEventListener('change', (e) => update({ allowLan: e.target.checked }));
      $('rm-port').addEventListener('change', (e) => update({ port: Number(e.target.value) }));
      $('rm-newpin').addEventListener('click', () => update({ newPin: true }));
      if ($('rm-open')) $('rm-open').addEventListener('click', () => aap.remoteOpen());
    };
    showDialog('Web Remote', '<div id="rm-body"></div>');
    render();
  }

  /* ================= Tools > VLM Configuration / Media > Stream… ================= */
  async function showVlmDialog(useCurrent) {
    let v = await aap.vlmGet();
    let chosen = useCurrent && engine.input ? engine.input : '';
    const render = () => {
      $('vlm-body').innerHTML = `
        <p class="muted">Stream media to TVs, phones or other PCs on your home network. Open the link in VLC or a browser on the other device;
          when asked to log in, use any user name and the PIN as the password.</p>
        <div class="pin-row"><span>PIN</span><span class="pin">${esc(v.pin)}</span><button type="button" id="vlm-newpin">New PIN</button></div>
        <h3>New stream</h3>
        <label class="field">Media<span class="pick"><input type="text" id="vlm-input" data-enter="vlm-start" value="${esc(chosen)}" placeholder="File path or URL">
          <button type="button" id="vlm-pick">Browse…</button>${engine.input ? '<button type="button" id="vlm-current">Current</button>' : ''}</span></label>
        <label class="field">Name<input type="text" id="vlm-name" data-enter="vlm-start" placeholder="Optional"></label>
        <label class="field">Mode<select id="vlm-mode"><option value="compatible">Compatible: converts to H.264/AAC, plays anywhere</option>
          <option value="original">Original file: no conversion, seekable</option></select></label>
        <div class="fx-actions"><button type="button" id="vlm-start" class="primary-btn">Start streaming</button></div>
        <p id="vlm-error" class="error"></p>
        <h3>Active streams</h3>
        ${v.streams.length ? `<ul class="url-list">${v.streams.map((s) => `<li><b>${esc(s.name)}</b> <small>${s.mode} · ${s.clients} watching</small>
          <button type="button" data-stop="${s.id}">Stop</button>
          ${s.urls.map((u) => `<div><code>${esc(u)}</code> <button type="button" data-copy="${esc(u)}">Copy</button></div>`).join('')}</li>`).join('')}</ul>
          <p class="muted">Streams stop when you stop them or quit AAPlayer. Windows may ask you to allow AAPlayer through the firewall.</p>`
    : '<p class="muted">None</p>'}`;
      $('vlm-newpin').addEventListener('click', async () => { v = { ...v, ...(await aap.vlmNewPin()) }; render(); });
      $('vlm-pick').addEventListener('click', async () => { const f = await aap.pickMedia(); if (f) { chosen = f; $('vlm-input').value = f; } });
      if ($('vlm-current')) $('vlm-current').addEventListener('click', () => { chosen = engine.input; $('vlm-input').value = chosen; });
      $('vlm-start').addEventListener('click', async () => {
        const input = $('vlm-input').value.trim();
        if (!input) { $('vlm-error').textContent = 'Choose something to stream'; return; }
        $('vlm-start').disabled = true;
        $('vlm-start').textContent = 'Starting…';
        try {
          v = { ...v, ...(await aap.vlmAdd({ input, name: $('vlm-name').value.trim(), mode: $('vlm-mode').value })) };
          chosen = '';
          render();
        } catch (e) { $('vlm-error').textContent = cleanError(e); $('vlm-start').disabled = false; $('vlm-start').textContent = 'Start streaming'; }
      });
      $('vlm-body').querySelectorAll('[data-stop]').forEach((b) => b.addEventListener('click', async () => {
        v = { ...v, ...(await aap.vlmRemove(b.dataset.stop)) };
        render();
      }));
    };
    showDialog('VLM Configuration', '<div id="vlm-body"></div>');
    render();
  }

  /* ================= View > VLsub (OpenSubtitles) ================= */
  const SUB_LANGS = [['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt-PT', 'Portuguese'],
    ['pt-BR', 'Portuguese (Brazil)'], ['nl', 'Dutch'], ['pl', 'Polish'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['ar', 'Arabic'],
    ['tr', 'Turkish'], ['el', 'Greek'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['id', 'Indonesian'], ['vi', 'Vietnamese'], ['zh-CN', 'Chinese (simplified)'],
    ['zh-TW', 'Chinese (traditional)'], ['ja', 'Japanese'], ['ko', 'Korean'], ['sv', 'Swedish'], ['no', 'Norwegian'], ['da', 'Danish'],
    ['fi', 'Finnish'], ['cs', 'Czech'], ['hu', 'Hungarian'], ['ro', 'Romanian'], ['yo', 'Yoruba'], ['ig', 'Igbo'], ['ha', 'Hausa']];

  async function showVlsubDialog() {
    const cfg = await aap.vlsubGet();
    const input = engine.input;
    const suggestion = input ? await aap.vlsubSuggest(input) : '';
    showDialog('VLsub', `
      <div class="note">Nothing is sent until you press Search. A search sends <b>the search text</b> and, if "Use file hash" is on,
        <b>a fingerprint (hash) and size of the video file</b> to opensubtitles.com. Your password is never saved.</div>
      <label class="field">API key<span class="pick"><input type="password" id="vs-key" value="${esc(cfg.apiKey)}" placeholder="OpenSubtitles API key" autocomplete="off">
        <button type="button" id="vs-key-save">Save</button></span>
        <small>Get a free key at <a href="https://www.opensubtitles.com/en/consumers" target="_blank" rel="noreferrer">opensubtitles.com/consumers</a></small></label>
      <label class="field">Language<select id="vs-lang">${SUB_LANGS.map(([c, n]) => `<option value="${c}"${c === cfg.language ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="field">Title<input type="text" id="vs-query" data-enter="vs-search" value="${esc(suggestion)}" placeholder="Movie or show name"></label>
      <label class="check"><input type="checkbox" id="vs-hash" ${input && !isUrl(input) ? 'checked' : 'disabled'}> Use file hash (most accurate match)</label>
      <details class="vs-login"><summary>Log in (optional, more downloads per day)</summary>
        <div id="vs-login-body">${cfg.loggedIn ? `<p>Logged in as ${esc(cfg.username)}. <button type="button" id="vs-logout">Log out</button></p>` : `
          <label class="field">User name<input type="text" id="vs-user" value="${esc(cfg.username)}" autocomplete="username"></label>
          <label class="field">Password<input type="password" id="vs-pass" data-enter="vs-login" autocomplete="current-password"></label>
          <div class="fx-actions"><button type="button" id="vs-login">Log in</button></div>`}</div></details>
      <div class="fx-actions"><button type="button" id="vs-search" class="primary-btn">Search</button></div>
      <p id="vs-msg" class="muted"></p>
      <table id="vs-results" class="vs-results"></table>`);
    const msg = (t, err) => { $('vs-msg').textContent = t; $('vs-msg').className = err ? 'error' : 'muted'; };
    $('vs-key-save').addEventListener('click', async () => { await aap.vlsubConfig({ apiKey: $('vs-key').value }); msg('API key saved'); });
    $('vs-lang').addEventListener('change', (e) => aap.vlsubConfig({ language: e.target.value }));
    if ($('vs-login')) $('vs-login').addEventListener('click', async () => {
      try { await aap.vlsubLogin($('vs-user').value.trim(), $('vs-pass').value); $('vs-pass').value = ''; msg('Logged in'); }
      catch (e) { msg(cleanError(e), true); }
    });
    if ($('vs-logout')) $('vs-logout').addEventListener('click', async () => { await aap.vlsubLogout(); msg('Logged out'); });
    $('vs-search').addEventListener('click', async () => {
      if ($('vs-key').value.trim() !== cfg.apiKey) { cfg.apiKey = $('vs-key').value.trim(); await aap.vlsubConfig({ apiKey: cfg.apiKey }); }
      msg('Searching…');
      $('vs-results').innerHTML = '';
      try {
        const results = await aap.vlsubSearch({ input, query: $('vs-query').value.trim(), languages: $('vs-lang').value, useHash: $('vs-hash').checked });
        msg(results.length ? `${results.length} result${results.length > 1 ? 's' : ''}` : 'No subtitles found');
        $('vs-results').innerHTML = results.slice(0, 60).map((r) => `<tr><td>${esc(r.release)}${r.hashMatch ? ' <span class="badge">exact match</span>' : ''}${r.hearingImpaired ? ' <span class="badge dim">HI</span>' : ''}</td>
          <td>${esc(r.language)}</td><td>${r.downloads}</td><td><button type="button" data-file="${r.fileId}" data-lang="${esc(r.language)}">Download</button></td></tr>`).join('');
      } catch (e) { msg(cleanError(e), true); }
    });
    $('vs-results').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-file]');
      if (!b) return;
      b.disabled = true;
      b.textContent = '…';
      try {
        const r = await aap.vlsubDownload({ fileId: Number(b.dataset.file), input, language: b.dataset.lang });
        b.textContent = 'Loaded';
        msg(`Saved ${r.file.split(/[\\/]/).pop()}${r.remaining !== undefined ? ` · ${r.remaining} downloads left today` : ''}`);
        if (engine.session && engine.input === input) addSubtitleFile(r.file);
      } catch (err) { b.disabled = false; b.textContent = 'Download'; msg(cleanError(err), true); }
    });
  }

  // Copy buttons in the network dialogs
  $('dialog').addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    navigator.clipboard.writeText(b.dataset.copy).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); });
  });

  /* ================= Media > Open Disc… ================= */
  async function showDiscDialog() {
    let drives = [];
    let titles = null;
    let folder = '';
    const render = () => {
      $('disc-body').innerHTML = `
        <p class="muted">Plays unprotected DVD and Blu-ray discs or folders (no disc menus). Copy-protected commercial discs can't be played.</p>
        <h3>Disc</h3>
        ${drives.length ? `<div class="seg">${drives.map((d) => `<button type="button" data-drive="${esc(d.path)}" class="${folder === d.path ? 'on' : ''}">${esc(d.label)}</button>`).join('')}</div>`
    : '<p class="muted">No disc found in your drives.</p>'}
        <div class="fx-actions"><button type="button" id="disc-rescan">Rescan drives</button> <button type="button" id="disc-browse">Choose folder…</button></div>
        ${folder ? `<p class="muted">${esc(folder)}</p>` : ''}
        <p id="disc-msg" class="error"></p>
        ${titles ? `<h3>${titles.type === 'dvd' ? 'DVD titles' : 'Blu-ray streams'}</h3>
          ${titles.protected ? '<div class="note">This Blu-ray is copy-protected (AACS) and can\'t be played.</div>' : ''}
          ${titles.titles.length ? `<ul class="url-list">${titles.titles.map((t, i) => `<li><b>${esc(t.label)}</b>${i === 0 ? ' <small>main title (largest)</small>' : ''}
            <button type="button" data-title="${i}">Play</button></li>`).join('')}</ul>` : '<p class="muted">No playable titles found.</p>'}` : ''}`;
      $('disc-rescan').addEventListener('click', scan);
      $('disc-browse').addEventListener('click', async () => { const f = await aap.pickFolder(); if (f) pick(f); });
      $('disc-body').querySelectorAll('[data-drive]').forEach((b) => b.addEventListener('click', () => pick(b.dataset.drive)));
      $('disc-body').querySelectorAll('[data-title]').forEach((b) => b.addEventListener('click', () => {
        const t = titles.titles[Number(b.dataset.title)];
        const name = `${titles.type === 'dvd' ? 'DVD' : 'Blu-ray'} ${titles.root.replace(/[\\/]+$/, '')} – ${t.label.split(' — ')[0]}`;
        $('dialog').close('ok');
        addAndPlay({ input: t.input, title: name, duration: 0 });
      }));
    };
    const pick = async (f) => {
      folder = f;
      titles = null;
      render();
      try { titles = await aap.discTitles(f); } catch (e) { titles = null; render(); $('disc-msg').textContent = cleanError(e); return; }
      render();
    };
    const scan = async () => { drives = await aap.discScan(); render(); if (drives.length === 1 && !folder) pick(drives[0].path); };
    showDialog('Open Disc', '<div id="disc-body"></div>');
    render();
    scan();
  }

  function addAndPlay(item) {
    state.playlist.push(item);
    renderPlaylist();
    playIndex(state.playlist.length - 1);
  }

  /* ================= Media > Open Capture Device… ================= */
  async function listCaptureDevices() {
    const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const name = (d, i, kind) => d.label || `${kind} ${i + 1}`;
    return {
      video: all.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: name(d, i, 'Camera') })),
      audio: all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId, label: name(d, i, 'Microphone') })),
    };
  }

  async function showCaptureDialog() {
    const devs = await listCaptureDevices();
    const opt = (list, none) => [none ? `<option value="">${none}</option>` : '', ...list.map((d) => `<option value="${esc(d.id)}">${esc(d.label)}</option>`)].join('');
    const done = showDialog('Open Capture Device', `
      <p class="muted">Your camera/microphone is used only while this capture plays. Nothing is saved unless you press Record (Shift+R).</p>
      <label class="field">Video device<select id="cap-video">${opt(devs.video, 'None')}</select></label>
      <label class="field">Audio device<select id="cap-audio">${opt(devs.audio, 'None')}</select>
        <small>Playing a microphone through your speakers can cause feedback; use headphones.</small></label>
      <label class="field">Resolution<select id="cap-res"><option value="">Device default</option><option value="1280x720">1280×720</option>
        <option value="1920x1080">1920×1080</option><option value="3840x2160">3840×2160</option></select></label>
      <label class="field">Frame rate<select id="cap-fps"><option value="">Device default</option><option value="30">30</option><option value="60">60</option></select></label>
      <p id="cap-msg" class="error"></p>`,
    [{ label: 'Cancel', value: 'cancel' }, { label: 'Play', value: 'play', primary: true }]);
    if (devs.video.length) $('cap-video').selectedIndex = 1;
    if (await done !== 'play') return;
    const cfg = { video: $('cap-video').value, audio: $('cap-audio').value, res: $('cap-res').value, fps: Number($('cap-fps').value) || 0 };
    if (!cfg.video && !cfg.audio) { osd('Choose a video or audio device'); return; }
    const label = [devs.video.find((d) => d.id === cfg.video), devs.audio.find((d) => d.id === cfg.audio)].filter(Boolean).map((d) => d.label).join(' + ');
    addAndPlay({ input: `capture://${label}`, title: label, duration: 0, capture: cfg });
  }

  async function startCapture(cfg, label) {
    const [w, h] = (cfg.res || '').split('x').map(Number);
    const constraints = {
      video: cfg.video ? { deviceId: { exact: cfg.video }, ...(w ? { width: { ideal: w }, height: { ideal: h } } : {}), ...(cfg.fps ? { frameRate: { ideal: cfg.fps } } : {}) } : false,
      audio: cfg.audio ? { deviceId: { exact: cfg.audio }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    };
    aap.armCapture(); // tells the main process this request comes from the user's choice
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      engine.loadCapture(stream, label, !!cfg.audio);
    } catch (e) {
      $('spinner').hidden = true;
      osd(`Could not open the capture device: ${e.message || e.name}`, 5000, true);
    }
  }

  /* ---- recording a capture device (MediaRecorder; files go to Videos\AAPlayer) ---- */
  let captureRecorder = null;
  async function toggleCaptureRecord() {
    if (captureRecorder) { captureRecorder.stop(); return; }
    const stream = video.srcObject;
    if (!stream) return;
    const type = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const chunks = [];
    captureRecorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    captureRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    captureRecorder.onstop = async () => {
      const blob = new Blob(chunks, { type: captureRecorder.mimeType });
      captureRecorder = null;
      state.recording = false;
      for (const id of ['adv-record', 'tb-record']) $(id).classList.remove('on');
      pushMenuState();
      try {
        const file = await aap.saveRecordingBlob(await blob.arrayBuffer(), blob.type.includes('mp4') ? 'mp4' : 'webm');
        osd(`Recording saved: ${file.split(/[\\/]/).pop()}`, 4000, true);
      } catch (e) { osd(`Saving the recording failed: ${cleanError(e)}`, 4000, true); }
    };
    captureRecorder.start(1000);
    state.recording = true;
    for (const id of ['adv-record', 'tb-record']) $(id).classList.add('on');
    osd('Recording…');
    pushMenuState();
  }

  /* ================= Media > Convert / Save… ================= */
  let convertJobs = new Map();
  let profilesCache = null;
  function renderConvertJobs() {
    const box = $('conv-jobs');
    if (!box) return;
    const jobs = [...convertJobs.values()];
    box.innerHTML = jobs.length ? jobs.map((j) => `<li><b>${esc(j.output.split(/[\\/]/).pop())}</b>
      <div class="progress"><div style="width:${Math.round(j.progress * 100)}%"></div></div>
      <small>${j.state === 'running' ? `${Math.round(j.progress * 100)}%${j.speed ? ` · ${esc(j.speed)}` : ''}` : j.state === 'done' ? 'Done' : j.state === 'cancelled' ? 'Cancelled' : `Failed: ${esc(j.error)}`}</small>
      ${j.state === 'running' ? `<button type="button" data-cancel="${j.id}">Cancel</button>` : j.state === 'done' ? `<button type="button" data-show="${esc(j.output)}">Show in folder</button>` : ''}</li>`).join('')
      : '<li class="muted">No conversions yet</li>';
  }
  async function showConvertDialog() {
    profilesCache = profilesCache || await aap.convertProfiles();
    for (const j of await aap.convertList()) convertJobs.set(j.id, j);
    const current = engine.kind !== 'capture' ? engine.input || '' : '';
    showDialog('Convert / Save', `
      <label class="field">Source<span class="pick"><input type="text" id="conv-input" value="${esc(current)}" placeholder="File or URL">
        <button type="button" id="conv-pick">Browse…</button></span></label>
      <label class="field">Profile<select id="conv-profile">${profilesCache.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select></label>
      <label class="field">Quality<select id="conv-quality"><option value="high">High</option><option value="balanced" selected>Balanced</option><option value="fast">Fast</option></select></label>
      <label class="field">Maximum height<select id="conv-maxh"><option value="0">Same as source</option><option value="2160">2160p</option><option value="1080">1080p</option><option value="720">720p</option><option value="480">480p</option></select></label>
      <label class="field">Start / end (optional)<span class="pick"><input type="text" id="conv-start" placeholder="0:00"><input type="text" id="conv-end" placeholder="end"></span></label>
      <p class="muted">10-bit H.264 and HDR sources are converted to 8-bit SDR for H.264; HEVC keeps 10-bit. Hardware encoders are used when available.</p>
      <div class="fx-actions"><button type="button" id="conv-start-btn" class="primary-btn">Convert…</button></div>
      <p id="conv-msg" class="error"></p>
      <h3>Jobs</h3><ul id="conv-jobs" class="url-list"></ul>
      <div class="fx-actions"><button type="button" id="conv-clear">Clear finished</button></div>`);
    renderConvertJobs();
    $('conv-pick').addEventListener('click', async () => { const f = await aap.pickMedia(); if (f) $('conv-input').value = f; });
    $('conv-clear').addEventListener('click', async () => {
      const list = await aap.convertClear();
      convertJobs = new Map(list.map((j) => [j.id, j]));
      renderConvertJobs();
    });
    $('conv-jobs').addEventListener('click', (e) => {
      const c = e.target.closest('[data-cancel]');
      if (c) aap.convertCancel(c.dataset.cancel);
      const s = e.target.closest('[data-show]');
      if (s) aap.showInFolder(s.dataset.show);
    });
    $('conv-start-btn').addEventListener('click', async () => {
      const input = $('conv-input').value.trim();
      const profile = profilesCache.find((p) => p.id === $('conv-profile').value);
      if (!input) { $('conv-msg').textContent = 'Choose a source'; return; }
      const start = $('conv-start').value.trim() ? parseTimeInput($('conv-start').value) : 0;
      const end = $('conv-end').value.trim() ? parseTimeInput($('conv-end').value) : 0;
      if (!Number.isFinite(start) || !Number.isFinite(end) || (end && end <= start)) { $('conv-msg').textContent = 'Invalid start/end time'; return; }
      const base = (isUrl(input) ? titleOf(input) : input.split(/[\\/]/).pop()).replace(/\.[^.]+$/, '').replace(/^concat:.*$/, 'disc');
      const output = await aap.savePath(`${base}.${profile.ext}`, profile.ext);
      if (!output) return;
      $('conv-msg').textContent = '';
      try {
        await aap.convertStart({ input, output, profile: profile.id, quality: $('conv-quality').value, maxHeight: Number($('conv-maxh').value), start, end });
      } catch (err) { $('conv-msg').textContent = cleanError(err); }
    });
  }
  function onConvertProgress(job) {
    const prev = convertJobs.get(job.id);
    convertJobs.set(job.id, job);
    renderConvertJobs();
    if (prev && prev.state === 'running' && job.state !== 'running' && !($('dialog').open && $('conv-jobs'))) {
      osd(job.state === 'done' ? `Conversion finished: ${job.output.split(/[\\/]/).pop()}` : `Conversion ${job.state}`, 4000, true);
    }
  }

  /* ================= main loop ================= */
  let lastSave = 0;
  let lastStatus = 0;
  function frame() {
    if (engine.session) {
      renderTime();
      renderSubs();
      const now = performance.now();
      if (now - lastSave > 5000 && !video.paused) { lastSave = now; saveResume(); }
      if (now - lastStatus > 250) { lastStatus = now; renderStatusBar(); }
      const ab = state.ab;
      if (ab.a != null && ab.b != null && engine.time >= ab.b) engine.seek(ab.a);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.addEventListener('beforeunload', saveResume);

  /* ================= startup ================= */
  (async function init() {
    stage.classList.add('no-media');
    const boot = await aap.init();
    state.settings = boot.settings || {};
    state.version = boot.version;
    state.electron = boot.electron;
    state.chrome = boot.chrome;
    state.volume = typeof state.settings.volume === 'number' ? state.settings.volume : 1;
    showRemaining = !!state.settings.showRemaining;
    document.documentElement.style.setProperty('--sub-scale', String(state.settings.subtitleScale || 1));
    if (state.settings.eq) audioChain.setEq(state.settings.eq);
    if (state.settings.audioDevice) audioChain.state.sinkId = state.settings.audioDevice;
    applyVolume();
    applyViewSettings();
    applyToolbar();
    renderPlaylist();
    aap.remoteGet().then((r) => { remoteActive = r.running; });
    renderStatusBar();
    refreshAudioDevices();
    if (boot.tools && boot.tools.error) osd(`FFmpeg problem: ${boot.tools.error}`, 10000, true);
    aap.log('ui', `codec support: ${JSON.stringify(engine.caps)}`);
    if (boot.startup && boot.startup.length) openInputs(boot.startup, true);
  }());
}());
