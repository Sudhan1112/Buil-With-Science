// The coach's view of one client: what they are paying for, what they asked for, what they
// have been given, and how much of it they are doing.
//
// Everything here is read or written through /api/admin/* — the coach never signs in as the
// client and never opens their state document. Like the rest of views/Admin.jsx this is
// deliberately English-only: the operator surface is not part of the translated app.
//
// It is a sheet rather than a route so the clients list stays underneath it. The plan editor is
// the one thing that leaves (to /admin/client/:id/plan): editing a programme is a sitting-down
// job, not something to do in a sheet over a list.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { fmtDate, fmtVol, fmtDur } from '../lib/format.js'
import { workoutVolume, setsDone } from '../lib/history.js'
import { GOALS, EXPERIENCE } from '../lib/goals.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

const rel = ts => {
  if (!ts) return 'never'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + ' min ago'
  if (s < 86400) return Math.floor(s / 3600) + ' h ago'
  return Math.floor(s / 86400) + ' d ago'
}
const day = ts => (ts ? new Date(ts).toLocaleDateString() : '—')
// Goals and experience levels are stored as the keys lib/goals.js defines, and their labels
// come from the same place — the one piece of this page that follows the app's language rather
// than staying English, because inventing a second wording for the same five options is how the
// coach ends up reading something the client never saw.
const labelOf = (list, key) => list.find(x => x.value === key)?.label() || key || '—'

/** Subscription state as a pill: the one thing the coach checks first. */
export function SubPill({ sub }) {
  if (!sub) return null
  const { status, paidUntil, legacy } = sub
  if (legacy) return <span className="adm-pill">no subscription record</span>
  if (status === 'active') {
    // Inside a week of running out is worth flagging before it locks them out mid-block.
    const soon = paidUntil && paidUntil - Date.now() < 7 * 86400000
    return <span className={'adm-pill ' + (soon ? 'acc' : '')}>paid to {day(paidUntil)}</span>
  }
  if (status === 'expired') return <span className="adm-pill bad">expired {day(paidUntil)}</span>
  return <span className="adm-pill bad">awaiting payment</span>
}

/* ---------------------------------------------------------------- subscription ---------------
   There is no payment provider to reconcile against: the coach sees the transfer arrive and
   records it here. "Extend" adds to the time left so an early renewal is not punished;
   "Activate" is the same call for an account that has never paid. Neither touches a byte of
   their training data — the whole point of the gate is that a lapsed client comes back to the
   dashboard they left. */
function SubscriptionCard({ d, reload }) {
  const toast = useUI(s => s.toast)
  const [months, setMonths] = useState(1)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const sub = d.sub || {}
  const send = action => {
    if (busy) return
    setBusy(true)
    api('/api/admin/user/subscription', { method: 'POST', body: JSON.stringify({ id: d.user.id, action, months, note }) })
      .then(() => { toast(action === 'expire' ? 'Access ended' : 'Payment recorded'); setNote(''); reload() })
      .catch(e => toast(e.message))
      .finally(() => setBusy(false))
  }
  const first = sub.status === 'pending' || sub.legacy
  return <>
    <h4 className="sec">Subscription</h4>
    <div className="adm-lead">
      {sub.legacy
        ? 'This account predates subscriptions, so it is not gated. Recording a payment starts one.'
        : sub.status === 'active' ? 'Access runs to ' + day(sub.paidUntil) + '. Recording a payment adds to that, so renewing early loses nothing.'
          : sub.status === 'expired' ? 'Access ran out on ' + day(sub.paidUntil) + '. They see the renewal screen; their data is untouched and comes back the moment you record a payment.'
            : 'They have never paid, so they see the payment screen and the intake form. Record the payment once you see it arrive.'}
    </div>
    {!!sub.note && <div className="adm-hint" style={{ marginTop: -4 }}>Last note: {sub.note}</div>}
    <div className="row" style={{ gap: 8, margin: '10px 0' }}>
      <select className="input" style={{ flex: '0 0 110px' }} value={months} onChange={e => setMonths(Number(e.target.value))} aria-label="months">
        {[1, 2, 3, 6, 12].map(m => <option key={m} value={m}>{m} month{m > 1 ? 's' : ''}</option>)}
      </select>
      <input className="input grow" placeholder="Note (how they paid, reference…)" maxLength={300}
        value={note} onChange={e => setNote(e.target.value)} />
    </div>
    <Button variant="primary" disabled={busy} onClick={() => send(first ? 'activate' : 'extend')}>
      {first ? 'Record payment & open access' : 'Record payment & extend'}
    </Button>
    {sub.status === 'active' && !sub.legacy && <>
      <button className="btn danger" style={{ margin: '8px 0 4px' }} disabled={busy}
        onClick={() => confirmSheet({
          title: 'End ' + d.user.name + '’s access now?',
          message: 'They lose the dashboard immediately and see the renewal screen instead. Nothing of theirs is deleted — recording a payment brings it all back.',
          confirmText: 'End access', danger: true, onConfirm: () => send('expire')
        })}>End access now</button>
      <div className="adm-hint">For a refund or someone who has stopped. Normally just let it run out.</div>
    </>}
  </>
}

