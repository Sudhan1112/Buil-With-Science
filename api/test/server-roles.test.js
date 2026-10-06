/* Two levels of staff, and the line between them.

   An owner runs the instance; an admin runs the coaching. The split exists so that handing
   someone the coaching job is not the same as handing them the instance: a second coach can do
   everything to clients and nothing to staff, which means a stolen coach session cannot mint
   more coaches, and the person who hired them cannot be removed by them.

   The circle of admins widens over HTTP (POST /api/admin/user/role). The circle of owners never
   does — ADMIN_UIDS or db.json, by someone with a shell. Every assertion below is one half of
   that sentence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const OWNER = 'u_role_owner', COACH = 'u_role_coach', CLIENT = 'u_role_client';

// api/server.js makeSession(): `uid:exp:sv[:deviceId]`, HMAC-SHA256 over SECRET.
function mint(uid, { sv = 0, deviceId = '' } = {}) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}` + (deviceId ? `:${deviceId}` : '');
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const cookie = (uid, opts) => ({ Cookie: `gymsid=${mint(uid, opts)}`, 'Content-Type': 'application/json', Origin: 'http://localhost:8080' });

const MONTH = 31 * 86400000;
const paid = () => ({ status: 'active', paidUntil: Date.now() + MONTH, activatedAt: new Date().toISOString(), note: '' });
const unpaid = () => ({ status: 'pending', paidUntil: 0, activatedAt: null, note: '' });

/* `ownerBy` picks which half of isOwner() is under test: 'flag' puts `owner: true` on the
   record, 'env' leaves the record plain and names them in ADMIN_UIDS instead. The rest of the
   file should not be able to tell the difference, which is the point of testing both. */
async function startServer(t, { ownerBy = 'flag', clientSub = paid(), coachIsOwner = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-roles-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [
      { id: OWNER, name: 'Owner', created: new Date().toISOString(), ...(ownerBy === 'flag' ? { owner: true } : {}) },
      { id: COACH, name: 'Second', created: new Date().toISOString(), ...(coachIsOwner ? { owner: true } : { admin: true }) },
      { id: CLIENT, name: 'Client', created: new Date().toISOString(), sub: clientSub }
    ], creds: [], subs: [], invites: []
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost',
      ...(ownerBy === 'env' ? { ADMIN_UIDS: OWNER } : {})
    }
  });
  const h = { log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.port = await boundPort(child, () => h.log);
  h.call = async (method, p, uid, body, opts) => {
    const r = await fetch(`http://127.0.0.1:${h.port}${p}`, { method, headers: cookie(uid, opts), body: body && JSON.stringify(body) });
    const txt = await r.text();
    return { status: r.status, body: txt ? JSON.parse(txt) : null };
  };
  h.role = (caller, id, admin) => h.call('POST', '/api/admin/user/role', caller, { id, admin });
  h.db = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  h.rec = id => h.db().users.find(u => u.id === id);
  return h;
}

test('the owner can hand out coach access, and what the second coach gets is the coaching job', async t => {
  const h = await startServer(t);

  // Before: an ordinary client, nowhere near the admin side.
  assert.equal((await h.call('GET', '/api/admin/users', CLIENT)).status, 403);

  let r = await h.role(OWNER, CLIENT, true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, id: CLIENT, admin: true });
  assert.equal(h.rec(CLIENT).admin, true);

  // After: the whole coaching side answers for them.
  assert.equal((await h.call('GET', '/api/admin/users', CLIENT)).status, 200);
  assert.equal((await h.call('PUT', '/api/admin/plan', CLIENT, { id: COACH, plan: { routines: [] } })).status, 200);

  // Including the parts of being staff rather than a customer: no second-device refusal…
  assert.equal((await h.call('GET', '/api/me', CLIENT, null, { deviceId: 'phone-1' })).status, 200);
  assert.equal((await h.call('GET', '/api/me', CLIENT, null, { deviceId: 'laptop-2' })).status, 200);
  // …and `owner` is on the identity so the app knows which control to offer them. Not this one.
  r = await h.call('GET', '/api/me', CLIENT);
  assert.equal(r.body.user.admin, true);
  assert.equal(r.body.user.owner, false);

  // Saying it twice is not an error and changes nothing.
  assert.equal((await h.role(OWNER, CLIENT, true)).status, 200);
  assert.equal(h.db().users.filter(u => u.admin === true).length, 2);
});

test('a second coach cannot widen the circle: not for a client, not for themselves, not against the owner', async t => {
  const h = await startServer(t);

  for (const [target, make, why] of [
    [CLIENT, true, 'cannot promote a client'],
    [COACH, true, 'cannot confirm themselves'],
    [OWNER, false, 'cannot demote the owner']
  ]) {
    const r = await h.role(COACH, target, make);
    assert.equal(r.status, 403, why);
    assert.equal(r.body.error, 'only the owner can do that');
  }
  assert.equal(h.rec(CLIENT).admin, undefined, 'and nothing moved');
  assert.equal(h.rec(OWNER).owner, true);

  // Reaching for it is recorded, so an owner reading the log sees it happen.
  const log = fs.readFileSync(path.join(h.dataDir, 'audit.log'), 'utf8');
  const denied = log.trim().split('\n').map(JSON.parse).filter(e => e.ev === 'admin.denied');
  assert.equal(denied.length, 3);
  assert.equal(denied[0].msg, 'owner only');
  assert.equal(denied[0].uid, COACH);

  // The rest of the coaching job is untouched by all this — they are a coach, not a suspect.
  assert.equal((await h.call('GET', '/api/admin/users', COACH)).status, 200);
  assert.equal((await h.call('POST', '/api/admin/user/subscription', COACH, { id: CLIENT, action: 'extend', months: 1 })).status, 200);
});

