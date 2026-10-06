// Writing one client's programme.
//
// The split is deliberate. The coach builds and refines routines in their *own* Plan screen
// (views/PlanEdit.jsx and RoutineEdit.jsx) — the full editor, with the exercise library, set
// types, progression rules and every test that already covers them. This screen does the other
// half: it copies a routine out of that library into a client's plan document, lays the week
// out, and publishes.
//
// Keeping it that way means there is exactly one routine editor in the app rather than two
// that drift. It also matches how coaching actually works: you write "Upper A" once and give
// it to six people, then tweak it per person.
//
// A copy, not a reference. The client's plan holds its own routines, so editing the coach's
// template afterwards does not silently rewrite six people's training — the coach re-sends it
// when they mean to.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { DAYN, weekOrder, weekStartOf, exCount, routineCount, uid } from '../lib/format.js'
import { glyphOf } from '../lib/glyphs.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import '../admin.css'

const clone = v => JSON.parse(JSON.stringify(v))
// Days the week object actually prescribes. `week` never stores an empty array (the client
// reads the same shape), so a key with nothing in it still has to be treated as a rest day.
const trainingDays = week => Object.values(week || {}).filter(v => (Array.isArray(v) ? v.length : !!v)).length

/* Pick one of the coach's own routines to copy in. Their library is simply S.routines on the
   signed-in admin account — the same list their Plan screen edits. */
function PickRoutine({ mine, taken, onPick, onBuild, close }) {
  // The first thing a new coach sees on this screen, and it used to be a wall: it named the
  // place to go and then offered only "Close". The Plan tab is the library this copies from,
  // so the empty state has to be the way into it.
  if (!mine.length) return <>
    <h3>No routines of your own yet</h3>
    <div className="adm-lead">Your Plan tab is your template library — the full editor, with the exercise library, set types and progression rules. Write a routine there, then come back and hand it to a client. You write “Upper A” once and give it to everyone it suits.</div>
    <Button variant="primary" icon="plus" onClick={() => { close(); onBuild() }}>Go and write one</Button>
    <div style={{ height: 8 }} />
    <Button onClick={close}>Not now</Button>
  </>
  return <>
    <h3>Copy one of your routines</h3>
    <div className="adm-lead">It is copied into their plan. Editing your version afterwards does not change theirs.</div>
    <div className="list">
      {mine.map(r => <div key={r.id} className="item" onClick={() => { onPick(r); close() }}>
        <span className="lrow-i"><Icon name={glyphOf(r.emoji)} /></span>
        <div className="grow"><div className="tt">{r.name}</div><div className="ss">{exCount(r.ex.length)}{taken.has(r.name) ? ' · already in their plan' : ''}</div></div>
        <Icon name="chevronRight" className="chev" />
      </div>)}
    </div>
  </>
}

/* Which of the client's routines a weekday runs. Multi-select, because a day can hold more than
   one (the client's own Plan screen renders them in order). */
function PickDay({ routines, chosen, onSet, close }) {
  const [sel, setSel] = useState(() => [].concat(chosen || []))
  const toggle = id => setSel(s => (s.includes(id) ? s.filter(x => x !== id) : s.concat(id)))
  return <>
    <h3>What do they train that day?</h3>
    <div className="adm-lead">Nothing selected means a rest day.</div>
    <div className="list">
      {routines.map(r => <div key={r.id} className="item" onClick={() => toggle(r.id)}>
        <span className="lrow-i"><Icon name={glyphOf(r.emoji)} /></span>
        <div className="grow"><div className="tt">{r.name}</div><div className="ss">{exCount(r.ex.length)}</div></div>
        {sel.includes(r.id) && <Icon name="check" style={{ color: 'var(--acc)' }} />}
      </div>)}
    </div>
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={() => { onSet(sel); close() }}>Done</Button>
  </>
}