/* ------------------------------------------------------------------- the device --------------
   One subscription, one device. The server binds the first device a client signs in from and
   answers every other with a 409 (components/DeviceLocked.jsx shows them why). A new phone is
   the ordinary reason this needs releasing, which is why the button is plain rather than
   dangerous — but it is also the lever someone sharing a login would ask for, so it names the
   bound device and when it was bound. */
function DeviceCard({ d, reload }) {
  const toast = useUI(s => s.toast)
  const dev = d.device
  const release = () => confirmSheet({
    title: 'Release ' + d.user.name + '’s device?',
    message: 'They are signed out, and the next device they sign in from becomes the one their account is tied to. Do this when they change phone — not to let two people share an account.',
    confirmText: 'Release', danger: true,
    onConfirm: () => api('/api/admin/user/device/release', { method: 'POST', body: JSON.stringify({ id: d.user.id }) })
      .then(() => { toast('Device released'); reload() }).catch(e => toast(e.message))
  })
  return <>
    <h4 className="sec">Device</h4>
    {dev ? <>
      <div className="adm-lead">Tied to <b>{dev.label || 'a device'}</b> since {dev.boundAt ? new Date(dev.boundAt).toLocaleString() : 'unknown'}. Any other device is refused.</div>
      <button className="btn" onClick={release}>Release the device lock</button>
    </> : <div className="adm-lead">Not tied to a device yet — the next one they sign in from claims it.</div>}
  </>
}

/* ------------------------------------------------------------------- what they asked ---------
   The intake form they filled in at signup, and any open request for a change. Marking a
   request done is what clears the "your plan is being made" line on their Home screen, so it
   belongs next to the plan rather than in a separate inbox — though the inbox on the dashboard
   lists them too, for the coach who starts their day there. */
function RequestCard({ d, reload }) {
  const toast = useUI(s => s.toast)
  const [note, setNote] = useState('')
  const r = d.request
  const intake = d.intake
  const resolve = status => api('/api/admin/requests/resolve', { method: 'POST', body: JSON.stringify({ id: r.id, status, adminNote: note }) })
    .then(() => { toast(status === 'done' ? 'Marked done' : 'Marked in progress'); setNote(''); reload() })
    .catch(e => toast(e.message))
  return <>
    <h4 className="sec">What they asked for</h4>
    {intake ? <div>
      {[
        ['Goal', labelOf(GOALS, intake.goal)],
        ['Experience', labelOf(EXPERIENCE, intake.experience)],
        ['Days a week', intake.days || '—'],
        ['Equipment', intake.equipment],
        ['Injuries or limits', intake.injuries],
        ['In their words', intake.note],
      ].filter(([, v]) => v).map(([k, v]) =>
        <div key={k} className="adm-kv"><span className="k">{k}</span><span className="v">{v}</span></div>)}
    </div> : <div className="adm-empty">They have not filled in the intake form yet.</div>}

    {r ? <div className="card" style={{ marginTop: 10, borderColor: 'var(--acc)' }}>
      <div className="row between"><b className="small">Open request</b>
        <span className="adm-pill acc">{r.status === 'in_progress' ? 'in progress' : 'open'}</span></div>
      <div className="adm-lead" style={{ margin: '6px 0' }}>{r.note || 'No note — they used the button without writing anything.'}</div>
      <div className="adm-hint">Asked {r.created ? new Date(r.created).toLocaleString() : '—'}.</div>
      <input className="input" style={{ marginTop: 8 }} placeholder="Reply (they do not see this — it is your note)" maxLength={1000}
        value={note} onChange={e => setNote(e.target.value)} />
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <Button size="sm" onClick={() => resolve('in_progress')}>Working on it</Button>
        <Button size="sm" variant="primary" onClick={() => resolve('done')}>Mark done</Button>
      </div>
    </div> : <div className="adm-hint" style={{ marginTop: 8 }}>No open request.</div>}
  </>
}

/* --------------------------------------------------------------------- the plan ---------------
   A summary and a way into the editor. The numbers are the two that say whether the coaching is
   working: is there a plan at all, and are they doing it. Adherence is sessions logged against
   sessions prescribed — null when the week is empty, because dividing by nothing says more
   about the plan than about the client. */
