/* The three rules that turn this instance from a tracker into a coaching platform, checked
   against the real server.js in a child process:

     1. The program is the coach's. A client can push whatever it likes at PUT /api/data and
        still cannot assign itself a routine.
     2. Access is sold. An account that has not been paid for gets 402 on everything that
        carries training data, and nothing of theirs is deleted while they are locked out.
     3. One device per account. The second device is refused outright, and only the coach can
        release the binding.

   Each of those is a thing someone could quietly undo in server.js while every other test
   still passed, which is why they are here rather than exercised by hand. */
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
const ADMIN = 'u_coach_1', CLIENT = 'u_client_1';

// Same construction as server.js makeSession(): `uid:exp:sv[:deviceId]`, HMAC-SHA256 over SECRET.
function mint(uid, deviceId = '') {
  const payload = `${uid}:${Date.now() + 86400000}:0` + (deviceId ? `:${deviceId}` : '');
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const cookie = (uid, did) => ({ Cookie: `gymsid=${mint(uid, did)}`, 'Content-Type': 'application/json', Origin: 'http://localhost:8080' });

const MONTH = 31 * 86400000;
const paid = () => ({ status: 'active', paidUntil: Date.now() + MONTH, activatedAt: new Date().toISOString(), note: '' });
const unpaid = () => ({ status: 'pending', paidUntil: 0, activatedAt: null, note: '' });

async function startServer(t, clientSub) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-coaching-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [
      { id: ADMIN, name: 'Coach', created: new Date().toISOString(), admin: true },
      { id: CLIENT, name: 'Client', created: new Date().toISOString(), sub: clientSub }
    ], creds: [], subs: [], invites: []
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  });
  const h = { log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.port = await boundPort(child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  h.call = async (method, p, headers, body) => {
    const r = await fetch(`${h.api}${p}`, { method, headers, body });
    const txt = await r.text();
    return { status: r.status, body: txt ? JSON.parse(txt) : null };
  };
  h.asClient = (method, p, body, did) => h.call(method, p, cookie(CLIENT, did), body && JSON.stringify(body));
  h.asAdmin = (method, p, body) => h.call(method, p, cookie(ADMIN), body && JSON.stringify(body));
  h.planOnDisk = () => JSON.parse(fs.readFileSync(path.join(dataDir, `plan-${CLIENT}.json`), 'utf8'));
  h.stateOnDisk = () => JSON.parse(fs.readFileSync(path.join(dataDir, `state-${CLIENT}.json`), 'utf8'));
  h.db = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  return h;
}

test('the program is the coach\'s: a client can push routines all day and never assign itself one', async t => {
  const h = await startServer(t, paid());

  // Nothing published yet.
  let r = await h.asClient('GET', '/api/plan');
  assert.equal(r.status, 200);
  assert.equal(r.body.published, false);
  assert.deepEqual(r.body.plan.routines, []);

  // The client pushes a full program of its own, the way the old self-serve app did.
  r = await h.asClient('PUT', '/api/data', {
    state: {
      unit: 'kg',
      routines: [{ id: 'mine', name: 'Arms every day', ex: [] }],
      week: { 1: 'mine', 2: 'mine' },
      dayPlan: { '2026-09-01': 'mine' },
      workouts: [{ id: 'w1', d: '2026-09-01' }]
    }
  });
  assert.equal(r.status, 200, 'the push is accepted — the client is not stranded');
  // …and none of the program reached the disk.
  assert.equal('routines' in h.stateOnDisk(), false);
  assert.equal('week' in h.stateOnDisk(), false);
  // Rescheduling and the training log are the client's own, and are untouched.
  assert.deepEqual(h.stateOnDisk().dayPlan, { '2026-09-01': 'mine' });
  assert.deepEqual(h.stateOnDisk().workouts.map(w => w.id), ['w1']);
  // Reading the plan back still shows nothing: the push did not become a plan by another route.
  r = await h.asClient('GET', '/api/plan');
  assert.deepEqual(r.body.plan.routines, []);
  assert.equal(r.body.published, false);

  // The coach publishes one.
  r = await h.asAdmin('PUT', '/api/admin/plan', {
    id: CLIENT,
    plan: { routines: [{ id: 'r1', name: 'Lower A', ex: [] }, null, 7], week: { 1: 'r1' }, note: 'start here' },
    baseRev: 0
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.plan._rev, 1);
  assert.deepEqual(r.body.plan.routines.map(x => x.id), ['r1'], 'shapeless entries are dropped, not stored');
  assert.equal(r.body.plan.updatedBy, 'Coach');

  // The client now reads it, and still cannot write it.
  r = await h.asClient('GET', '/api/plan');
  assert.equal(r.body.published, true);
  assert.deepEqual(r.body.plan.week, { 1: 'r1' });
  assert.deepEqual((await h.asClient('GET', '/api/plan/rev')).body, { rev: 1 });
  assert.equal((await h.asClient('PUT', '/api/admin/plan', { id: CLIENT, plan: { routines: [] } })).status, 403);

  // A second admin editor working from a stale read is refused rather than silently winning.
  r = await h.asAdmin('PUT', '/api/admin/plan', { id: CLIENT, plan: { routines: [] }, baseRev: 0 });
  assert.equal(r.status, 409);
  assert.equal(r.body.rev, 1);
  assert.deepEqual(h.planOnDisk().routines.map(x => x.id), ['r1'], 'the refused write changed nothing');
});

test('a plan written before the split is lifted out of the profile document on boot', async t => {
  const h = await startServer(t, paid());
  // Plant a pre-split document — routines and week inside the synced blob, no plan file — then
  // restart the server over the same data directory, which is what upgrading an instance is.
  fs.writeFileSync(path.join(h.dataDir, `state-${CLIENT}.json`), JSON.stringify({
    unit: 'kg', _rev: 4,
    routines: [{ id: 'old', name: 'Legacy push', ex: [] }],
    week: { 2: 'old' },
    workouts: [{ id: 'w9', d: '2026-08-08' }]
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: h.dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  t.after(() => child.kill('SIGKILL'));
  const port = await boundPort(child, () => log);

  const r = await fetch(`http://127.0.0.1:${port}/api/plan`, { headers: cookie(CLIENT) });
  const body = await r.json();
  assert.equal(body.published, true, 'the lifted plan is live for the client');
  assert.deepEqual(body.plan.routines.map(x => x.id), ['old']);
  assert.deepEqual(body.plan.week, { 2: 'old' });
  // And the document no longer carries a second, unwritable copy of the same program.
  const S = JSON.parse(fs.readFileSync(path.join(h.dataDir, `state-${CLIENT}.json`), 'utf8'));
  assert.equal('routines' in S, false);
  assert.equal('week' in S, false);
  assert.deepEqual(S.workouts.map(w => w.id), ['w9'], 'the training log survives the lift');
});

test('an unpaid account is locked out of its data, and keeps every byte of it', async t => {
  const h = await startServer(t, unpaid());
  const planted = { unit: 'kg', _rev: 3, workouts: [{ id: 'w1', d: '2026-09-01' }], bodyweight: [{ d: '2026-09-01', w: 80 }] };
  fs.writeFileSync(path.join(h.dataDir, `state-${CLIENT}.json`), JSON.stringify(planted));

  for (const [method, p] of [['GET', '/api/data'], ['GET', '/api/data/rev'], ['GET', '/api/plan'], ['GET', '/api/plan/rev']]) {
    const r = await h.asClient(method, p);
    assert.equal(r.status, 402, `${method} ${p} is paywalled`);
    assert.equal(r.body.error, 'subscription_required');
    assert.equal(r.body.status, 'pending');
  }
  assert.equal((await h.asClient('PUT', '/api/data', { state: { unit: 'lb' } })).status, 402);

  // Photos and videos are training data too. A lapsed account keeps a list of hashes on the
  // device, so leaving these on a bare session would hand the whole library back one file at
  // a time while the JSON it belongs to answered 402.
  const HASH = 'a'.repeat(64);
  for (const [method, p, body] of [
    ['GET', `/api/media/${HASH}`, undefined],
    ['POST', '/api/media/missing', { hashes: [HASH] }],
    ['POST', '/api/media/sweep', {}]
  ]) {
    const m = await h.asClient(method, p, body);
    assert.equal(m.status, 402, `${method} ${p} is paywalled`);
    assert.equal(m.body.error, 'subscription_required');
  }
  const up = await h.call('PUT', `/api/media/${HASH}`,
    { Cookie: cookie(CLIENT).Cookie, 'Content-Type': 'image/webp', Origin: 'http://localhost:8080' }, 'not a webp');
  assert.equal(up.status, 402, 'and nothing can be uploaded into a folder they cannot read');

  // 402 is not 403: who they are, and the intake form, still answer — that is the whole point of
  // the gate screen, which has to collect goals while the payment is being confirmed.
  let r = await h.asClient('GET', '/api/me');
  assert.equal(r.status, 200);
  assert.equal(r.body.account.sub.status, 'pending');
  assert.equal(r.body.account.planReady, false);

  r = await h.asClient('POST', '/api/intake', { goal: 'build_muscle', daysPerWeek: 4, injuries: 'left shoulder' });
  assert.equal(r.status, 200);
  assert.equal(r.body.intake.goal, 'build_muscle');
  assert.equal((await h.asClient('POST', '/api/intake', { goal: 'nonsense' })).status, 400);

  r = await h.asClient('POST', '/api/plan-request', { kind: 'new', message: 'ready when you are' });
  assert.equal(r.status, 200);
  assert.equal(r.body.request.goal, 'build_muscle', 'the goal falls back to the intake');
  // Asking twice edits the one request rather than queueing a second card for the coach.
  await h.asClient('POST', '/api/plan-request', { kind: 'change', message: 'actually, mornings' });
  assert.equal(h.db().planRequests.length, 1);
  assert.equal(h.db().planRequests[0].kind, 'change');

  // Nothing of theirs was touched while they were locked out.
  assert.deepEqual(h.stateOnDisk(), planted);

  // The coach confirms the payment, and the same data is simply there again.
  r = await h.asAdmin('POST', '/api/admin/user/subscription', { id: CLIENT, action: 'activate', months: 1, note: 'UPI 1234' });
  assert.equal(r.status, 200);
  assert.equal(r.body.sub.status, 'active');
  r = await h.asClient('GET', '/api/data');
  assert.equal(r.status, 200);
  assert.equal(r.body.rev, 3);
  assert.deepEqual(r.body.state.workouts.map(w => w.id), ['w1']);

  // Ending access locks the door again and still deletes nothing.
  await h.asAdmin('POST', '/api/admin/user/subscription', { id: CLIENT, action: 'expire' });
  assert.equal((await h.asClient('GET', '/api/data')).status, 402);
  assert.deepEqual(h.stateOnDisk(), planted);
});

test('a subscription that ran out reads as expired without anything sweeping the database', async t => {
  const h = await startServer(t, { status: 'active', paidUntil: Date.now() - 1000, activatedAt: null, note: '' });
  const r = await h.asClient('GET', '/api/data');
  assert.equal(r.status, 402);
  assert.equal(r.body.status, 'expired', 'stored "active" plus a past date reads as expired');
});

test('an account with no subscription record at all predates subscriptions and is let in', async t => {
  // Upgrading a running instance must not lock out everyone already training on it.
  const h = await startServer(t, undefined);
  const r = await h.asClient('GET', '/api/data');
  assert.equal(r.status, 200);
  assert.equal((await h.asClient('GET', '/api/me')).body.account.sub.legacy, true);
});

test('one device per account: the second is refused, and only the coach can release the binding', async t => {
  const h = await startServer(t, paid());
  const PHONE = 'phone-aaaaaaaa', OTHER = 'other-bbbbbbbb';

  // Nothing is bound until a sign-in binds it, so a first-ever token works.
  assert.equal((await h.asClient('GET', '/api/data', null, PHONE)).status, 200);

  // Bind the account to the phone the way a sign-in does.
  fs.writeFileSync(path.join(h.dataDir, 'db.json'), JSON.stringify({
    ...h.db(),
    users: h.db().users.map(u => u.id === CLIENT ? { ...u, device: { id: PHONE, label: 'iOS · Safari', boundAt: new Date().toISOString() } } : u)
  }));
  // Restart so the server reads the binding.
  const restart = async () => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: '0', DATA_DIR: h.dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
    });
    let log = '';
    child.stdout.on('data', d => log += d);
    child.stderr.on('data', d => log += d);
    t.after(() => child.kill('SIGKILL'));
    const port = await boundPort(child, () => log);
    return {
      port,
      get: (p, did) => fetch(`http://127.0.0.1:${port}${p}`, { headers: cookie(CLIENT, did) }),
      admin: (p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: cookie(ADMIN), body: JSON.stringify(body) })
    };
  };
  let s = await restart();

  assert.equal((await s.get('/api/data', PHONE)).status, 200, 'the bound device still works');
  assert.equal((await s.get('/api/data', OTHER)).status, 401, 'another device gets nothing');
  assert.equal((await s.get('/api/data', '')).status, 401, 'nor does a token with no device at all');

  // The coach releases it — the ordinary case is a client who changed phone.
  const rel = await s.admin('/api/admin/user/device/release', { id: CLIENT });
  assert.equal(rel.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dataDir, 'db.json'), 'utf8')).users.find(u => u.id === CLIENT).device, undefined);
  assert.equal((await s.get('/api/data', OTHER)).status, 200, 'the new phone is let in');
});

