'use strict';
/*
 * Media > Open Disc… — unprotected DVD-Video and Blu-ray discs or folders.
 * No disc menus. DVD titles are played by joining a title set's VOB files with
 * FFmpeg's concat protocol; Blu-ray plays a stream file from BDMV/STREAM
 * (largest first = usually the main movie). Works with any FFmpeg build.
 * Copy-protected discs (CSS/AACS) are not supported.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

async function findDir(root, name) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const hit = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === name.toLowerCase());
  return hit ? path.join(root, hit.name) : null;
}

/** Detects the disc type of a drive or folder (the folder may be the disc root or VIDEO_TS/BDMV itself). */
async function detect(folder) {
  const base = path.basename(folder).toLowerCase();
  if (base === 'video_ts') return { type: 'dvd', root: path.dirname(folder), dir: folder };
  if (base === 'bdmv') return { type: 'bluray', root: path.dirname(folder), dir: folder };
  const vts = await findDir(folder, 'VIDEO_TS');
  if (vts) return { type: 'dvd', root: folder, dir: vts };
  const bdmv = await findDir(folder, 'BDMV');
  if (bdmv) return { type: 'bluray', root: folder, dir: bdmv };
  return null;
}

/** Optical drives / mounted images with a DVD or Blu-ray structure (Windows drive letters). */
async function scanDrives() {
  if (process.platform !== 'win32') return [];
  const found = [];
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    if (!(await exists(root))) continue;
    const d = await detect(root);
    if (d) found.push({ path: root, type: d.type, label: `${letter}: ${d.type === 'dvd' ? 'DVD' : 'Blu-ray'}` });
  }
  return found;
}

const gb = (n) => `${(n / 1024 ** 3).toFixed(2)} GB`;

/** Lists playable titles: [{ id, label, input, size }] sorted by size (largest first). */
async function listTitles(folder) {
  const d = await detect(folder);
  if (!d) throw new Error('No VIDEO_TS (DVD) or BDMV (Blu-ray) folder found here');
  const protectedDisc = d.type === 'bluray' && (await findDir(d.root, 'AACS'));
  const files = await fsp.readdir(d.dir).catch(() => []);
  let titles = [];
  if (d.type === 'dvd') {
    const sets = new Map();
    for (const f of files) {
      const m = /^VTS_(\d\d)_([1-9])\.VOB$/i.exec(f);
      if (!m) continue; // _0.VOB is the menu
      const full = path.join(d.dir, f);
      const { size } = await fsp.stat(full);
      const set = sets.get(m[1]) || { files: [], size: 0 };
      set.files.push({ n: Number(m[2]), full });
      set.size += size;
      sets.set(m[1], set);
    }
    titles = [...sets.entries()].map(([id, s]) => ({
      id, size: s.size, label: `Title set ${Number(id)} — ${gb(s.size)}`,
      input: 'concat:' + s.files.sort((a, b) => a.n - b.n).map((f) => f.full).join('|'),
    }));
  } else {
    const streamDir = await findDir(d.dir, 'STREAM');
    const streams = streamDir ? await fsp.readdir(streamDir).catch(() => []) : [];
    for (const f of streams) {
      if (!/\.m2ts$/i.test(f)) continue;
      const full = path.join(streamDir, f);
      const { size } = await fsp.stat(full);
      if (size < 20 * 1024 * 1024) continue; // skip menus, trailers' fragments
      titles.push({ id: f, size, label: `${f} — ${gb(size)}`, input: full });
    }
  }
  titles.sort((a, b) => b.size - a.size);
  return { type: d.type, root: d.root, protected: !!protectedDisc, titles };
}

module.exports = { detect, scanDrives, listTitles };
