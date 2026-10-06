// One routine of the coach's plan, read-only.
//
// This is what /plan/r/:id renders for a client. The editing screen it replaces (RoutineEdit)
// still exists and is still the real thing — the coach uses it from the admin portal — but a
// client has nothing to edit here: the plan is a server document that `PUT /api/data` refuses
// to carry, so every control that wrote to `S.routines` would have been a button that looked
// like it worked and silently didn't.
//
// What a client *can* do is everything that reads: see the exercises in order, what is
// supersetted with what, the sets and reps prescribed, how to do each one (the detail sheet
// with its instructions and media) and what they have lifted on it before.
import { useParams, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { exOr } from '../lib/exercises.js'
import { t, exerciseNameFor, exerciseNameClass } from '../lib/i18n.js'
import { exLine } from '../lib/history.js'
import { speedUnitOf } from '../lib/speed.js'
import { exCount } from '../lib/format.js'
import { glyphOf } from '../lib/glyphs.js'
import { loadOfRoutine, rankOf, MUSCLE_NAME } from '../lib/muscles.js'
import { exerciseDetailSheet, startFlow } from '../sheets.jsx'
import { Thumb } from '../components/Media.jsx'
import BodyMap from '../components/BodyMap.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { tappable } from '../lib/use-sheet-keyboard.js'

export default function RoutineView() {
  const { id } = useParams()
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const r = S.routines.find(x => x.id === id)

  // A routine the coach removed while this screen was open, or a stale deep link from a
  // notification. Saying so beats a blank screen or a crash on `r.ex`.
  if (!r) return <>
    <div className="hdr"><div><h1>{t('Routine')}</h1></div></div>
    <div className="empty"><div className="ico"><Icon name="clipboard" /></div>{t('This routine is no longer part of your plan.')}</div>
    <Button icon="chevronLeft" onClick={() => nav('/plan')}>{t('Back to my plan')}</Button>
  </>

  // Which rows are supersetted with the one above: `sg` is the group id the plan carries, and
  // two neighbours sharing one are done back to back.
  const linkedPrev = i => i > 0 && !!r.ex[i].sg && r.ex[i - 1].sg === r.ex[i].sg

  return <>
    <div className="hdr">
      <div className="row" style={{ gap: 10, minWidth: 0 }}>
        <span className="lrow-i"><Icon name={glyphOf(r.emoji)} /></span>
        <div style={{ minWidth: 0 }}><h1 style={{ margin: 0 }}>{r.name}</h1><div className="sub">{exCount(r.ex.length)}</div></div>
      </div>
      <button className="iconbtn" onClick={() => nav('/plan')} aria-label={t('Back to my plan')}><Icon name="chevronLeft" /></button>
    </div>

    {r.ex.length ? <div className="list">{r.ex.map((e, i) => {
      const ex = exOr(e.id)
      return <div key={i}>
        {linkedPrev(i) && <div className="ss-label"><Icon name="link" />{t('Superset')}</div>}
        <div className="item" {...tappable(() => exerciseDetailSheet(ex))}>
          <Thumb ex={ex} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className={`tt ${exerciseNameClass(ex)}`}>{exerciseNameFor(ex)}</div>
            <div className="ss">{exLine(e, S.unit, speedUnitOf(S))}</div>
            {/* The coach's note on this exercise — why it is here, how to run it. */}
            {e.note && <div className="small dim" style={{ marginTop: 2 }}>{e.note}</div>}
          </div>
          <Icon name="chevronRight" className="chev" />
        </div>
      </div>
    })}</div> : <div className="empty"><div className="ico"><Icon name="dumbbell" /></div>{t('Your coach has not put any exercises in this one yet.')}</div>}

    {r.ex.length > 0 && (() => {
      const { worked } = rankOf(loadOfRoutine(r))
      return <div className="card" style={{ marginTop: 12 }}>
        <h2>{t('What this session hits')}</h2>
        <BodyMap load={loadOfRoutine(r)} body={S.body} />
        <div className="mchips">{worked.slice(0, 6).map(m => <span key={m} className="mchip">{t(MUSCLE_NAME[m])}</span>)}</div>
      </div>
    })()}

    {r.ex.length > 0 && <>
      <div style={{ height: 12 }} />
      <Button variant="primary" icon="play" onClick={() => startFlow([r.id])}>{t('Start this session')}</Button>
    </>}
  </>
}
