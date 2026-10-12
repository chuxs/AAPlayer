'use strict';
/*
 * VLsub: OpenSubtitles.com REST API client.
 * Privacy: nothing is sent until the user presses Search/Download. A search
 * sends the OpenSubtitles hash + file size and/or the search text. The API key
 * is stored in settings; a login password is never stored (the session token
 * lives in memory only).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const API = process.env.AAP_OPENSUBTITLES_URL || 'https://api.opensubtitles.com/api/v1';
const CHUNK = 65536;

/** OpenSubtitles hash: file size + sum of the first and last 64 KiB as little-endian uint64 (mod 2^64). */
async function movieHash(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < CHUNK) throw new Error('File too small to hash');
    const head = Buffer.alloc(CHUNK);
    const tail = Buffer.alloc(CHUNK);
    await fh.read(head, 0, CHUNK, 0);
    await fh.read(tail, 0, CHUNK, size - CHUNK);
    let sum = BigInt(size);
    for (const buf of [head, tail]) for (let i = 0; i < CHUNK; i += 8) sum += buf.readBigUInt64LE(i);
    return { hash: (sum & 0xffffffffffffffffn).toString(16).padStart(16, '0'), size };
  } finally { await fh.close(); }
}

/** "The.Movie.2016.1080p.10bit.BluRay.x265-GRP" -> "The Movie 2016" (search text suggestion). */
function cleanTitle(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
  const cut = base.search(/\b(19|20)\d{2}\b|\b(480|720|1080|2160)p\b|\bS\d{1,2}E\d{1,3}\b/i);
  const m = /\b((19|20)\d{2})\b/.exec(base);
  const ep = /\bS\d{1,2}E\d{1,3}\b/i.exec(base);
  const title = (cut > 0 ? base.slice(0, cut) : base).replace(/\s+/g, ' ').trim();
  return [title, ep ? ep[0].toUpperCase() : m ? m[1] : ''].filter(Boolean).join(' ');
}

class OpenSubtitles {
  constructor({ log, userAgent }) {
    this.log = log;
    this.userAgent = userAgent;
    this.token = null; // memory only
  }

  async request(apiKey, method, route, body) {
    if (!apiKey) throw new Error('Enter your OpenSubtitles API key first');
    const headers = { 'Api-Key': apiKey, 'User-Agent': this.userAgent, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(`${API}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
    if (!res.ok) throw new Error(data.message || data.error || `OpenSubtitles error ${res.status}`);
    return data;
  }

  async login(apiKey, username, password) {
    const data = await this.request(apiKey, 'POST', '/login', { username, password });
    this.token = data.token || null;
    return { user: data.user ? { level: data.user.level, allowed: data.user.allowed_downloads } : null };
  }

  logout() { this.token = null; }

  async search(apiKey, { file, query, languages, useHash }) {
    const params = new URLSearchParams();
    if (useHash && file) {
      const { hash } = await movieHash(file);
      params.set('moviehash', hash);
    }
    if (query) params.set('query', query);
    if (languages) params.set('languages', languages);
    if (!params.has('moviehash') && !params.has('query')) throw new Error('Nothing to search for');
    this.log('vlsub', `search ${[...params.keys()].join('+')} (${languages || 'all languages'})`);
    const data = await this.request(apiKey, 'GET', `/subtitles?${params}`);
    return (data.data || []).map((d) => {
      const a = d.attributes || {};
      const f = (a.files || [])[0] || {};
      return {
        fileId: f.file_id, fileName: f.file_name || a.release, release: a.release || f.file_name || '',
        language: a.language || '', downloads: a.download_count || 0, hashMatch: !!a.moviehash_match,
        hearingImpaired: !!a.hearing_impaired, title: (a.feature_details && a.feature_details.title) || '',
        year: (a.feature_details && a.feature_details.year) || '',
      };
    }).filter((r) => r.fileId);
  }

  /** Downloads a subtitle and saves it next to the video (or in fallbackDir). Returns the saved path. */
  async download(apiKey, { fileId, video, language, fallbackDir }) {
    const info = await this.request(apiKey, 'POST', '/download', { file_id: fileId });
    if (!info.link) throw new Error('OpenSubtitles did not return a download link');
    const res = await fetch(info.link, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const ext = path.extname(info.file_name || '') || '.srt';
    const base = video && !/^[a-z][a-z0-9+.-]+:\/\//i.test(video) ? path.basename(video, path.extname(video)) : 'subtitle';
    const name = `${base}.${(language || 'sub').replace(/[^\w-]/g, '')}${ext}`;
    const targets = [video && !/^[a-z][a-z0-9+.-]+:\/\//i.test(video) ? path.join(path.dirname(video), name) : null, path.join(fallbackDir, name)].filter(Boolean);
    for (const target of targets) {
      try {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, bytes, { flag: fs.existsSync(target) ? 'w' : 'wx' });
        this.log('vlsub', `saved ${target} (${info.remaining ?? '?'} downloads left today)`);
        return { file: target, remaining: info.remaining };
      } catch { /* folder not writable: try the next location */ }
    }
    throw new Error('Could not save the subtitle file');
  }
}

module.exports = { OpenSubtitles, movieHash, cleanTitle };
