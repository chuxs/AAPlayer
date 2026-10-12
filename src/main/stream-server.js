'use strict';
/*
 * VLM-style streaming to devices on the home network (Tools > VLM Configuration, Media > Stream…).
 *  - Runs only while at least one stream exists; listens on all interfaces.
 *  - Each stream has an unguessable URL; clients must also send the PIN as the
 *    HTTP Basic password (VLC, browsers and most TV apps prompt for it).
 *    Failed PINs are rate-limited per address.
 *  - "original" streams serve the file itself (seekable, any player that knows
 *    the codecs). "compatible" streams are converted on the fly to 8-bit
 *    H.264 + AAC fragmented MP4 that almost any device can play; add
 *    ?start=<seconds> to begin elsewhere.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sendFile } = require('./media-server');
const { safeEqual, FailureLimiter, lanAddresses, clientIp } = require('./net-security');
const { plan, buildStreamArgs } = require('./planner');

const NO_CAPS = { video: {}, audio: { aac: true, mp3: true } };
const MAX_CLIENTS_PER_STREAM = 4;

class StreamServer {
  constructor({ log, getTools, getInfo }) {
    this.log = log;
    this.getTools = getTools;
    this.getInfo = getInfo;
    this.streams = new Map();
    this.server = null;
    this.port = 0;
    this.pin = '';
    this.limiter = new FailureLimiter();
  }

  list() {
    return [...this.streams.values()].map((s) => ({
      id: s.id, name: s.name, input: s.input, mode: s.mode, clients: s.clients.size,
      urls: this.port ? lanAddresses().map((ip) => `http://${ip}:${this.port}/v/${s.id}/${encodeURIComponent(s.fileName)}`) : [],
    }));
  }

  async add({ input, name, mode, port, pin }) {
    if (!/^\d{6}$/.test(pin || '')) throw new Error('PIN must be 6 digits');
    if (mode === 'original' && /^[a-z][a-z0-9+.-]+:\/\//i.test(input)) throw new Error('Network inputs can only be streamed in compatible mode');
    const info = await this.getInfo(input);
    this.pin = pin;
    if (!this.server) await this.listen(port);
    const id = crypto.randomBytes(16).toString('hex');
    const base = (name || info.name || 'stream').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'stream';
    const fileName = mode === 'original' ? `${base}${path.extname(input) || '.mkv'}` : `${base}.mp4`;
    this.streams.set(id, { id, name: name || info.name, input, mode, info, fileName, clients: new Set() });
    this.log('vlm', `streaming "${name || info.name}" (${mode}) at ${this.list().find((s) => s.id === id).urls.join(', ')}`);
    return id;
  }

  async remove(id) {
    const s = this.streams.get(id);
    if (!s) return;
    for (const c of s.clients) c.destroy();
    this.streams.delete(id);
    this.log('vlm', `stopped "${s.name}"`);
    if (!this.streams.size) await this.close();
  }

  setPin(pin) { this.pin = pin; }

  listen(port) {
    const server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        this.server = server;
        this.port = server.address().port;
        this.log('vlm', `stream server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async close() {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    this.port = 0;
    await new Promise((resolve) => { s.close(() => resolve()); s.closeAllConnections?.(); });
    this.log('vlm', 'stream server stopped');
  }

  authorized(req, res) {
    const ip = clientIp(req);
    if (this.limiter.blocked(ip)) { res.writeHead(429); res.end('Too many attempts'); return false; }
    const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
    const pass = m ? Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':') : null;
    if (pass !== null && safeEqual(pass, this.pin)) { this.limiter.ok(ip); return true; }
    if (pass !== null) { this.limiter.fail(ip); this.log('vlm', `wrong PIN from ${ip}`); }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="AAPlayer stream (password = PIN)", charset="UTF-8"' });
    res.end('PIN required');
    return false;
  }

  handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (!this.authorized(req, res)) return;
    const url = new URL(req.url, 'http://x');
    const [, route, id] = url.pathname.split('/');
    if (url.pathname === '/') return this.index(res);
    const s = route === 'v' ? this.streams.get(id || '') : null;
    if (!s) { res.writeHead(404); return res.end(); }
    if (s.clients.size >= MAX_CLIENTS_PER_STREAM) { res.writeHead(503); return res.end('Too many viewers'); }
    s.clients.add(req.socket);
    res.on('close', () => s.clients.delete(req.socket));
    this.log('vlm', `${clientIp(req)} watching "${s.name}"`);
    if (s.mode === 'original') return sendFile(s.input, req, res);

    const tools = this.getTools();
    const start = Math.max(0, parseFloat(url.searchParams.get('start')) || 0);
    const p = plan(s.info, NO_CAPS, { mode: 'compat' });
    const { args } = buildStreamArgs(p, s.info, start, { ...tools, quality: 'balanced' });
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    if (req.method === 'HEAD') return res.end();
    const child = spawn(tools.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', (d) => this.log('vlm', String(d).trim()));
    child.on('error', () => res.destroy());
    child.stdout.pipe(res);
    res.on('close', () => { if (child.exitCode === null) child.kill(); });
  }

  index(res) {
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = [...this.streams.values()].map((s) => `<li><a href="/v/${s.id}/${encodeURIComponent(s.fileName)}">${esc(s.name)}</a> <small>${s.mode}</small></li>`).join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>AAPlayer streams</title>
      <body style="font:16px system-ui;background:#0b0b0f;color:#eee;padding:20px"><h1>AAPlayer streams</h1><ul>${rows || '<li>None</li>'}</ul>
      <style>a{color:#ff7a3d}small{color:#999}</style>`);
  }

  async closeAll() {
    for (const id of [...this.streams.keys()]) await this.remove(id);
  }
}

module.exports = { StreamServer };
