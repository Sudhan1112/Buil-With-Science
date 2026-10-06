// What a client sees instead of the app while their subscription is not active.
//
// The gate is a *view*, not a security boundary: the API refuses every data route with 402 on
// its own (requireActiveSub), so a client who bypassed this screen would find nothing behind it.
// What this is for is telling them where they are in a process that is deliberately manual —
// they pay, the coach confirms the payment by hand and activates the account, and in between
// the coach needs the intake answers to have something to write a plan from.
//
// Three states, from `account.sub.status`:
//   pending  nothing confirmed yet — the QR to pay, then the intake form, then "it's being made"
//   expired  the month ran out — the same QR, and the promise that the data is all still here
//   active   not this screen's business; App.jsx renders the app
import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { fmtDate, isoOf } from '../lib/format.js'
import { GOALS, EXPERIENCE, goalLabel } from '../lib/goals.js'

const wrap = { display: 'flex', flexDirection: 'column', minHeight: '72vh', justifyContent: 'center', textAlign: 'center' }

function Head({ icon, title, sub }) {
  return <>
    <div style={{ fontSize: 48, display: 'flex', justifyContent: 'center', color: 'var(--acc)' }}><Icon name={icon} /></div>
    <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-.028em', margin: '10px 0 6px' }}>{title}</h1>
    {sub && <div className="muted" style={{ marginBottom: 22, lineHeight: 1.5 }}>{sub}</div>}
  </>
}

/* The coach's payment QR, served as a static file so that swapping it is dropping a new image
   into web/ — no rebuild, no code change. Until one is there the box says so in plain words
   rather than showing a decorative square that someone would try to scan. */
function PaymentQR() {
  const [missing, setMissing] = useState(false)
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {missing ? (
        <div className="dim small" style={{ width: 200, height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '2px dashed var(--sep)', borderRadius: 14, padding: 16, lineHeight: 1.5 }}>
          {t('Your coach has not added a payment code yet — message them for the details.')}
        </div>
      ) : (
        <img src="/payment-qr.png" alt={t('Payment QR code')} width={200} height={200}
          style={{ borderRadius: 14, background: '#fff', objectFit: 'contain' }} onError={() => setMissing(true)} />
      )}
      <div className="dim small" style={{ marginTop: 12, lineHeight: 1.5 }}>
        {t('Scan to pay for this month. Your coach confirms the payment by hand and opens your dashboard.')}
      </div>
    </div>
  )
}

/* Everything the coach needs before they can write anything: the goal (the only required
   answer — the API refuses an intake without one), and the context that decides what the first
   block looks like. Submitting also opens the plan request, so the coach gets one card on their
   desk rather than a form and a separate "please make me a plan". */
