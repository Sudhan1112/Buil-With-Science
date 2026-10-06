// The coach's programme, as the client sees it: the week, and the routines in it.
//
// Read-only on purpose, and not only as a matter of taste. `routines` and `week` live in a
// server document (plan-<uid>.json) that only the coach can write; `PUT /api/data` drops both
// keys off anything a client pushes. So every control this screen used to have — new routine,
// delete, reorder, assign a day, load a starter plan — would have edited the local copy, looked
// like it worked, and been silently reverted by the next pull. Asking the coach is the way to
// change any of it, which is what the request card on Home is for.
//
// `dayPlan` is the one exception and stays the client's: moving *today's* session to tomorrow
// because the gym was shut is rescheduling, not programming, and the server keeps it in the
// synced document.
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { DAYN, weekOrder, weekStartOf, exCount, routineCount } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import { planRequestSheet } from '../components/CoachCard.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { tappable } from '../lib/use-sheet-keyboard.js'
import { glyphOf } from '../lib/glyphs.js'
import { fmtWhen } from '../lib/audit.js'

export default function Plan() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const plan = useStore(s => s.plan)
  const account = useStore(s => s.account)

  if (!S.routines.length) return <>
    <div className="hdr"><div><h1>{t('Plan')}</h1><div className="sub">{t('Written by your coach')}</div></div></div>
    <div className="empty"><div className="ico"><Icon name="clipboard" /></div>
      {account?.request ? t('Your coach is writing your programme.') : t('You do not have a programme yet.')}<br />
      {t('It appears here the moment they publish it.')}
    </div>
    <Button variant="primary" icon={account?.request ? 'pencil' : 'rocket'} onClick={() => planRequestSheet(account?.request || null)}>
      {account?.request ? t('Change what you asked for') : t('Ask for my plan')}
    </Button>
  </>

  return <>
    <div className="hdr">
      <div><h1>{t('Plan')}</h1><div className="sub">
        {plan?.updatedAt ? t('Updated by your coach {0}', fmtWhen(Date.parse(plan.updatedAt))) : t('Written by your coach')}
      </div></div>
      <button className="iconbtn" onClick={() => planRequestSheet(account?.request || null)}
        aria-label={t('Ask your coach for a change')} title={t('Ask your coach for a change')}><Icon name="envelope" /></button>
    </div>

    {/* Whatever the coach wanted said about this block, in their words. */}
    {!!plan?.note && <div className="card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 9, marginBottom: 6 }}>
        <span className="lrow-i" style={{ background: 'var(--indigo)' }}><Icon name="envelope" /></span>
        <div className="lbl2">{t('From your coach')}</div>
      </div>
      <div className="muted small" style={{ lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{plan.note}</div>
    </div>}

    <div className="cols"><div>
      <h4 className="sec">{t('Week schedule')}</h4>
      <div className="list" style={{ display: 'flex', flexDirection: 'column' }}>
        {weekOrder(weekStartOf(S)).map(d => {
          const dayRoutines = [].concat(S.week[d] || []).map(id => S.routines.find(x => x.id === id)).filter(Boolean)
          if (!dayRoutines.length) return <div key={d} className="item">
            <div className="grow"><div className="tt">{t(DAYN[d])}</div></div>
            <span className="tag">{t('Rest')}</span>
          </div>
          return <div key={d} className="item" style={{ display: 'block', padding: '10px 14px' }}>
            <div className="row between" style={{ marginBottom: 6 }}>
              <div className="tt">{t(DAYN[d])}</div>
              <div className="small dim">{routineCount(dayRoutines.length)}</div>
            </div>
            {dayRoutines.map(r => <div key={r.id} className="row tappable" style={{ gap: 8, padding: '4px 0 4px 8px', cursor: 'pointer' }}
              {...tappable(() => nav('/plan/r/' + r.id))}>
              <span className="lrow-i" style={{ width: 26, height: 26, fontSize: 14 }}><Icon name={glyphOf(r.emoji)} /></span>
              <div className="grow" style={{ minWidth: 0 }}><div className="tt" style={{ fontSize: 14 }}>{r.name}</div><div className="ss">{exCount(r.ex.length)}</div></div>
              <Icon name="chevronRight" className="chev" />
            </div>)}
          </div>
        })}
      </div>
    </div><div>
      <h4 className="sec" style={{ marginTop: 22 }}>{t('Routines')}</h4>
      <div className="list">{S.routines.map(r => <div key={r.id} className="item" {...tappable(() => nav('/plan/r/' + r.id))}>
        <span className="lrow-i"><Icon name={glyphOf(r.emoji)} /></span>
        <div className="grow"><div className="tt">{r.name}</div><div className="ss">{exCount(r.ex.length)}</div></div>
        <Icon name="chevronRight" className="chev" />
      </div>)}</div>
      <div className="dim small" style={{ margin: '12px 2px', lineHeight: 1.5 }}>
        {t('Your coach writes and updates this. Ask them for a change and it lands on their desk.')}
      </div>
    </div></div>
  </>
}
