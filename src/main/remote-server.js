'use strict';
/*
 * Web remote (View > Add Interface > Web Remote), VLC's "web interface".
 *  - Off by default. Listens on 127.0.0.1 only, unless "Allow other devices"
 *    is enabled, then on all interfaces.
 *  - Every client must log in with the PIN; it gets an HttpOnly, SameSite
 *    cookie. Failed PINs are rate-limited per address.
 *  - Host header is checked (DNS-rebinding protection) and POSTs must come
 *    from the remote page itself (Origin check).
 *  - Only a fixed list of playback commands is accepted.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeEqual, FailureLimiter, lanAddresses, clientIp } = require('./net-security');

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/remote.js': ['remote.js', 'text/javascript; charset=utf-8'],
  '/remote.css': ['remote.css', 'text/css; charset=utf-8'],
};
const COMMANDS = new Set(['toggle-play', 'stop', 'next', 'prev', 'seek', 'jump', 'volume-set', 'volume-step', 'mute-toggle',
  'fullscreen-toggle', 'play-index', 'rate']);
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
};

class RemoteServer {
  constructor({ log, onCommand, getStatus }) {
    this.log = log;
    this.onCommand = onCommand;
    this.getStatus = getStatus;
    this.server = null;
    this.config = null;
    this.sessions = new Set();
    this.limiter = new FailureLimiter();
  }

  get running() { return !!this.server; }

  urls() {
    if (!this.config) return [];
    const port = this.config.port;
    return [`http://localhost:${port}/`, ...(this.config.allowLan ? lanAddresses().map((ip) => `http://${ip}:${port}/`) : [])];
  }

  async start(config) {
    await this.stop();
    if (!/^\d{6}$/.test(config.pin || '')) throw new Error('PIN must be 6 digits');
    this.config = { ...config };
    this.sessions.clear();
    const server = http.createServer((req, res) => this.handle(req, res).catch((e) => {
      this.log('remote', `error: ${e.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.allowLan ? '0.0.0.0' : '127.0.0.1', resolve);
    });
    this.server = server;
    this.log('remote', `web remote on ${this.urls().join(', ')}`);
  }

  async stop() {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    this.sessions.clear();
    await new Promise((resolve) => { s.close(() => resolve()); s.closeAllConnections?.(); });
    this.log('remote', 'web remote stopped');
  }

  allowedHost(host) {
    const port = this.config.port;
    const names = ['localhost', '127.0.0.1', '[::1]', ...(this.config.allowLan ? lanAddresses() : [])];
    return names.some((n) => host === `${n}:${port}`);
  }

  authed(req) {
    const m = /(?:^|;\s*)aap_remote=([a-f0-9]{48})/.exec(req.headers.cookie || '');
    return !!(m && this.sessions.has(m[1]));
  }

  async handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const ip = clientIp(req);
    if (!this.config.allowLan && ip !== '127.0.0.1' && ip !== '::1') { res.writeHead(403); return res.end(); }
    if (!this.allowedHost(req.headers.host || '')) { res.writeHead(421); return res.end('Misdirected request'); }
    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const body = fs.readFileSync(path.join(__dirname, '..', 'remote', file));
      res.writeHead(200, { 'Content-Type': type });
      return res.end(body);
    }

    if (!url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && !this.allowedHost(origin.replace(/^https?:\/\//, ''))) { res.writeHead(403); return res.end(); }
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (this.limiter.blocked(ip)) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      const body = await readJson(req);
      if (!safeEqual(String(body.pin || ''), this.config.pin)) {
        this.limiter.fail(ip);
        this.log('remote', `wrong PIN from ${ip}`);
        return json(res, 401, { error: 'Wrong PIN' });
      }
      this.limiter.ok(ip);
      const sid = crypto.randomBytes(24).toString('hex');
      this.sessions.add(sid);
      this.log('remote', `remote connected from ${ip}`);
      res.setHeader('Set-Cookie', `aap_remote=${sid}; HttpOnly; SameSite=Strict; Path=/`);
      return json(res, 200, { ok: true });
    }

    if (!this.authed(req)) return json(res, 401, { error: 'Login required' });

    if (url.pathname === '/api/status' && req.method === 'GET') return json(res, 200, this.getStatus() || {});
    if (url.pathname === '/api/cmd' && req.method === 'POST') {
      const body = await readJson(req);
      if (!COMMANDS.has(body.cmd)) return json(res, 400, { error: 'Unknown command' });
      const arg = body.arg === undefined || body.arg === null ? undefined : Number(body.arg);
      if (arg !== undefined && !Number.isFinite(arg)) return json(res, 400, { error: 'Bad argument' });
      this.onCommand(body.cmd, arg);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const m = /aap_remote=([a-f0-9]{48})/.exec(req.headers.cookie || '');
      if (m) this.sessions.delete(m[1]);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Not found' });
  }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readJson(req, limit = 4096) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (d) => { data += d; if (data.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = { RemoteServer };
