#!/usr/bin/env node
/**
 * One-shot import of a local ./data directory into Supabase (Postgres + Storage).
 *
 * Usage (from repo root):
 *   set SUPABASE_URL=...
 *   set SUPABASE_SERVICE_ROLE_KEY=...
 *   node scripts/import-to-supabase.mjs [path/to/data]
 *
 * Never put the service role key in the frontend. This script is for the operator machine only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'api', 'package.json'));
const { createClient } = require('@supabase/supabase-js');

const DATA = path.resolve(process.argv[2] || path.join(root, 'data'));
const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  console.error('Then: node scripts/import-to-supabase.mjs [path/to/data]');
  process.exit(1);
}
if (!fs.existsSync(path.join(DATA, 'db.json'))) {
  console.error('No db.json in', DATA);
  process.exit(1);
}

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const db = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
db.users = db.users || [];
db.creds = db.creds || [];
db.subs = db.subs || [];
db.invites = db.invites || [];
db.deviceLinks = db.deviceLinks || [];
db.planRequests = db.planRequests || [];
db.posts = db.posts || [];

const ok = (label, error) => {
  if (error) {
    console.error(label, error.message || error);
    if (error.cause) console.error('  cause:', error.cause?.message || error.cause);
    if (String(error.message || '').includes('fetch failed')) {
      console.error('  Hint: use the real service_role JWT from Supabase → Project Settings → API Keys');
      console.error('  (starts with eyJ… and is long — not the literal text "eyJ...")');
      console.error('  SUPABASE_URL must be https://xxxx.supabase.co with no /rest/v1/');
    }
    process.exit(1);
  }
  console.log(label, 'ok');
};
if (!key.startsWith('eyJ') || key.length < 80 || key === 'eyJ...') {
  console.error('SUPABASE_SERVICE_ROLE_KEY looks wrong. Paste the full service_role secret from the dashboard.');
  process.exit(1);
}

async function upsert(table, rows) {
  if (!rows.length) { console.log(table, '(empty)'); return; }
  const { error } = await sb.from(table).upsert(rows);
  ok(table + ' x' + rows.length, error);
}

console.log('Importing from', DATA);

await upsert('users', db.users.map(u => {
  const { id, ...doc } = u;
  return { id, doc };
}));
await upsert('creds', db.creds.map(c => {
  const { id, userId, ...doc } = c;
  return { id, user_id: userId, doc: { ...doc, userId } };
}));
await upsert('push_subs', db.subs.map(s => {
  const { endpoint, userId, ...doc } = s;
  return { endpoint, user_id: userId, doc: { ...doc, userId } };
}));
await upsert('invites', db.invites.map(i => {
  const { code, ...doc } = i;
  return { code, doc };
}));
await upsert('device_links', (db.deviceLinks || []).map(l => {
  const { id, ...doc } = l;
  return { id, doc };
}));
await upsert('plan_requests', (db.planRequests || []).map(r => {
  const { id, userId, ...doc } = r;
  return { id, user_id: userId, doc: { ...doc, userId } };
}));
await upsert('posts', (db.posts || []).map(p => {
  const { id, userId, created, ...doc } = p;
  return { id, user_id: userId, created: created || null, doc: { ...doc, userId, created } };
}));

for (const name of fs.readdirSync(DATA)) {
  const m = /^state-(.+)\.json$/.exec(name);
  if (!m) continue;
  const uid = m[1];
  const doc = JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
  const { error } = await sb.from('states').upsert({ uid, doc, rev: Number(doc._rev) || 0 });
  ok('state ' + uid, error);
}
for (const name of fs.readdirSync(DATA)) {
  const m = /^plan-(.+)\.json$/.exec(name);
  if (!m) continue;
  const uid = m[1];
  const doc = JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
  const { error } = await sb.from('plans').upsert({ uid, doc, rev: Number(doc._rev) || 0 });
  ok('plan ' + uid, error);
}

const vapidPath = path.join(DATA, 'vapid.json');
if (fs.existsSync(vapidPath)) {
  const vapid = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
  const { error } = await sb.from('config').upsert({ key: 'vapid', doc: vapid });
  ok('vapid', error);
}

const auditPath = path.join(DATA, 'audit.log');
if (fs.existsSync(auditPath)) {
  const rows = [];
  for (const line of fs.readFileSync(auditPath, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.id && r.ev) {
        rows.push({
          id: r.id, ts: r.ts, ev: r.ev, ok: r.ok !== false,
          uid: r.uid || null, name: r.name || null, tgt: r.tgt || null, tname: r.tname || null,
          msg: r.msg || null, act: r.act || null, ip: r.ip || null, doc: r
        });
      }
    } catch { /* torn */ }
  }
  if (rows.length) {
    // Insert in chunks
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await sb.from('audit').upsert(chunk);
      ok(`audit ${i}-${i + chunk.length}`, error);
    }
  }
}

const uploads = path.join(DATA, 'uploads');
if (fs.existsSync(uploads)) {
  for (const uid of fs.readdirSync(uploads)) {
    const dir = path.join(uploads, uid);
    if (!fs.statSync(dir).isDirectory() || uid.startsWith('.')) continue;
    for (const name of fs.readdirSync(dir)) {
      const m = /^([0-9a-f]{64})\.(jpg|png|webp|gif|mp4|mov|webm)$/.exec(name);
      if (!m) continue;
      const [, hash, ext] = m;
      const buf = fs.readFileSync(path.join(dir, name));
      const mime = {
        jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
        mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm'
      }[ext];
      const objectPath = `${uid}/${hash}.${ext}`;
      const { error: upErr } = await sb.storage.from('media').upload(objectPath, buf, {
        contentType: mime, upsert: true
      });
      if (upErr) { console.error('storage', objectPath, upErr.message); continue; }
      const { error } = await sb.from('media_objects').upsert({
        uid, hash, ext, mime, size: buf.length, unreferenced_at: null
      });
      ok('media ' + objectPath, error);
    }
  }
}

console.log('Import finished. Set SESSION_SECRET on Render to the contents of data/secret (or a new secret and re-login everyone).');
const secretPath = path.join(DATA, 'secret');
if (fs.existsSync(secretPath)) {
  console.log('Existing SESSION_SECRET length:', fs.readFileSync(secretPath, 'utf8').trim().length);
}