export default function AdminPlan() {
  const { id } = useParams()
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const mine = useStore(s => s.S.routines)
  const weekStart = useStore(s => weekStartOf(s.S))
  const openSheet = useUI(s => s.openSheet)
  const toast = useUI(s => s.toast)

  const [name, setName] = useState('')
  const [plan, setPlan] = useState(null)     // the draft: { routines, week, note }
  const [baseRev, setBaseRev] = useState(0)  // the revision the draft was taken from
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const load = () => api('/api/admin/plan?id=' + encodeURIComponent(id))
    .then(r => {
      setName(r.user?.name || '')
      setPlan({ routines: clone(r.plan.routines || []), week: clone(r.plan.week || {}), note: r.plan.note || '' })
      setBaseRev(r.plan._rev || 0)
      setDirty(false); setErr(null)
    })
    .catch(e => setErr(e.message))
  useEffect(() => { load() }, [id])

  const edit = fn => {
    setPlan(p => { const next = clone(p); fn(next); return next })
    setDirty(true)
  }
  const takenNames = useMemo(() => new Set((plan?.routines || []).map(r => r.name)), [plan])

  // A fresh id per copy. The coach's own id would collide the moment they hand the same
  // template to a client twice (as "Upper A" and a tweaked "Upper A heavy"), and the week keys
  // routines by id.
  const addRoutine = () => openSheet(close => <PickRoutine mine={mine} taken={takenNames} close={close}
    onBuild={goBuild}
    onPick={r => edit(p => { p.routines.push({ ...clone(r), id: uid() }) })} />)

  const removeRoutine = r => confirmSheet({
    title: 'Remove “' + r.name + '” from their plan?',
    message: 'It comes off every day it was scheduled on. Sessions they have already logged from it are theirs and stay.',
    confirmText: 'Remove', danger: true,
    onConfirm: () => edit(p => {
      p.routines = p.routines.filter(x => x.id !== r.id)
      for (const d of Object.keys(p.week)) {
        const left = [].concat(p.week[d]).filter(x => x !== r.id)
        if (left.length) p.week[d] = left; else delete p.week[d]
      }
    })
  })

  const setDay = (d, ids) => edit(p => { if (ids.length) p.week[d] = ids; else delete p.week[d] })

  // baseRev is what makes two coach tabs safe: the server refuses a write taken from a stale
  // revision rather than letting the second one silently undo the first.
  const save = () => {
    if (busy || !plan) return
    setBusy(true)
    api('/api/admin/plan', { method: 'PUT', body: JSON.stringify({ id, baseRev, plan }) })
      .then(r => { setBaseRev(r.plan._rev); setDirty(false); toast('Plan published to ' + name) })
      .catch(e => {
        if (e.status === 409) {
          toast('Someone else changed this plan — reloading')
          load()
        } else toast(e.message)
      })
      .finally(() => setBusy(false))
  }

  // Every way off this screen asks the same question, because a draft lives in this tab only
  // until it is published.
  const leaveTo = path => {
    if (!dirty) return nav(path)
    confirmSheet({
      title: 'Leave without publishing?',
      message: 'Your changes are only in this tab. They have not reached ' + name + '.',
      confirmText: 'Discard', danger: true, onConfirm: () => nav(path)
    })
  }
  const leave = () => leaveTo('/admin')
  const goBuild = () => leaveTo('/plan')

  if (!user?.admin) return null
  if (err) return <div className="narrow"><div className="card" role="alert" style={{ borderColor: 'var(--red)' }}>
    <b className="small">Could not load this plan</b>
    <div className="adm-lead" style={{ marginBottom: 8 }}>{err}</div>
    <Button size="sm" icon="reset" onClick={load}>Try again</Button>
  </div></div>
  if (!plan) return <div className="narrow"><div className="muted small" style={{ padding: 20 }}>Loading…</div></div>

  const byId = new Map(plan.routines.map(r => [r.id, r]))

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={leave} aria-label="Back"><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 8 }}>
        <h1 style={{ margin: 0 }}>{name}’s plan</h1>
        <div className="sub">{dirty ? 'Unpublished changes' : baseRev ? 'Published · revision ' + baseRev : 'Nothing published yet'}</div>
      </div>
    </div>

    <div className="adm-intro">
      What you publish here is what they see. Their app cannot change any of it — their own Plan
      screen is read-only, and the server refuses routines and week days sent from a client.
    </div>

    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>Routines</h2>
        <Button size="sm" variant="primary" icon="plus" onClick={addRoutine}>Copy one in</Button></div>
      <div className="adm-lead">Copied from your own Plan screen, which is where you write and edit them.</div>
      {plan.routines.length ? <div className="list">
        {plan.routines.map(r => <div key={r.id} className="item">
          <span className="lrow-i"><Icon name={glyphOf(r.emoji)} /></span>
          <div className="grow"><div className="tt">{r.name}</div><div className="ss">{exCount(r.ex?.length || 0)}</div></div>
          <button className="iconbtn adm-iconbtn" style={{ color: 'var(--red)' }} aria-label={'Remove ' + r.name}
            onClick={() => removeRoutine(r)}><Icon name="trash" /></button>
        </div>)}
      </div> : mine.length
        ? <div className="adm-empty">Nothing yet. “Copy one in” takes a routine from your own Plan tab.</div>
        : <div className="adm-empty">
            Nothing yet — and you have no routines of your own to copy. Write one on your Plan tab first; that is the library this copies from.
            <div style={{ height: 10 }} />
            <Button size="sm" variant="primary" icon="plus" onClick={goBuild}>Go and write one</Button>
          </div>}
    </div>

    <div className="card">
      <h2 style={{ margin: 0 }}>Their week</h2>
      <div className="adm-lead">{trainingDays(plan.week)} training day{trainingDays(plan.week) === 1 ? '' : 's'} a week. Tap a day to set what they do on it.</div>
      <div className="list" style={{ display: 'flex', flexDirection: 'column' }}>
        {weekOrder(weekStart).map(d => {
          const on = [].concat(plan.week[d] || []).map(x => byId.get(x)).filter(Boolean)
          return <div key={d} className="item" onClick={() => openSheet(close =>
            <PickDay routines={plan.routines} chosen={plan.week[d]} onSet={ids => setDay(d, ids)} close={close} />)}>
            <div className="grow">
              <div className="tt">{DAYN[d]}</div>
              {!!on.length && <div className="ss">{on.map(r => r.name).join(' · ')}</div>}
            </div>
            {on.length ? <span className="adm-pill acc">{routineCount(on.length)}</span> : <span className="tag">Rest</span>}
            <Icon name="chevronRight" className="chev" />
          </div>
        })}
      </div>
    </div>

    {/* The one place the coach gets to say something in their own words that sits with the
        plan rather than in a chat. It shows at the top of the client's Plan screen. */}
    <div className="card">
      <h2 style={{ margin: 0 }}>A note with it</h2>
      <div className="adm-lead">Shown at the top of their Plan screen. Why this block, what to watch for, when you will look at it again.</div>
      <textarea className="input" rows={4} maxLength={500} placeholder="Four weeks of this, then we reassess…"
        value={plan.note} onChange={e => { const v = e.target.value; setPlan(p => ({ ...p, note: v })); setDirty(true) }} />
    </div>

    <div style={{ position: 'sticky', bottom: 12, paddingTop: 4 }}>
      <Button variant="primary" disabled={busy || !dirty} onClick={save}>
        {dirty ? 'Publish to ' + name : 'Published'}
      </Button>
      <div className="adm-hint">They see it the next time their app syncs, which is within seconds if it is open.</div>
    </div>
  </div>
}
