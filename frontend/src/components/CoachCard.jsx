// Home's top card once someone is through the gate: their goal, and the state of whatever they
// have asked their coach for.
//
// This is the only way a client influences their programme. They cannot write routines — the
// plan is a server document only the coach can write (api/server.js, plan-<uid>.json) — so what
// replaces the old "build your own plan" card is a way to *ask*. Three states:
//
//   no plan assigned yet    "your coach is writing it", with the goal they gave at intake
//   plan assigned, no ask   the goal, and a button to request a change
//   a request is open       what they asked for and when, so a second tap edits it rather than
//                           piling another card onto the coach's desk
import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { fmtWhen } from '../lib/audit.js'
import { GOALS, goalLabel } from '../lib/goals.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

/* Asking for a change: the goal (prefilled from intake, because changing it here is exactly the
   kind of thing worth asking about) and what they want different. POST /api/plan-request edits
   the open request when there is one, so this sheet is both "ask" and "change what I asked". */
export function planRequestSheet(open) {
  useUI.getState().openSheet(close => <RequestSheet close={close} open={open} />)
}

function RequestSheet({ close, open }) {
  const account = useStore(s => s.account)
  const refreshAccount = useStore(s => s.refreshAccount)
  const [goal, setGoal] = useState(open?.goal || account?.intake?.goal || '')
  const [message, setMessage] = useState(open?.message || '')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    if (!goal) { useUI.getState().toast(t('Pick what you want to work towards')); return }
    setBusy(true)
    try {
      await api('/api/plan-request', { method: 'POST', body: JSON.stringify({ kind: open ? 'change' : 'new', goal, message }) })
      await refreshAccount()
      close()
      useUI.getState().toast(t('Sent to your coach'))
    } catch (e) { useUI.getState().toast(e.message || t('Could not send that — try again')) }
    finally { setBusy(false) }
  }
  return <>
    <h3>{open ? t('Change what you asked for') : t('Ask your coach for a plan')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {t('Your coach writes and updates your programme by hand. Tell them what you want and it lands on their desk.')}
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {GOALS.map(g => (
        <button key={g.value} type="button" className={'btn' + (goal === g.value ? ' primary' : '')}
          style={{ justifyContent: 'flex-start' }} onClick={() => setGoal(g.value)}>
          <Icon name={g.icon} /> <span style={{ marginInlineStart: 8 }}>{g.label()}</span>
        </button>
      ))}
    </div>
    <div style={{ height: 14 }} />
    <textarea className="input" rows={4} maxLength={1000} value={message} onChange={e => setMessage(e.target.value)}
      placeholder={t('e.g. my knee hurts on squats, or I can only train three days from next month')} />
    <div style={{ height: 14 }} />
    <Button variant="primary" icon="rocket" disabled={busy} onClick={send}>{busy ? t('Sending…') : t('Send to my coach')}</Button>
  </>
}

export default function CoachCard() {
  const S = useStore(s => s.S)
  const account = useStore(s => s.account)
  const plan = useStore(s => s.plan)
  const open = account?.request || null
  const hasPlan = S.routines.length > 0 || !!plan?.published

  // Nothing assigned and nothing asked: the first thing this screen should say. Clients arrive
  // here straight off the gate, where they already gave their goal, so the ask is one tap.
  if (!hasPlan) return (
    <div className="card">
      <div className="row" style={{ gap: 10, marginBottom: 6 }}>
        <span className="lrow-i" style={{ background: 'var(--orange)' }}><Icon name="flame" /></span>
        <div className="big" style={{ fontSize: 22 }}>{open ? t('Your plan is being made') : t('No plan yet')}</div>
      </div>
      <div className="muted small" style={{ marginBottom: 12, lineHeight: 1.5 }}>
        {open
          ? t('Your coach has your request and is putting your programme together. It appears here the moment they publish it.')
          : t('Your coach writes your programme by hand. Tell them what you want and it lands on their desk.')}
      </div>
      <div className="dim small" style={{ marginBottom: 12 }}>
        {t('Goal')}: {goalLabel(open?.goal || account?.intake?.goal)}
        {open?.created ? ' · ' + t('asked {0}', fmtWhen(Date.parse(open.updated || open.created))) : ''}
      </div>
      <Button variant={open ? 'plain' : 'primary'} icon={open ? 'pencil' : 'rocket'} onClick={() => planRequestSheet(open)}>
        {open ? t('Change what you asked for') : t('Ask for my plan')}
      </Button>
    </div>
  )

  // A plan is in place. The card shrinks to the goal it is written against and the way to ask
  // for something different — the plan itself is the Plan tab's job, not this card's.
  return (
    <div className="card">
      <div className="row between">
        <div style={{ minWidth: 0 }}>
          <div className="lbl2">{t('Your goal')}</div>
          <div className="ttl">{goalLabel(account?.intake?.goal)}</div>
          <div className="dim small" style={{ marginTop: 2 }}>
            {open
              ? t('Your coach is looking at your request.')
              : plan?.updatedAt
                ? t('Plan last updated {0}', fmtWhen(Date.parse(plan.updatedAt)))
                : t('Written for you by your coach.')}
          </div>
        </div>
        <Button size="sm" icon={open ? 'pencil' : 'envelope'} onClick={() => planRequestSheet(open)}>
          {open ? t('Edit') : t('Ask')}
        </Button>
      </div>
      {!!plan?.note && <div className="muted small" style={{ marginTop: 10, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{plan.note}</div>}
    </div>
  )
}
