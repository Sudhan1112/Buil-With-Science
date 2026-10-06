// What a client sees on a desktop browser.
//
// CareFit is two apps in one build: the coach works from a desk as much as from a phone, so the
// admin portal is deliberately usable at any width. A client's side is not — it is laid out for
// a phone, used in a gym, between sets, and the whole point of the product is that it lives on
// the home screen rather than in a tab somebody forgets.
//
// So rather than let a client open a stretched, half-broken dashboard on a laptop, we say what
// to do instead. This is a nudge, not a security boundary: every route behind it is still
// guarded on the server. Someone determined can resize the window and get in, and that is fine
// — the person this screen is for is confused, not hostile.
import { useEffect, useState } from 'react'
import { t } from '../lib/i18n.js'
import Icon from '../components/Icon.jsx'

// Roughly "wider than a phone in landscape". Deliberately generous: a narrow desktop window
// gets the app, which is the harmless way to be wrong.
const DESKTOP = '(min-width: 950px)'

/** True while the viewport is desktop-sized. Follows resizes, so rotating or snapping a window
 *  moves between the two without a reload. */
export function useDesktop() {
  const [wide, setWide] = useState(() => !!window.matchMedia?.(DESKTOP).matches)
  useEffect(() => {
    const mql = window.matchMedia?.(DESKTOP)
    if (!mql) return
    const onChange = () => setWide(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return wide
}

const step = (n, text) => <div key={n} style={{ display: 'flex', gap: 12, alignItems: 'baseline', marginBottom: 10 }}>
  <div style={{
    flex: '0 0 22px', height: 22, borderRadius: 11, background: 'var(--fill-2)', color: 'var(--label-2)',
    fontSize: 12, fontWeight: 700, display: 'grid', placeItems: 'center'
  }}>{n}</div>
  <div style={{ lineHeight: 1.5 }}>{text}</div>
</div>

export default function PhoneOnly() {
  return <div className="narrow" style={{ paddingTop: '14vh', textAlign: 'center' }}>
    <div style={{ fontSize: 52, display: 'flex', justifyContent: 'center', color: 'var(--acc)' }}><Icon name="phone" /></div>
    <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-.024em', margin: '12px 0 6px' }}>{t('CareFit lives on your phone')}</h1>
    <div className="muted" style={{ marginBottom: 26, lineHeight: 1.6 }}>
      {t('Your plan, your sessions and the community are built for the gym floor. Open this same address on your phone and add it to your home screen.')}
    </div>
    <div className="card" style={{ textAlign: 'start' }}>
      <div className="small" style={{ fontWeight: 600, marginBottom: 12 }}>{t('On your phone')}</div>
      {[
        step(1, t('Open this address in Safari (iPhone) or Chrome (Android).')),
        step(2, t('Tap Share, then “Add to Home Screen”.')),
        step(3, t('Open CareFit from the new icon and sign in there.'))
      ]}
    </div>
    <div className="dim small" style={{ marginTop: 18, lineHeight: 1.6 }}>
      {t('Signing in on your phone counts as your one device — so do that before signing in anywhere else.')}
    </div>
  </div>
}
