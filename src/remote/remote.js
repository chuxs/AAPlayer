/* AAPlayer web remote client. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let status = null;
  let seeking = false;
  let volDrag = false;
  let timer = null;

  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? { credentials: 'same-origin' } : {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.status === 401) { showLogin(); throw new Error('login'); }
    return res.json();
  }

  function showLogin(msg) {
    clearInterval(timer);
    $('remote').hidden = true;
    $('login').hidden = false;
    if (msg) $('login-error').textContent = msg;
    $('pin').focus();
  }

  function showRemote() {
    $('login').hidden = true;
    $('remote').hidden = false;
    poll();
    clearInterval(timer);
    timer = setInterval(poll, 1000);
  }

  async function poll() {
    try { status = await api('/api/status'); render(); } catch { /* handled */ }
  }

  function render() {
    const s = status || {};
    $('title').textContent = s.title || 'Nothing playing';
    $('sub').textContent = s.hasMedia ? `${s.playing ? 'Playing' : 'Paused'} · ${(s.rate || 1).toFixed(2)}×` : '';
    $('play').textContent = s.playing ? '⏸' : '▶';
    $('cur').textContent = fmt(s.time);
    $('dur').textContent = fmt(s.duration);
    if (!seeking) $('seek').value = s.duration ? Math.round((s.time / s.duration) * 1000) : 0;
    if (!volDrag) $('volume').value = Math.round((s.volume || 0) * 100);
    $('vol-text').textContent = s.muted ? 'Muted' : `${Math.round((s.volume || 0) * 100)}%`;
    $('mute').textContent = s.muted ? 'Unmute' : 'Mute';
    const list = $('playlist');
    const items = s.playlist || [];
    if (list.childElementCount !== items.length || [...list.children].some((li, i) => li.textContent !== items[i].title)) {
      list.innerHTML = '';
      items.forEach((it, i) => {
        const li = document.createElement('li');
        li.textContent = it.title;
        li.dataset.index = String(i);
        list.appendChild(li);
      });
    }
    [...list.children].forEach((li, i) => li.classList.toggle('current', !!(items[i] && items[i].current)));
  }

  const cmd = (name, arg) => api('/api/cmd', { cmd: name, arg }).then(() => setTimeout(poll, 150)).catch(() => {});

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    const res = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: $('pin').value.trim() }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) { $('pin').value = ''; showRemote(); } else $('login-error').textContent = body.error || 'Login failed';
  });

  document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => {
    cmd(b.dataset.cmd, b.dataset.arg !== undefined ? Number(b.dataset.arg) : undefined);
  }));
  $('seek').addEventListener('input', () => { seeking = true; if (status) $('cur').textContent = fmt(($('seek').value / 1000) * status.duration); });
  $('seek').addEventListener('change', () => { seeking = false; if (status && status.duration) cmd('seek', ($('seek').value / 1000) * status.duration); });
  $('volume').addEventListener('input', () => { volDrag = true; $('vol-text').textContent = `${$('volume').value}%`; });
  $('volume').addEventListener('change', () => { volDrag = false; cmd('volume-set', $('volume').value / 100); });
  $('playlist').addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) cmd('play-index', Number(li.dataset.index)); });

  // Already logged in?
  fetch('/api/status', { credentials: 'same-origin' }).then((r) => (r.ok ? showRemote() : showLogin())).catch(() => showLogin('AAPlayer is not reachable'));
}());