function PlanCard({ d, close }) {
  const nav = useNavigate()
  const plan = d.plan || {}
  const a = d.adherence || {}
  const published = !!(plan.routines?.length)
  return <>
    <h4 className="sec">Their plan</h4>
    {published ? <>
      <div className="adm-lead">
        {plan.routines.length} routine{plan.routines.length > 1 ? 's' : ''}, {Object.values(plan.week || {}).filter(v => (Array.isArray(v) ? v.length : !!v)).length} training day{a.perWeek === 1 ? '' : 's'} a week.
        {plan.updatedAt ? ' Last written ' + new Date(plan.updatedAt).toLocaleString() + (plan.updatedBy ? ' by ' + plan.updatedBy : '') + '.' : ''}
      </div>
      {!!plan.note && <div className="adm-hint" style={{ marginTop: -4 }}>Your note to them: “{plan.note}”</div>}
    </> : <div className="adm-empty">No plan yet — they are looking at “your coach is writing your programme”.</div>}
    <Button variant="primary" icon="pencil" onClick={() => { close(); nav('/admin/client/' + d.user.id + '/plan') }}>
      {published ? 'Edit their plan' : 'Write their plan'}
    </Button>
  </>
}

/* ---------------------------------------------------------------------- the sheet ------------- */
export default function AdminClient({ id, onChanged, close }) {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  const toast = useUI(s => s.toast)
  // Reloaded after every write rather than patched: these endpoints derive most of what they
  // return (effective subscription status, adherence, whether a plan counts as published), and
  // guessing at that in two places is how the two drift apart.
  const load = () => api('/api/admin/user?id=' + encodeURIComponent(id))
    .then(r => { setD(r); setErr(null); onChanged?.() })
    .catch(e => setErr(e.message))
  useEffect(() => { load() }, [id])

  if (err) return <div className="card" role="alert" style={{ borderColor: 'var(--red)' }}>
    <b className="small">Could not load this client</b>
    <div className="adm-lead" style={{ marginBottom: 8 }}>{err}</div>
    <Button size="sm" icon="reset" onClick={load}>Try again</Button>
  </div>
  if (!d) return <div className="muted small">Loading…</div>

  const u = d.user
  // A state file written before PUT /api/data started dropping shapeless entries can still hold
  // them, and this sheet renders outside the route's ErrorBoundary: one throw blanks the app.
  const workouts = (d.workouts || []).filter(w => w && Array.isArray(w.entries) && w.entries.every(e => e && Array.isArray(e.sets)))
  const a = d.adherence || {}

  return <>
    <h3 className="capitalize">{u.name}</h3>
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '8px 0 12px' }}>
      <SubPill sub={d.sub} />
      {u.disabled && <span className="adm-pill bad">disabled</span>}
      {!!d.request && <span className="adm-pill acc">asked for a plan</span>}
      <span className="adm-pill">joined {u.created ? fmtDate(u.created.slice(0, 10)) : '—'}</span>
    </div>

    <div className="tiles" style={{ textAlign: 'start' }}>
      <div className="tile"><div className="l">Workouts</div><div className="v" style={{ fontSize: '1.1rem' }}>{workouts.length}</div></div>
      <div className="tile"><div className="l">Last 7 days</div><div className="v" style={{ fontSize: '1.1rem' }}>{a.d7 == null ? '—' : a.d7 + '%'}</div></div>
      <div className="tile"><div className="l">Last 28 days</div><div className="v" style={{ fontSize: '1.1rem' }}>{a.d28 == null ? '—' : a.d28 + '%'}</div></div>
      <div className="tile"><div className="l">Last sync</div><div className="v" style={{ fontSize: '.95rem' }}>{rel(d.lastSync)}</div></div>
    </div>
    <div className="adm-hint">Adherence is sessions logged against the sessions their plan prescribes — blank until they have a plan with training days in it.</div>

    <PlanCard d={d} close={close} />
    <RequestCard d={d} reload={load} />
    <SubscriptionCard d={d} reload={load} />
    <DeviceCard d={d} reload={load} />

    <h4 className="sec">Recent sessions</h4>
    {workouts.length ? <div className="list" style={{ gap: 0 }}>
      {workouts.slice(0, 40).map(w => <div key={w.id} className="row between" style={{ padding: '9px 2px', borderBottom: '1px solid var(--sep)' }}>
        <div><div className="small" style={{ fontWeight: 600 }}>{w.name}</div>
          <div className="dim" style={{ fontSize: '.72rem' }}>{fmtDate(w.d, true)} · {fmtDur((w.end || w.start) - w.start)} · {setsDone(w)} sets{w.prs?.length ? ' · ' + w.prs.length + ' PR' : ''}</div></div>
        <span className="small muted">{fmtVol(w.vol ?? workoutVolume(w), d.unit)}</span>
      </div>)}
    </div> : <div className="adm-empty">Nothing logged yet.</div>}

    {!!d.bodyweight?.length && <>
      <h4 className="sec">Body weight</h4>
      <div className="adm-lead">{d.bodyweight.length} weigh-ins, latest {d.bodyweight[d.bodyweight.length - 1]?.kg} kg.</div>
    </>}

    <div style={{ height: 10 }} />
    <Button onClick={() => { toast('Reloaded'); load() }} icon="reset" size="sm">Refresh</Button>
  </>
}
