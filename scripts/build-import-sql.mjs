import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.argv[2] || path.join(root, 'data'));
const out = path.join(root, 'scripts', 'import-data.sql');
const db = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));

const esc = (obj) => JSON.stringify(obj).replace(/'/g, "''");
const lines = [];
lines.push('-- CareFit one-shot import — paste into Supabase SQL Editor and Run');
lines.push('begin;');

for (const u of db.users || []) {
  const { id, ...doc } = u;
  lines.push(
    `insert into public.users (id, doc) values ('${id}', '${esc(doc)}'::jsonb) on conflict (id) do update set doc = excluded.doc;`
  );
}
for (const c of db.creds || []) {
  const { id, userId, ...doc } = c;
  lines.push(
    `insert into public.creds (id, user_id, doc) values ('${id}', '${userId}', '${esc({ ...doc, userId })}'::jsonb) on conflict (id) do update set user_id = excluded.user_id, doc = excluded.doc;`
  );
}
for (const s of db.subs || []) {
  const { endpoint, userId, ...doc } = s;
  const ep = String(endpoint).replace(/'/g, "''");
  lines.push(
    `insert into public.push_subs (endpoint, user_id, doc) values ('${ep}', '${userId}', '${esc({ ...doc, userId })}'::jsonb) on conflict (endpoint) do update set user_id = excluded.user_id, doc = excluded.doc;`
  );
}
for (const i of db.invites || []) {
  const { code, ...doc } = i;
  const c = String(code).replace(/'/g, "''");
  lines.push(
    `insert into public.invites (code, doc) values ('${c}', '${esc(doc)}'::jsonb) on conflict (code) do update set doc = excluded.doc;`
  );
}
for (const r of db.planRequests || []) {
  const { id, userId, ...doc } = r;
  lines.push(
    `insert into public.plan_requests (id, user_id, doc) values ('${id}', '${userId}', '${esc({ ...doc, userId })}'::jsonb) on conflict (id) do update set user_id = excluded.user_id, doc = excluded.doc;`
  );
}
for (const p of db.posts || []) {
  const { id, userId, created, ...doc } = p;
  const createdSql = created == null ? 'null' : String(Number(created));
  lines.push(
    `insert into public.posts (id, user_id, created, doc) values ('${id}', '${userId}', ${createdSql}, '${esc({ ...doc, userId, created })}'::jsonb) on conflict (id) do update set doc = excluded.doc;`
  );
}

for (const name of fs.readdirSync(DATA)) {
  let m = /^state-(.+)\.json$/.exec(name);
  if (m) {
    const doc = JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
    lines.push(
      `insert into public.states (uid, doc, rev) values ('${m[1]}', '${esc(doc)}'::jsonb, ${Number(doc._rev) || 0}) on conflict (uid) do update set doc = excluded.doc, rev = excluded.rev;`
    );
  }
  m = /^plan-(.+)\.json$/.exec(name);
  if (m) {
    const doc = JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
    lines.push(
      `insert into public.plans (uid, doc, rev) values ('${m[1]}', '${esc(doc)}'::jsonb, ${Number(doc._rev) || 0}) on conflict (uid) do update set doc = excluded.doc, rev = excluded.rev;`
    );
  }
}

const vapidPath = path.join(DATA, 'vapid.json');
if (fs.existsSync(vapidPath)) {
  const v = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
  lines.push(
    `insert into public.config (key, doc) values ('vapid', '${esc(v)}'::jsonb) on conflict (key) do update set doc = excluded.doc;`
  );
}

lines.push('commit;');
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log('Wrote', out);
console.log('users', (db.users || []).length, 'statements', lines.length);
