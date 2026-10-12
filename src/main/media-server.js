'use strict';
/*
 * Local media server (127.0.0.1 only). Every URL carries an unguessable
 * session id handed to the renderer over IPC, so other local software cannot
 * use it to read arbitrary files.
 *
 *   /f/<sid>          the original file, with HTTP Range support (direct play)
 *   /s/<sid>          ffmpeg fragmented-MP4 stream (remux / transcode)
 *   /t/<sid>?t=<sec>  JPEG thumbnail for the seek bar
 *
 * Decoding runs in separate ffmpeg processes: if a decoder ever hangs it can
 * only stall its own stream, never the player window, and it is killed as
 * soon as the renderer drops the connection.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', '3gp': 'video/3gpp',
};

/** Serves a local file with HTTP Range support (seekable playback). */
function sendFile(filePath, req, res, extraHeaders = {}) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { res.writeHead(404); return res.end(); }
  const type = MIME[path.extname(filePath).slice(1).toLowerCase()] || 'application/octet-stream';
  const size = stat.size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  let start = 0;
  let end = size - 1;
  if (range) {
    if (range[1] === '' && range[2] !== '') { start = Math.max(0, size - parseInt(range[2], 10)); }
    else { start = parseInt(range[1] || '0', 10); if (range[2]) end = Math.min(end, parseInt(range[2], 10)); }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
  }
  const headers = { ...extraHeaders, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

class MediaServer {
  constructor({ getTools, log }) {
    this.getTools = getTools;
    this.log = log || (() => {});
    this.sessions = new Map();
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.port = 0;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  base() { return `http://127.0.0.1:${this.port}`; }

  /** Registers a playable session for one window and returns its URLs. */
  createSession(owner, session) {
    this.closeOwner(owner);
    const sid = crypto.randomBytes(18).toString('hex');
    this.sessions.set(sid, { ...session, owner, child: null, thumbChild: null, thumbs: new Map() });
    return {
      sid,
      url: `${this.base()}/${session.kind === 'direct' ? 'f' : 's'}/${sid}`,
      thumbUrl: session.input && !session.isUrlStream ? `${this.base()}/t/${sid}` : null,
    };
  }

  /** Kills and forgets every session belonging to a window. */
  closeOwner(owner) {
    for (const [sid, s] of this.sessions) {
      if (s.owner !== owner) continue;
      this.kill(s.child);
      this.kill(s.thumbChild);
      this.sessions.delete(sid);
    }
  }

  kill(child) {
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill(); } catch { /* already gone */ }
    }
  }

  handle(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url, this.base());
    const [, route, sid] = url.pathname.split('/');
    const session = this.sessions.get(sid || '');
    if (!session) { res.writeHead(404); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (route === 'f') return this.serveFile(session, req, res);
    if (route === 's') return this.serveStream(session, req, res);
    if (route === 't') return this.serveThumb(session, url, res);
    res.writeHead(404); res.end();
  }

  serveFile(session, req, res) {
    sendFile(session.input, req, res);
  }

  serveStream(session, req, res) {
    const tools = this.getTools();
    // A new request for the same session replaces the previous ffmpeg.
    this.kill(session.child);
    res.writeHead(200, { 'Content-Type': session.audioOnly ? 'audio/mp4' : 'video/mp4' });
    if (req.method === 'HEAD') return res.end();

    const child = spawn(tools.ffmpeg, session.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    session.child = child;
    this.log('engine', `ffmpeg ${session.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    let bytes = 0;
    child.stdout.on('data', (d) => { bytes += d.length; });
    child.stderr.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) this.log('ffmpeg', line.trim());
    });
    child.on('error', (e) => { this.log('error', `ffmpeg failed to start: ${e.message}`); res.destroy(); });
    child.on('exit', (code, signal) => {
      if (code && !signal && bytes === 0) this.log('error', `ffmpeg exited with code ${code} before producing output`);
    });
    child.stdout.pipe(res);
    res.on('close', () => this.kill(child));
  }

  serveThumb(session, url, res) {
    const tools = this.getTools();
    const t = Math.max(0, parseFloat(url.searchParams.get('t')) || 0);
    const key = Math.round(t / 2) * 2;
    const cached = session.thumbs.get(key);
    if (cached) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(cached); }

    // Only the latest hover position matters: drop older pending thumbnails.
    this.kill(session.thumbChild);
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-skip_frame', 'nokey', '-noaccurate_seek',
      '-ss', key.toFixed(2), '-i', session.input, '-map', `0:${session.videoIndex}`, '-frames:v', '1',
      '-vf', 'scale=192:-2', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '6', 'pipe:1'];
    const child = spawn(tools.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    session.thumbChild = child;
    const chunks = [];
    const timer = setTimeout(() => this.kill(child), 8000);
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', () => {});
    child.on('close', () => {
      clearTimeout(timer);
      const img = Buffer.concat(chunks);
      if (!img.length) { res.writeHead(204); return res.end(); }
      if (session.thumbs.size > 300) session.thumbs.clear();
      session.thumbs.set(key, img);
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(img);
    });
    res.on('close', () => { if (!res.writableEnded) this.kill(child); });
  }

  close() {
    for (const s of this.sessions.values()) { this.kill(s.child); this.kill(s.thumbChild); }
    this.sessions.clear();
    this.server.close();
  }
}

module.exports = { MediaServer, sendFile, MIME };
