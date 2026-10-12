'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aap-test-'));
const port = () => 40000 + Math.floor(Math.random() * 20000);

test('OpenSubtitles hash and title cleanup', async () => {
  const { movieHash, cleanTitle } = require('../src/main/opensubtitles');
  const file = path.join(tmp, 'h.bin');
  const buf = Buffer.alloc(200000);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 7 + 3) & 0xff;
  fs.writeFileSync(file, buf);
  // independent reference: size + sum of uint64 words of first/last 64 KiB
  let ref = BigInt(buf.length);
  for (const off of [0, buf.length - 65536]) for (let i = 0; i < 65536; i += 8) ref += buf.readBigUInt64LE(off + i);
  const { hash, size } = await movieHash(file);
  assert.equal(size, 200000);
  assert.equal(hash, (ref & 0xffffffffffffffffn).toString(16).padStart(16, '0'));
  assert.equal(cleanTitle('A.Monster.Calls.2016.1080p.10bit.BluRay.6CH.x265.HEVC-PSA.mkv'), 'A Monster Calls 2016');
  assert.equal(cleanTitle('[Group] Show Name - S01E05 [1080p].mkv'), 'Show Name - S01E05');
});

test('VLsub search + download against a mock API', async () => {
  const p = port();
  const seen = [];
  const mock = http.createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers['api-key'] });
    if (req.url.startsWith('/subtitles')) {
      res.end(JSON.stringify({ data: [{ attributes: { language: 'en', release: 'Movie.2016', download_count: 5, moviehash_match: true,
        files: [{ file_id: 42, file_name: 'Movie.2016.srt' }] } }] }));
    } else if (req.url === '/download') {
      res.end(JSON.stringify({ link: `http://127.0.0.1:${p}/file.srt`, file_name: 'Movie.2016.srt', remaining: 4 }));
    } else if (req.url === '/file.srt') {
      res.end('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((r) => mock.listen(p, '127.0.0.1', r));
  process.env.AAP_OPENSUBTITLES_URL = `http://127.0.0.1:${p}`;
  delete require.cache[require.resolve('../src/main/opensubtitles')];
  const { OpenSubtitles } = require('../src/main/opensubtitles');
  const os2 = new OpenSubtitles({ log: () => {}, userAgent: 'AAPlayer test' });
  const video = path.join(tmp, 'Movie.2016.mkv');
  fs.writeFileSync(video, Buffer.alloc(150000, 1));
  await assert.rejects(os2.search('', { query: 'x' }), /API key/);
  const results = await os2.search('KEY', { file: video, query: 'Movie 2016', languages: 'en', useHash: true });
  assert.equal(results.length, 1);
  assert.equal(results[0].hashMatch, true);
  assert.match(seen[0].url, /moviehash=[0-9a-f]{16}/);
  assert.equal(seen[0].key, 'KEY');
  const dl = await os2.download('KEY', { fileId: 42, video, language: 'en', fallbackDir: tmp });
  assert.equal(dl.file, path.join(tmp, 'Movie.2016.en.srt'));
  assert.match(fs.readFileSync(dl.file, 'utf8'), /Hello/);
  mock.close();
});

function request(p, opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: p, ...opts }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('web remote: PIN login, rate limit, host check, command allow-list', async () => {
  const { RemoteServer } = require('../src/main/remote-server');
  const cmds = [];
  const p = port();
  const r = new RemoteServer({ log: () => {}, onCommand: (c, a) => cmds.push([c, a]), getStatus: () => ({ title: 'X' }) });
  await r.start({ port: p, allowLan: false, pin: '123456' });
  const host = { Host: `localhost:${p}` };
  assert.equal((await request(p, { path: '/', headers: host })).status, 200);
  assert.equal((await request(p, { path: '/', headers: { Host: `evil.example:${p}` } })).status, 421);
  assert.equal((await request(p, { path: '/api/status', headers: host })).status, 401);
  const post = (pathName, obj, extra = {}) => request(p, { path: pathName, method: 'POST',
    headers: { ...host, 'Content-Type': 'application/json', ...extra } }, JSON.stringify(obj));
  assert.equal((await post('/api/login', { pin: '000000' })).status, 401);
  const ok = await post('/api/login', { pin: '123456' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers['set-cookie'][0].split(';')[0];
  assert.match(ok.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  assert.equal(JSON.parse((await request(p, { path: '/api/status', headers: { ...host, Cookie: cookie } })).body).title, 'X');
  assert.equal((await post('/api/cmd', { cmd: 'toggle-play' }, { Cookie: cookie })).status, 200);
  assert.equal((await post('/api/cmd', { cmd: 'quit' }, { Cookie: cookie })).status, 400);
  assert.equal((await post('/api/cmd', { cmd: 'seek', arg: 12.5 }, { Cookie: cookie, Origin: 'http://evil.example' })).status, 403);
  assert.deepEqual(cmds, [['toggle-play', undefined]]);
  for (let i = 0; i < 5; i++) await post('/api/login', { pin: '999999' });
  assert.equal((await post('/api/login', { pin: '123456' })).status, 429);
  await r.stop();
});

test('VLM stream server: PIN via Basic auth, original file is seekable', async () => {
  const { StreamServer } = require('../src/main/stream-server');
  const file = path.join(tmp, 'clip.mp4');
  fs.writeFileSync(file, Buffer.from('0123456789'));
  const s = new StreamServer({ log: () => {}, getTools: () => ({}), getInfo: async () => ({ name: 'clip.mp4', video: [], audio: [], subs: [] }) });
  const p = port();
  await s.add({ input: file, name: 'Clip', mode: 'original', port: p, pin: '654321' });
  const [stream] = s.list();
  const urlPath = `/v/${stream.id}/clip.mp4`;
  assert.equal((await request(p, { path: urlPath })).status, 401);
  const auth = (pin) => ({ Authorization: `Basic ${Buffer.from(`tv:${pin}`).toString('base64')}` });
  assert.equal((await request(p, { path: urlPath, headers: auth('000000') })).status, 401);
  const ranged = await request(p, { path: urlPath, headers: { ...auth('654321'), Range: 'bytes=2-5' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.body, '2345');
  assert.equal((await request(p, { path: '/v/deadbeef/x.mp4', headers: auth('654321') })).status, 404);
  await s.closeAll();
  assert.equal(s.server, null);
});
