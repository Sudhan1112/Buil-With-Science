/* Persistence for the CareFit API: JSON files under DATA_DIR (tests / local), or Supabase
 * (Postgres) when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set.
 *
 * The in-memory `db` shape and state/plan documents stay what server.js already uses. This
 * module only replaces where bytes land. Writes are serialized per key so a 409 on `_rev`
 * stays meaningful under a single Render instance.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

function atomicWrite(file, content, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

const emptyDb = () => ({
  users: [], creds: [], subs: [], invites: [], deviceLinks: [], planRequests: [], posts: []
});

function normalizeDb(raw) {
  const db = raw && typeof raw === 'object' ? raw : emptyDb();
  db.users = Array.isArray(db.users) ? db.users : [];
  db.creds = Array.isArray(db.creds) ? db.creds : [];
  db.subs = Array.isArray(db.subs) ? db.subs : [];
  db.invites = Array.isArray(db.invites) ? db.invites : [];
  db.deviceLinks = Array.isArray(db.deviceLinks) ? db.deviceLinks : [];
  db.planRequests = Array.isArray(db.planRequests) ? db.planRequests : [];
  db.posts = Array.isArray(db.posts) ? db.posts : [];
  return db;
}

function safeUid(uid) {
  return String(uid || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

/** One promise chain per key so overlapping upserts for the same uid cannot race. */
function createQueues() {
  const q = new Map();
  return (key, fn) => {
    const prev = q.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    q.set(key, next.catch(() => {}));
    return next;
  };
}

function createFileStore(DATA) {
  fs.mkdirSync(DATA, { recursive: true });
  const stateFile = uid => path.join(DATA, 'state-' + safeUid(uid) + '.json');
  const planFile = uid => path.join(DATA, 'plan-' + safeUid(uid) + '.json');
  const dbFile = path.join(DATA, 'db.json');
  const auditFile = path.join(DATA, 'audit.log');
  const vapidFile = path.join(DATA, 'vapid.json');
  const secretFile = path.join(DATA, 'secret');

  let secret = process.env.SESSION_SECRET || '';
  if (!secret) {
    if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    secret = fs.readFileSync(secretFile, 'utf8').trim();
  }

  let db = emptyDb();
  try { db = normalizeDb(JSON.parse(fs.readFileSync(dbFile, 'utf8'))); } catch { /* fresh */ }

  return {
    kind: 'file',
    dataDir: DATA,
    secret,
    db,
    async boot() { return this; },
    async saveDb() {
      atomicWrite(dbFile, JSON.stringify(db, null, 2), 0o600);
    },
    readState(uid) {
      try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
    },
    async writeState(uid, doc) {
      atomicWrite(stateFile(uid), JSON.stringify(doc));
    },
    async deleteState(uid) {
      try { fs.unlinkSync(stateFile(uid)); } catch { /* gone */ }
    },
    stateStat(uid) {
      try { return fs.statSync(stateFile(uid)); } catch { return null; }
    },
    readPlan(uid) {
      try { return JSON.parse(fs.readFileSync(planFile(uid), 'utf8')); } catch { return null; }
    },
    async writePlan(uid, doc) {
      atomicWrite(planFile(uid), JSON.stringify(doc));
      return doc;
    },
    async deletePlan(uid) {
      try { fs.unlinkSync(planFile(uid)); } catch { /* gone */ }
    },
    planExists(uid) {
      return fs.existsSync(planFile(uid));
    },
    loadVapid(generate) {
      try { return JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
      catch {
        const vapid = generate();
        fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 });
        return vapid;
      }
    },
    async saveVapid(vapid) {
      fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 });
    },
    appendAudit(rec) {
      fs.appendFileSync(auditFile, JSON.stringify(rec) + '\n');
    },
    auditLines() {
      let text;
      try { text = fs.readFileSync(auditFile, 'utf8'); } catch { return []; }
      const rows = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { const r = JSON.parse(line); if (r && r.id && r.ev) rows.push(r); } catch { /* torn */ }
      }
      return rows;
    },
    writeAuditLines(rows) {
      atomicWrite(auditFile, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    },
    client: null
  };
}

