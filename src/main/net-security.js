'use strict';
// Shared helpers for the network features (web remote, streaming).
const crypto = require('node:crypto');
const os = require('node:os');

/** Random 6-digit PIN. */
function randomPin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/** Constant-time string comparison. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Blocks an address after `max` failures within `windowMs` (PIN brute force). */
class FailureLimiter {
  constructor(max = 5, windowMs = 5 * 60 * 1000) {
    this.max = max;
    this.windowMs = windowMs;
    this.fails = new Map();
  }
  blocked(ip) {
    const f = this.fails.get(ip);
    if (!f) return false;
    if (Date.now() - f.first > this.windowMs) { this.fails.delete(ip); return false; }
    return f.count >= this.max;
  }
  fail(ip) {
    const f = this.fails.get(ip);
    if (!f || Date.now() - f.first > this.windowMs) this.fails.set(ip, { first: Date.now(), count: 1 });
    else f.count++;
  }
  ok(ip) { this.fails.delete(ip); }
}

/** Non-internal IPv4 addresses of this machine (for LAN URLs). */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function clientIp(req) {
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1';
}

module.exports = { randomPin, safeEqual, FailureLimiter, lanAddresses, clientIp, isLoopback };