test('an admin is never device-bound and never paywalled', async t => {
  const h = await startServer(t, unpaid());
  // The coach works from a phone and a desktop, and is staff rather than a customer.
  assert.equal((await h.asAdmin('GET', '/api/admin/users')).status, 200);
  const r = await h.call('GET', '/api/me', cookie(ADMIN, 'desktop-cccccccc'));
  assert.equal(r.status, 200);
  assert.equal(r.body.user.admin, true);
  const r2 = await h.call('GET', '/api/me', cookie(ADMIN, 'laptop-dddddddd'));
  assert.equal(r2.status, 200, 'a second admin device is fine');
});

test('the admin list and drill-down carry what the coach needs to run the relationship', async t => {
  const h = await startServer(t, paid());
  await h.asClient('POST', '/api/intake', { goal: 'get_stronger', daysPerWeek: 3 });
  await h.asClient('POST', '/api/plan-request', { kind: 'new', message: 'please' });
  await h.asAdmin('PUT', '/api/admin/plan', { id: CLIENT, plan: { routines: [{ id: 'r1', name: 'A', ex: [] }], week: { 1: 'r1', 3: 'r1' } } });

  let r = await h.asAdmin('GET', '/api/admin/users');
  const row = r.body.users.find(u => u.id === CLIENT);
  assert.equal(row.goal, 'get_stronger');
  assert.equal(row.hasIntake, true);
  assert.equal(row.openRequest, true);
  assert.equal(row.planReady, true);
  assert.equal(row.sub.status, 'active');
  assert.equal(row.adherence.perWeek, 2, 'two days of the assigned week carry a routine');
  assert.equal(row.adherence.d7, 0, 'nothing logged yet');

  r = await h.asAdmin('GET', '/api/admin/requests');
  assert.equal(r.body.requests.length, 1);
  assert.equal(r.body.requests[0].userName, 'Client');
  assert.equal(r.body.requests[0].intake.goal, 'get_stronger');

  r = await h.asAdmin('POST', '/api/admin/requests/resolve', { id: r.body.requests[0].id, status: 'done', adminNote: 'published' });
  assert.equal(r.status, 200);
  assert.equal(r.body.request.status, 'done');
  // Resolved means it stops showing as the client's open ask.
  assert.equal((await h.asClient('GET', '/api/plan-request')).body.request, null);

  r = await h.asAdmin('GET', `/api/admin/user?id=${CLIENT}`);
  assert.equal(r.body.plan.routines.length, 1);
  assert.equal(r.body.intake.goal, 'get_stronger');
  assert.deepEqual(r.body.routines.map(x => x.id), ['r1'], 'the drill-down lists the assigned plan');
});

test('deleting a client takes their plan, requests and posts with them', async t => {
  const h = await startServer(t, paid());
  await h.asClient('POST', '/api/plan-request', { goal: 'lose_weight' });
  await h.asAdmin('PUT', '/api/admin/plan', { id: CLIENT, plan: { routines: [{ id: 'r1', name: 'A', ex: [] }], week: {} } });
  await h.asClient('PUT', '/api/data', { state: { unit: 'kg', workouts: [] } });
  assert.equal(fs.existsSync(path.join(h.dataDir, `plan-${CLIENT}.json`)), true);

  const r = await h.asAdmin('POST', '/api/admin/user/delete', { id: CLIENT });
  assert.equal(r.status, 200);
  assert.equal(fs.existsSync(path.join(h.dataDir, `plan-${CLIENT}.json`)), false);
  assert.equal(fs.existsSync(path.join(h.dataDir, `state-${CLIENT}.json`)), false);
  assert.deepEqual(h.db().planRequests, []);
});
