/* Media store backed by Supabase Storage (bucket `media`) + `media_objects` metadata.
 * Same surface as createMediaStore in media.js so server.js can swap backends.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HASH_RE, MAX_INFLIGHT, MEDIA_TYPES, MediaError, mediaLimits, sniffMedia, mp4Info, referencedHashes
} from './media.js';

const MB = 1024 * 1024;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const BUCKET = 'media';
const EXT_MIME = Object.fromEntries(Object.entries(MEDIA_TYPES).map(([mime, t]) => [t.ext, mime]));

const round1 = n => Math.round(n * 10) / 10;
const contentType = req => String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
function contentLength(req) {
  const raw = req.headers?.['content-length'];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
function drain(req, limit) {
  if (req.readableEnded || req.destroyed) return;
  let seen = 0;
  req.on('data', d => { seen += d.length; if (seen > limit) req.destroy(); });
  req.on('error', () => {});
  req.resume();
}

function streamToFile(req, file, { max, maxMB, idleMs }) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const head = [];
    let headLen = 0, size = 0, ended = false, settled = false, timer = null;
    const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600, highWaterMark: 256 * 1024 });
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => settle(new MediaError(408, 'timeout', {}, { Connection: 'close' })), idleMs);
    };
    const detach = () => {
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('error', onReqError); req.off('close', onClose);
      out.off('drain', onDrain);
      req.on('error', () => {});
    };
    function settle(err, val) {
      if (settled) return;
      settled = true;
      detach();
      if (!err) return resolve(val);
      if (err.code === 'ENOSPC') err = new MediaError(507, 'storage-full');
      if (out.closed) return reject(err);
      out.once('close', () => reject(err));
      out.destroy();
    }
    function onData(chunk) {
      arm();
      size += chunk.length;
      if (size > max) return settle(new MediaError(413, 'media-too-large', { maxMB }));
      hash.update(chunk);
      if (headLen < 64) {
        const part = Buffer.from(chunk.subarray(0, 64 - headLen));
        head.push(part);
        headLen += part.length;
      }
      if (!out.write(chunk)) req.pause();
    }
    function onDrain() { if (!settled && !ended) { arm(); req.resume(); } }
    function onEnd() {
      ended = true;
      clearTimeout(timer);
      out.end();
      out.once('close', () => {
        if (settled) return;
        settled = true;
        detach();
        resolve({ size, sha: hash.digest('hex'), head: Buffer.concat(head) });
      });
    }
    function onReqError(e) { settle(Object.assign(e || new Error('aborted'), { clientGone: true })); }
    function onClose() { if (!ended) settle(Object.assign(new Error('client went away mid-upload'), { clientGone: true })); }
    out.on('error', e => settle(e));
    out.on('drain', onDrain);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onReqError);
    req.on('close', onClose);
    arm();
    req.resume();
  });
}

/**
 * @param {{ client: import('@supabase/supabase-js').SupabaseClient, limits?: object, now?: () => number, readState?: Function, extraRefs?: Function, idleMs?: number, log?: Console }} opts
 */
