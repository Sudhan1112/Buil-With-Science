/* The community hub's one rule, checked end to end: a private post is the author's and the
   coach's, and nobody else's — not in the feed, not by id, and not the photo attached to it.

   The photo is the part worth a child process rather than a unit test. `GET /api/community/
   media/{hash}` is the only route in the app where one account reads another's file, so the
   authorization is not "is this your folder" but "is this hash attached to a post you may see".
   Getting that wrong turns a 64-character string into a capability, and a hash travels: it is
   in the feed JSON of every post that carries it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import * as M from './media-samples.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const SECRET = crypto.randomBytes(32).toString('hex');
const ANA = 'u_hub_ana', BO = 'u_hub_bo', COACH = 'u_hub_coach';

const mint = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const cookie = uid => ({ Cookie: `gymsid=${mint(uid)}`, Origin: ORIGIN, 'Content-Type': 'application/json' });

async function start(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-hub-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  // No `sub` on the clients: an account that predates subscriptions reads as active, which
  // keeps this file about visibility and nothing else.
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [
      { id: ANA, name: 'Ana', created: new Date().toISOString() },
      { id: BO, name: 'Bo', created: new Date().toISOString() },
      { id: COACH, name: 'Coach', created: new Date().toISOString(), admin: true }
    ], creds: [], subs: [], invites: []
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', MEDIA_MIN_FREE_MB: '1' }
  });
  const h = { log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.port = await boundPort(child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  h.call = async (method, p, uid, body) => {
    const r = await fetch(`${h.api}${p}`, { method, headers: cookie(uid), body: body && JSON.stringify(body) });
    const txt = await r.text();
    return { status: r.status, body: txt ? JSON.parse(txt) : null };
  };
  h.feed = async uid => (await h.call('GET', '/api/community', uid)).body.posts;
  // One photo into `uid`'s own folder, the ordinary way, so it is there to be attached.
  h.upload = async (uid, bytes) => {
    const hash = M.sha(bytes);
    const r = await fetch(`${h.api}/api/media/${hash}`, {
      method: 'PUT', headers: { Cookie: cookie(uid).Cookie, Origin: ORIGIN, 'Content-Type': 'image/jpeg' }, body: bytes
    });
    assert.ok(r.status === 200 || r.status === 201, 'upload ' + r.status);
    return hash;
  };
  h.photo = (hash, uid) => fetch(`${h.api}/api/community/media/${hash}`, { headers: { Cookie: cookie(uid).Cookie, Origin: ORIGIN } });
  return h;
}

test('a private post is the author\'s and the coach\'s: another client cannot read it, reply to it or delete it', async t => {
  const h = await start(t);

  const priv = (await h.call('POST', '/api/community', ANA, { text: 'my knee is still sore', visibility: 'private' })).body.post;
  const pub = (await h.call('POST', '/api/community', ANA, { text: 'first pull-up today', visibility: 'public' })).body.post;
  assert.equal(priv.visibility, 'private');
  assert.equal(pub.visibility, 'public');

  // Bo's feed holds the public one and nothing else, whatever scope is asked for.
  assert.deepEqual((await h.feed(BO)).map(p => p.id), [pub.id]);
  for (const scope of ['mine', 'private', 'all']) {
    const rows = (await h.call('GET', '/api/community?scope=' + scope, BO)).body.posts;
    assert.equal(rows.some(p => p.id === priv.id), false, 'scope=' + scope + ' cannot widen what canSee allowed');
  }

  // By id it is as missing as a post that was never written — a 403 would confirm it exists.
  assert.equal((await h.call('POST', '/api/community/reply', BO, { id: priv.id, text: 'hi' })).status, 404);
  assert.equal((await h.call('POST', '/api/community/delete', BO, { id: priv.id })).status, 404);

  // The author and the coach both see it, and the coach can answer it. That is the point of it.
  assert.equal((await h.feed(ANA)).some(p => p.id === priv.id), true);
  assert.equal((await h.feed(COACH)).some(p => p.id === priv.id), true);
  const answered = (await h.call('POST', '/api/community/reply', COACH, { id: priv.id, text: 'skip the lunges' })).body.post;
  assert.equal(answered.replies.at(-1).author.coach, true, 'advice is badged, not mistaken for a peer\'s opinion');

  // Bo may delete neither Ana's public post nor the coach's reply on it; the coach may delete both.
  await h.call('POST', '/api/community/reply', BO, { id: pub.id, text: 'nice' });
  assert.equal((await h.call('POST', '/api/community/delete', BO, { id: pub.id })).status, 403);
  assert.equal((await h.call('POST', '/api/community/delete', COACH, { id: pub.id })).status, 200);
  assert.deepEqual((await h.feed(BO)).map(p => p.id), []);
});

test('a photo is readable exactly as far as the post it hangs on', async t => {
  const h = await start(t);

  const secret = await h.upload(ANA, M.jpeg(900));
  const shared = await h.upload(ANA, M.jpeg(901));
  const loose = await h.upload(ANA, M.jpeg(902));   // uploaded, never posted

  await h.call('POST', '/api/community', ANA, { text: 'week 1', images: [secret], visibility: 'private' });
  await h.call('POST', '/api/community', ANA, { text: 'week 8', images: [shared], visibility: 'public' });

  assert.equal((await h.photo(shared, BO)).status, 200, 'a public post\'s photo is public');
  assert.equal((await h.photo(secret, BO)).status, 404, 'a private post\'s photo is not');
  assert.equal((await h.photo(loose, BO)).status, 404, 'and a hash on no post at all is nothing');
  assert.equal((await h.photo(secret, ANA)).status, 200);
  assert.equal((await h.photo(secret, COACH)).status, 200);

  // Naming someone else's hash in your own post does not reach their file: the bytes come from
  // the author's folder, and Bo's folder is empty.
  await h.call('POST', '/api/community', BO, { text: 'mine, honest', images: [secret], visibility: 'public' });
  assert.equal(fs.existsSync(path.join(h.dataDir, 'uploads', BO)), false);
  const stolen = await h.photo(secret, BO);
  assert.equal(stolen.status, 404, 'the claim does not make the file his');

  // Deleting the public post takes its photo back out of reach through this route — for Ana
  // too, who reads her own files through /api/media/{hash} and still can.
  const pub = (await h.feed(ANA)).find(p => p.images?.includes(shared));
  assert.equal((await h.call('POST', '/api/community/delete', ANA, { id: pub.id })).status, 200);
  assert.equal((await h.photo(shared, BO)).status, 404);
  const own = await fetch(`${h.api}/api/media/${shared}`, { headers: { Cookie: cookie(ANA).Cookie, Origin: ORIGIN } });
  assert.equal(own.status, 200, 'the file itself is untouched; it is only unshared');
});