function IntakeForm({ intake, onDone }) {
  const [goal, setGoal] = useState(intake?.goal || '')
  const [goalDetail, setGoalDetail] = useState(intake?.goalDetail || '')
  const [experience, setExperience] = useState(intake?.experience || 'beginner')
  const [heightCm, setHeightCm] = useState(intake?.heightCm ?? '')
  const [weightKg, setWeightKg] = useState(intake?.weightKg ?? '')
  const [daysPerWeek, setDaysPerWeek] = useState(intake?.daysPerWeek ?? 3)
  const [injuries, setInjuries] = useState(intake?.injuries || '')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!goal) { useUI.getState().toast(t('Pick what you want to work towards')); return }
    setBusy(true)
    try {
      // Numbers are optional: an empty field goes as null rather than 0, which the API would
      // read as a real (and impossible) measurement and refuse.
      const n = v => (String(v).trim() === '' ? null : Number(v))
      await api('/api/intake', { method: 'POST', body: JSON.stringify({
        goal, goalDetail, experience, injuries,
        heightCm: n(heightCm), weightKg: n(weightKg), daysPerWeek: n(daysPerWeek),
      }) })
      await api('/api/plan-request', { method: 'POST', body: JSON.stringify({ kind: 'new', goal, message: goalDetail }) })
      await onDone()
      useUI.getState().toast(t('Sent to your coach'))
    } catch (e) { useUI.getState().toast(e.message || t('Could not send that — try again')) }
    finally { setBusy(false) }
  }

  const num = (label, value, set, props) => (
    <label style={{ flex: 1, textAlign: 'start' }}>
      <div className="dim small" style={{ marginBottom: 4 }}>{label}</div>
      <input className="input" inputMode="decimal" value={value} onChange={e => set(e.target.value)} {...props} />
    </label>
  )

  return (
    <div className="card" style={{ textAlign: 'start', padding: 18 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('What are you working towards?')}</div>
      <div className="dim small" style={{ marginBottom: 12 }}>{t('Your coach writes your plan from this.')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {GOALS.map(g => (
          <button key={g.value} type="button" className={'btn' + (goal === g.value ? ' primary' : '')}
            style={{ justifyContent: 'flex-start' }} onClick={() => setGoal(g.value)}>
            <Icon name={g.icon} /> <span style={{ marginInlineStart: 8 }}>{g.label()}</span>
          </button>
        ))}
      </div>

      <div style={{ height: 16 }} />
      <div className="dim small" style={{ marginBottom: 4 }}>{t('Anything your coach should know about that goal')}</div>
      <textarea className="input" rows={3} maxLength={300} value={goalDetail} onChange={e => setGoalDetail(e.target.value)}
        placeholder={t('e.g. a wedding in June, back to lifting after a long break…')} />

      <div style={{ height: 16 }} />
      <div className="dim small" style={{ marginBottom: 4 }}>{t('How much have you trained?')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {EXPERIENCE.map(x => (
          <button key={x.value} type="button" className={'btn' + (experience === x.value ? ' primary' : '')}
            style={{ justifyContent: 'flex-start' }} onClick={() => setExperience(x.value)}>{x.label()}</button>
        ))}
      </div>

      <div style={{ height: 16 }} />
      <div style={{ display: 'flex', gap: 10 }}>
        {num(t('Height (cm)'), heightCm, setHeightCm, { placeholder: '175', maxLength: 5 })}
        {num(t('Weight (kg)'), weightKg, setWeightKg, { placeholder: '72', maxLength: 5 })}
        {num(t('Days/week'), daysPerWeek, setDaysPerWeek, { placeholder: '3', maxLength: 1 })}
      </div>

      <div style={{ height: 16 }} />
      <div className="dim small" style={{ marginBottom: 4 }}>{t('Injuries, pain or anything to train around')}</div>
      <textarea className="input" rows={3} maxLength={1000} value={injuries} onChange={e => setInjuries(e.target.value)}
        placeholder={t('Leave empty if there is nothing')} />

      <div style={{ height: 18 }} />
      <Button variant="primary" icon="rocket" disabled={busy} onClick={save}>
        {busy ? t('Sending…') : intake ? t('Update my answers') : t('Send to my coach')}
      </Button>
    </div>
  )
}

export default function Gate() {
  const account = useStore(s => s.account)
  const user = useStore(s => s.user)
  const refreshAccount = useStore(s => s.refreshAccount)
  const signOut = useStore(s => s.signOut)
  const [editing, setEditing] = useState(false)
  const status = account?.sub?.status || 'pending'
  const intake = account?.intake || null
  // The intake is in and the coach has not activated the account yet: there is nothing left for
  // the client to do, so the screen stops asking and starts reassuring.
  const waiting = status === 'pending' && !!intake && !editing

  const footer = (
    <div className="dim small" style={{ marginTop: 26, lineHeight: 1.6 }}>
      {t('Signed in as {0}.', user?.name || '')}{' '}
      <a href="#" onClick={e => { e.preventDefault(); signOut() }}>{t('Sign out')}</a>
    </div>
  )

  if (status === 'expired') return (
    <div className="narrow" style={wrap}>
      <Head icon="clock" title={t('Your month has ended')}
        sub={t('Everything you have logged is still here, exactly as you left it. Renew and your dashboard opens again on the same data.')} />
      <PaymentQR />
      {account?.sub?.paidUntil && <div className="dim small" style={{ marginTop: 14 }}>
        {t('Your last month ran to {0}.', fmtDate(isoOf(new Date(account.sub.paidUntil)), false, true))}
      </div>}
      <div style={{ height: 14 }} />
      <Button icon="reset" onClick={refreshAccount}>{t('I have paid — check again')}</Button>
      {footer}
    </div>
  )

  if (waiting) return (
    <div className="narrow" style={wrap}>
      <Head icon="flame" title={t('Your plan is being made')}
        sub={t('Your coach has your goals and is putting your programme together. As soon as your payment is confirmed, your dashboard opens here.')} />
      <div className="card" style={{ textAlign: 'start', padding: 18 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>{t('What your coach has')}</div>
        <div className="dim small" style={{ lineHeight: 1.7 }}>
          {goalLabel(intake.goal)}
          {intake.daysPerWeek ? ' · ' + t('{0} days a week', intake.daysPerWeek) : ''}
          {intake.weightKg ? ' · ' + t('{0} kg', intake.weightKg) : ''}
        </div>
      </div>
      <div style={{ height: 14 }} />
      <Button icon="pencil" onClick={() => setEditing(true)}>{t('Change my answers')}</Button>
      <div style={{ height: 10 }} />
      <Button icon="reset" onClick={refreshAccount}>{t('Check again')}</Button>
      {footer}
    </div>
  )

  return (
    <div className="narrow" style={wrap}>
      <Head icon="sparkles" title={t('Welcome to CareFit')}
        sub={t('Two things and you are in: pay for your first month, and tell your coach what you want. They write your plan by hand from your answers.')} />
      <PaymentQR />
      <div style={{ height: 14 }} />
      <IntakeForm intake={intake} onDone={async () => { setEditing(false); await refreshAccount() }} />
      <div style={{ height: 14 }} />
      <Button icon="reset" onClick={refreshAccount}>{t('I have paid — check again')}</Button>
      {footer}
    </div>
  )
}