test('an owner is not something this route can create or destroy', async t => {
  const h = await startServer(t);

  // Not against themselves — the one-owner instance cannot lock itself out by mis-tap.
  let r = await h.role(OWNER, OWNER, false);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'you cannot change your own access');

  // Not by a coach the owner made a moment ago: promotion grants the coaching job, not this.
  assert.equal((await h.role(OWNER, CLIENT, true)).status, 200);
  assert.equal((await h.role(CLIENT, OWNER, false)).status, 403);
  assert.equal(h.rec(OWNER).owner, true, 'the owner survived every attempt');
});

test('one owner cannot demote another: owner is config, and this route only writes data', async t => {
  const h = await startServer(t, { coachIsOwner: true });

  const r = await h.role(OWNER, COACH, false);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'that account is an owner — change it in ADMIN_UIDS or db.json');
  assert.equal(h.rec(COACH).owner, true);

  // Nor can the route be used to *add* one: the most it grants is `admin`, and the second
  // owner's standing does not come from a field this route writes.
  assert.equal((await h.role(COACH, CLIENT, true)).status, 200, 'a second owner is a full owner');
  assert.equal(h.rec(CLIENT).admin, true);
  assert.equal(h.rec(CLIENT).owner, undefined);
  assert.equal((await h.call('GET', '/api/me', CLIENT)).body.user.owner, false);
});

test('ADMIN_UIDS makes an owner just as much as the flag does', async t => {
  const h = await startServer(t, { ownerBy: 'env' });

  // Nothing on the record says so…
  assert.equal(h.rec(OWNER).owner, undefined);
  assert.equal(h.rec(OWNER).admin, undefined);
  // …and they are the owner all the same.
  const r = await h.call('GET', '/api/me', OWNER);
  assert.equal(r.body.user.admin, true);
  assert.equal(r.body.user.owner, true);
  assert.equal((await h.role(OWNER, CLIENT, true)).status, 200);
  assert.equal((await h.role(COACH, CLIENT, false)).status, 403);
  // And cannot be demoted by the route either, exactly as the flagged one could not.
  assert.equal((await h.role(OWNER, OWNER, false)).status, 400);
});

test('taking coach access back ends their sessions and hands them back to the subscription gate', async t => {
  const h = await startServer(t, { clientSub: unpaid() });

  // Promote the unpaid client: staff are never paywalled, so their own 402 lifts.
  assert.equal((await h.call('GET', '/api/data', CLIENT)).status, 402);
  await h.role(OWNER, CLIENT, true);
  assert.equal((await h.call('GET', '/api/data', CLIENT)).status, 200);

  const r = await h.role(OWNER, CLIENT, false);
  assert.equal(r.status, 200);
  assert.equal(r.body.admin, false);
  assert.equal('admin' in h.rec(CLIENT), false, 'the flag is removed, not set to false');

  // The cookie they were holding is dead on the spot — the session version moved, so a coach
  // who was let go is not still reading everyone's data until it happens to expire.
  assert.equal((await h.call('GET', '/api/admin/users', CLIENT)).status, 401);
  assert.equal((await h.call('GET', '/api/me', CLIENT)).status, 401);
  assert.equal(h.rec(CLIENT).sv, 1);

  // Signing in again, they are a client: the gate is back, and their own data is untouched.
  const fresh = { sv: 1 };
  assert.equal((await h.call('GET', '/api/me', CLIENT, null, fresh)).status, 200);
  assert.equal((await h.call('GET', '/api/admin/users', CLIENT, null, fresh)).status, 403);
  const me = await h.call('GET', '/api/me', CLIENT, null, fresh);
  assert.equal(me.body.user.admin, false);
  assert.equal(me.body.account.sub.status, 'pending');
  assert.equal((await h.call('GET', '/api/data', CLIENT, null, fresh)).status, 402);
});

test('role changes are named in the activity log', async t => {
  const h = await startServer(t);
  await h.role(OWNER, CLIENT, true);
  await h.role(OWNER, CLIENT, false);
  const rows = fs.readFileSync(path.join(h.dataDir, 'audit.log'), 'utf8').trim().split('\n').map(JSON.parse);
  const mine = rows.filter(e => e.ev.startsWith('admin.role.'));
  assert.deepEqual(mine.map(e => e.ev), ['admin.role.grant', 'admin.role.revoke']);
  assert.equal(mine[0].uid, OWNER);
  assert.equal(mine[0].tname, 'Client', 'who it was done to, by name, for whoever reads this back');
});