export function createSupabaseMediaStore({
  client, limits, now = Date.now, readState = () => null, extraRefs = () => [], idleMs = 60000, log = console
} = {}) {
  if (!client) throw new Error('createSupabaseMediaStore: client required');
  const L = { ...mediaLimits({}), ...(limits || {}) };
  const quotaBytes = L.quotaMB > 0 ? Math.round(L.quotaMB * MB) : 0;
  const capMB = kind => (kind === 'video' ? L.videoMB : kind === 'gif' ? L.gifMB : L.imageMB);
  const capOf = kind => Math.round(capMB(kind) * MB);
  const maxCap = Math.max(capOf('image'), capOf('gif'), capOf('video'));
  const users = new Map(); // uid -> { bytes, count, reserved, inflight, hashes: Map }

  function safe(uid) {
    const s = String(uid ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!s) throw new Error('media: a profile id is required');
    return s;
  }
  const objectPath = (uid, hash, ext) => `${safe(uid)}/${hash}.${ext}`;

  async function loadUser(uid) {
    const id = safe(uid);
    let e = users.get(id);
    if (e) return e;
    e = { id, bytes: 0, count: 0, reserved: 0, inflight: 0, hashes: new Map() };
    const { data, error } = await client.from('media_objects').select('hash, ext, mime, size, unreferenced_at').eq('uid', id);
    if (error) throw error;
    for (const row of data || []) {
      e.hashes.set(row.hash, { ext: row.ext, mime: row.mime, size: Number(row.size) || 0, unreferenced_at: row.unreferenced_at });
      e.bytes += Number(row.size) || 0;
      e.count++;
    }
    users.set(id, e);
    return e;
  }

  function usageOf(e) { return { bytes: e.bytes, count: e.count, quotaBytes }; }

  function stateOf(uid) {
    let S = null;
    try { S = readState(uid); } catch { S = null; }
    return S && typeof S === 'object' && !Array.isArray(S) ? S : null;
  }
  function refsOf(uid, S) {
    const refs = referencedHashes(S);
    let extra;
    try { extra = extraRefs(uid); } catch (err) { log.error('media: extraRefs failed for', uid, err.message); return null; }
    for (const h of extra || []) refs.add(h);
    return refs;
  }

  async function setMark(uid, hash, t) {
    const { error } = await client.from('media_objects').update({ unreferenced_at: t }).eq('uid', uid).eq('hash', hash);
    if (error) throw error;
    const e = users.get(uid);
    const f = e?.hashes.get(hash);
    if (f) f.unreferenced_at = t;
  }
  async function clearMark(uid, hash) {
    await setMark(uid, hash, null);
  }

  async function noteState(uid, state) {
    const e = await loadUser(uid);
    if (!e.hashes.size) return false;
    const refs = refsOf(uid, state);
    if (!refs) return false;
    const t = now();
    let changed = false;
    for (const [h, f] of e.hashes) {
      if (refs.has(h)) {
        if (f.unreferenced_at != null) { await clearMark(e.id, h); changed = true; }
      } else if (f.unreferenced_at == null) {
        await setMark(e.id, h, t);
        changed = true;
      }
    }
    return changed;
  }

  async function sweep(uid, { graceMs = L.gcGraceDays * DAY } = {}) {
    const e = await loadUser(uid);
    const res = { removed: 0, freedBytes: 0, skipped: false };
    if (!e.hashes.size) return res;
    const S = stateOf(uid);
    if (!S) { res.skipped = true; return res; }
    const refs = refsOf(uid, S);
    if (!refs) { res.skipped = true; return res; }
    const t = now();
    for (const [h, f] of [...e.hashes]) {
      if (refs.has(h)) {
        if (f.unreferenced_at != null) await clearMark(e.id, h);
        continue;
      }
      if (f.unreferenced_at == null) { await setMark(e.id, h, t); continue; }
      if (graceMs > 0 && !(t - f.unreferenced_at >= graceMs)) continue;
      const p = objectPath(e.id, h, f.ext);
      const { error: e1 } = await client.storage.from(BUCKET).remove([p]);
      if (e1) { log.error('media: storage delete', e.id, h, e1.message); continue; }
      const { error: e2 } = await client.from('media_objects').delete().eq('uid', e.id).eq('hash', h);
      if (e2) { log.error('media: meta delete', e.id, h, e2.message); continue; }
      e.hashes.delete(h);
      e.bytes -= f.size;
      e.count--;
      res.removed++;
      res.freedBytes += f.size;
    }
    return res;
  }

  const existed = (hash, f) => ({ status: 200, body: { ok: true, hash, mime: f.mime || EXT_MIME[f.ext], size: f.size, existed: true } });

  async function receive(uid, hash, req) {
    if (!HASH_RE.test(String(hash))) { drain(req, maxCap); throw new MediaError(400, 'bad-request'); }
    const e = await loadUser(uid);
    if (e.inflight >= MAX_INFLIGHT) {
      drain(req, 2 * maxCap);
      throw new MediaError(429, 'busy', { retryAfter: 5 }, { 'Retry-After': '5' });
    }
    e.inflight++;
    let reserved = 0, tmp = null, cap = maxCap;
    try {
      const declared = MEDIA_TYPES[contentType(req)];
      if (!declared) throw new MediaError(415, 'media-type');
      cap = capOf(declared.kind);
      const len = contentLength(req);
      if (len != null && len > cap) {
        cap = maxCap;
        throw new MediaError(413, 'media-too-large', { maxMB: capMB(declared.kind) });
      }
      const have = e.hashes.get(hash);
      if (have) { drain(req, 2 * cap); return existed(hash, have); }

      const need = len ?? cap;
      if (quotaBytes && e.bytes + e.reserved + need > quotaBytes) {
        try { await sweep(uid, { graceMs: HOUR }); } catch (err) { log.error('media: quota sweep failed', e.id, err.message); }
        if (e.bytes + e.reserved + need > quotaBytes) {
          throw new MediaError(413, 'media-quota', { usedMB: round1(e.bytes / MB), quotaMB: L.quotaMB });
        }
      }
      e.reserved += need;
      reserved = need;

      tmp = path.join(os.tmpdir(), `carefit-media-${crypto.randomBytes(12).toString('hex')}`);
      const got = await streamToFile(req, tmp, { max: cap, maxMB: capMB(declared.kind), idleMs });
      if (got.sha !== hash) throw new MediaError(400, 'hash-mismatch');
      const sn = sniffMedia(got.head);
      if (!sn || sn.category !== declared.category) throw new MediaError(415, 'media-type');
      if (got.size > capOf(sn.kind)) throw new MediaError(413, 'media-too-large', { maxMB: capMB(sn.kind) });
      if (sn.ext === 'mp4' || sn.ext === 'mov') {
        const fd = fs.openSync(tmp, 'r');
        let info;
        try { info = mp4Info(fd, got.size); } finally { fs.closeSync(fd); }
        if (!info) throw new MediaError(415, 'media-invalid');
        if (info.durationSec != null && info.durationSec > L.videoSec + 1) throw new MediaError(413, 'media-too-long', { maxSec: L.videoSec });
      }

      const now2 = e.hashes.get(hash);
      if (now2) return existed(hash, now2);

      const buf = fs.readFileSync(tmp);
      const p = objectPath(e.id, hash, sn.ext);
      const { error: upErr } = await client.storage.from(BUCKET).upload(p, buf, {
        contentType: sn.mime, upsert: true
      });
      if (upErr) throw upErr;

      const row = { uid: e.id, hash, ext: sn.ext, mime: sn.mime, size: got.size, unreferenced_at: now() };
      const { error: metaErr } = await client.from('media_objects').upsert(row);
      if (metaErr) throw metaErr;

      e.hashes.set(hash, { ext: sn.ext, mime: sn.mime, size: got.size, unreferenced_at: row.unreferenced_at });
      e.bytes += got.size;
      e.count++;
      return { status: 201, body: { ok: true, hash, mime: sn.mime, size: got.size, existed: false } };
    } catch (err) {
      if (!err?.clientGone) drain(req, 2 * cap);
      if (err instanceof MediaError) throw err;
      log.error('media: receive failed', err.message || err);
      throw new MediaError(500, 'bad-request', { error: 'upload failed' });
    } finally {
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ok */ } }
      e.reserved -= reserved;
      e.inflight--;
    }
  }

  return {
    limits: L,
    discard: req => drain(req, 2 * maxCap),
    usage: uid => {
      const id = safe(uid);
      const e = users.get(id);
      if (!e) return { bytes: 0, count: 0, quotaBytes };
      return usageOf(e);
    },
    async usageAsync(uid) { return usageOf(await loadUser(uid)); },
    has: (uid, hash) => {
      const e = users.get(safe(uid));
      return !!e?.hashes.has(hash);
    },
    /** { buffer, ext, mime, size } or null. Downloads from Storage. */
    async file(uid, hash) {
      const e = await loadUser(uid);
      const f = e.hashes.get(hash);
      if (!f) return null;
      const p = objectPath(e.id, hash, f.ext);
      const { data, error } = await client.storage.from(BUCKET).download(p);
      if (error || !data) {
        e.hashes.delete(hash);
        return null;
      }
      const buf = Buffer.from(await data.arrayBuffer());
      return { buffer: buf, ext: f.ext, mime: f.mime || EXT_MIME[f.ext], size: buf.length };
    },
    receive,
    async missing(uid, hashes) {
      const e = await loadUser(uid);
      return { missing: [...new Set(hashes)].filter(h => !e.hashes.has(h)), usage: usageOf(e) };
    },
    noteState,
    sweep,
    async sweepAll({ uids = [], graceMs } = {}) {
      const out = { swept: 0, removed: 0, freedBytes: 0, skipped: 0, orphans: 0, tmp: 0 };
      for (const uid of uids) {
        try {
          const r = await sweep(uid, graceMs === undefined ? {} : { graceMs });
          if (r.skipped) out.skipped++; else out.swept++;
          out.removed += r.removed;
          out.freedBytes += r.freedBytes;
        } catch (err) { log.error('media: sweep failed for', uid, err.message); }
      }
      return out;
    },
    async removeUser(uid) {
      const id = safe(uid);
      const e = await loadUser(uid);
      const paths = [...e.hashes.entries()].map(([h, f]) => objectPath(id, h, f.ext));
      if (paths.length) {
        const { error } = await client.storage.from(BUCKET).remove(paths);
        if (error) log.error('media: removeUser storage', id, error.message);
      }
      const { error } = await client.from('media_objects').delete().eq('uid', id);
      if (error) log.error('media: removeUser meta', id, error.message);
      users.delete(id);
    },
    cleanTmp() { return 0; },
    /** Warm the in-memory index for every known uid (boot). */
    async warm(uids = []) {
      for (const uid of uids) {
        try { await loadUser(uid); } catch (err) { log.error('media: warm failed', uid, err.message); }
      }
    }
  };
}