async function createSupabaseStore(url, key) {
  const sb = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const enqueue = createQueues();
  const states = new Map();
  const plans = new Map();

  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET (at least 32 chars) is required when using Supabase');
  }

  async function loadDb() {
    const db = emptyDb();
    const [users, creds, subs, invites, deviceLinks, planRequests, posts] = await Promise.all([
      sb.from('users').select('id, doc'),
      sb.from('creds').select('id, user_id, doc'),
      sb.from('push_subs').select('endpoint, user_id, doc'),
      sb.from('invites').select('code, doc'),
      sb.from('device_links').select('id, doc'),
      sb.from('plan_requests').select('id, user_id, doc'),
      sb.from('posts').select('id, user_id, doc, created')
    ]);
    for (const r of [users, creds, subs, invites, deviceLinks, planRequests, posts]) {
      if (r.error) throw new Error('supabase load: ' + r.error.message);
    }
    db.users = users.data.map(r => ({ id: r.id, ...(r.doc || {}) }));
    db.creds = creds.data.map(r => ({ id: r.id, userId: r.user_id, ...(r.doc || {}) }));
    db.subs = subs.data.map(r => ({ endpoint: r.endpoint, userId: r.user_id, ...(r.doc || {}) }));
    db.invites = invites.data.map(r => ({ code: r.code, ...(r.doc || {}) }));
    db.deviceLinks = deviceLinks.data.map(r => ({ id: r.id, ...(r.doc || {}) }));
    db.planRequests = planRequests.data.map(r => ({ id: r.id, userId: r.user_id, ...(r.doc || {}) }));
    db.posts = posts.data.map(r => ({ id: r.id, userId: r.user_id, created: r.created, ...(r.doc || {}) }));
    return normalizeDb(db);
  }

  const store = {
    kind: 'supabase',
    dataDir: null,
    secret,
    db: emptyDb(),
    client: sb,
    async boot() {
      store.db = await loadDb();
      const [st, pl] = await Promise.all([
        sb.from('states').select('uid, doc, rev'),
        sb.from('plans').select('uid, doc, rev')
      ]);
      if (st.error) throw new Error('supabase states: ' + st.error.message);
      if (pl.error) throw new Error('supabase plans: ' + pl.error.message);
      for (const r of st.data || []) states.set(r.uid, r.doc);
      for (const r of pl.data || []) plans.set(r.uid, r.doc);
      return store;
    },
    async saveDb() {
      const db = store.db;
      return enqueue('db', async () => {
        // Full replace of each collection (instance is single-replica; db is the source of truth).
        const userRows = db.users.map(u => {
          const { id, ...doc } = u;
          return { id, doc };
        });
        const credRows = db.creds.map(c => {
          const { id, userId, ...doc } = c;
          return { id, user_id: userId, doc: { ...doc, userId } };
        });
        const subRows = db.subs.map(s => {
          const { endpoint, userId, ...doc } = s;
          return { endpoint, user_id: userId, doc: { ...doc, userId } };
        });
        const inviteRows = db.invites.map(i => {
          const { code, ...doc } = i;
          return { code, doc };
        });
        const linkRows = db.deviceLinks.map(l => {
          const { id, ...doc } = l;
          return { id, doc };
        });
        const reqRows = db.planRequests.map(r => {
          const { id, userId, ...doc } = r;
          return { id, user_id: userId, doc: { ...doc, userId } };
        });
        const postRows = db.posts.map(p => {
          const { id, userId, created, ...doc } = p;
          return { id, user_id: userId, created: created || null, doc: { ...doc, userId, created } };
        });

        // Delete rows that disappeared from memory, then upsert current set.
        const delMissing = async (table, key, keep) => {
          const { data, error } = await sb.from(table).select(key);
          if (error) throw error;
          const drop = (data || []).map(r => r[key]).filter(k => !keep.has(k));
          if (drop.length) {
            const { error: e2 } = await sb.from(table).delete().in(key, drop);
            if (e2) throw e2;
          }
        };
        await delMissing('users', 'id', new Set(userRows.map(r => r.id)));
        if (userRows.length) {
          const { error } = await sb.from('users').upsert(userRows);
          if (error) throw error;
        }
        await delMissing('creds', 'id', new Set(credRows.map(r => r.id)));
        if (credRows.length) {
          const { error } = await sb.from('creds').upsert(credRows);
          if (error) throw error;
        }
        await delMissing('push_subs', 'endpoint', new Set(subRows.map(r => r.endpoint)));
        if (subRows.length) {
          const { error } = await sb.from('push_subs').upsert(subRows);
          if (error) throw error;
        }
        await delMissing('invites', 'code', new Set(inviteRows.map(r => r.code)));
        if (inviteRows.length) {
          const { error } = await sb.from('invites').upsert(inviteRows);
          if (error) throw error;
        }
        await delMissing('device_links', 'id', new Set(linkRows.map(r => r.id)));
        if (linkRows.length) {
          const { error } = await sb.from('device_links').upsert(linkRows);
          if (error) throw error;
        }
        await delMissing('plan_requests', 'id', new Set(reqRows.map(r => r.id)));
        if (reqRows.length) {
          const { error } = await sb.from('plan_requests').upsert(reqRows);
          if (error) throw error;
        }
        await delMissing('posts', 'id', new Set(postRows.map(r => r.id)));
        if (postRows.length) {
          const { error } = await sb.from('posts').upsert(postRows);
          if (error) throw error;
        }
      });
    },
    readState(uid) {
      const id = safeUid(uid);
      return states.has(id) ? states.get(id) : null;
    },
    async writeState(uid, doc) {
      const id = safeUid(uid);
      if (!id) throw new Error('bad uid');
      states.set(id, doc);
      const rev = Number(doc?._rev) || 0;
      return enqueue('state:' + id, async () => {
        const { error } = await sb.from('states').upsert({ uid: id, doc, rev });
        if (error) throw error;
      });
    },
    async deleteState(uid) {
      const id = safeUid(uid);
      states.delete(id);
      return enqueue('state:' + id, async () => {
        const { error } = await sb.from('states').delete().eq('uid', id);
        if (error) throw error;
      });
    },
    stateStat(uid) {
      const S = store.readState(uid);
      if (!S) return null;
      const size = Buffer.byteLength(JSON.stringify(S));
      return { mtimeMs: Number(S._ts) || Date.now(), size };
    },
    readPlan(uid) {
      const id = safeUid(uid);
      return plans.has(id) ? plans.get(id) : null;
    },
    async writePlan(uid, doc) {
      const id = safeUid(uid);
      if (!id) throw new Error('bad uid');
      plans.set(id, doc);
      const rev = Number(doc?._rev) || 0;
      await enqueue('plan:' + id, async () => {
        const { error } = await sb.from('plans').upsert({ uid: id, doc, rev });
        if (error) throw error;
      });
      return doc;
    },
    async deletePlan(uid) {
      const id = safeUid(uid);
      plans.delete(id);
      return enqueue('plan:' + id, async () => {
        const { error } = await sb.from('plans').delete().eq('uid', id);
        if (error) throw error;
      });
    },
    planExists(uid) {
      return plans.has(safeUid(uid));
    },
    loadVapid(generate) {
      // Sync API for boot; real load happens in bootVapid below. Placeholder until then.
      return null;
    },
    async bootVapid(generate) {
      const { data, error } = await sb.from('config').select('doc').eq('key', 'vapid').maybeSingle();
      if (error) throw error;
      if (data?.doc?.publicKey && data?.doc?.privateKey) return data.doc;
      const vapid = generate();
      const { error: e2 } = await sb.from('config').upsert({ key: 'vapid', doc: vapid });
      if (e2) throw e2;
      return vapid;
    },
    async saveVapid(vapid) {
      const { error } = await sb.from('config').upsert({ key: 'vapid', doc: vapid });
      if (error) throw error;
    },
    appendAudit(rec) {
      // Fire-and-forget; audit must not break sign-in.
      sb.from('audit').insert({
        id: rec.id,
        ts: rec.ts,
        ev: rec.ev,
        ok: rec.ok !== false,
        uid: rec.uid || null,
        name: rec.name || null,
        tgt: rec.tgt || null,
        tname: rec.tname || null,
        msg: rec.msg || null,
        act: rec.act || null,
        ip: rec.ip || null,
        doc: rec
      }).then(({ error }) => { if (error) console.error('audit write failed', error.message); });
    },
    auditLines() {
      // Sync readers (admin UI) use the cached last fetch; refresh via refreshAudit().
      return store._auditCache || [];
    },
    async refreshAudit() {
      const { data, error } = await sb.from('audit').select('doc').order('id', { ascending: true }).limit(20000);
      if (error) throw error;
      store._auditCache = (data || []).map(r => r.doc).filter(r => r && r.id && r.ev);
      return store._auditCache;
    },
    writeAuditLines(rows) {
      store._auditCache = rows;
      if (!rows.length) {
        sb.from('audit').delete().neq('id', 0).then(({ error }) => {
          if (error) console.error('audit clear failed', error.message);
        });
        return;
      }
      const keepIds = new Set(rows.map(r => r.id));
      sb.from('audit').select('id').then(async ({ data, error }) => {
        if (error) return console.error('audit compact failed', error.message);
        const drop = (data || []).map(r => r.id).filter(id => !keepIds.has(id));
        if (!drop.length) return;
        const { error: e2 } = await sb.from('audit').delete().in('id', drop);
        if (e2) console.error('audit compact failed', e2.message);
      });
    },
    _auditCache: []
  };
  return store;
}

/**
 * Open the store. Prefer Supabase when both URL and service role are set; otherwise DATA_DIR.
 * Call `await store.boot()` before serving.
 */
export async function openStore({
  dataDir = process.env.DATA_DIR || '/data',
  supabaseUrl = process.env.SUPABASE_URL || '',
  supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
} = {}) {
  if (supabaseUrl && supabaseKey) {
    const store = await createSupabaseStore(supabaseUrl, supabaseKey);
    await store.boot();
    return store;
  }
  const store = createFileStore(dataDir);
  await store.boot();
  return store;
}

export { atomicWrite, emptyDb, normalizeDb, safeUid };
