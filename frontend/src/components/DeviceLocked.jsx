// The popup a second device gets.
//
// One subscription is one person, and the server enforces that by binding an account to the
// first device that signs into it (`claimDevice` in api/server.js). Every later sign-in from
// anywhere else is a 409 `device_locked`, and this is what that looks like.
//
// It is a sheet rather than a toast on purpose. A toast is for something you can shrug off;
// this is a dead end — nothing on this device will work until the coach releases the binding —
// and it has to say so clearly enough that the person reads it instead of tapping Sign in
// again. It also names the device that holds the account, so somebody who simply got a new
// phone can tell that from somebody using a friend's login.
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtWhen } from '../lib/audit.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

function DeviceLocked({ close, boundLabel, boundAt }) {
  return <>
    <div style={{ fontSize: 40, display: 'flex', justifyContent: 'center', color: 'var(--red)' }}><Icon name="lock" /></div>
    <h3 style={{ textAlign: 'center' }}>{t('Already signed in on another device')}</h3>
    <div className="muted small" style={{ marginBottom: 14, lineHeight: 1.6, textAlign: 'center' }}>
      {t('Your subscription is for one device. This account is already in use on another one, so it cannot be opened here.')}
    </div>
    {(boundLabel || boundAt) && <div className="card" style={{ textAlign: 'start', marginBottom: 14 }}>
      <div className="muted small">{t('In use on')}</div>
      <div style={{ fontWeight: 600 }}>{boundLabel || t('Another device')}</div>
      {boundAt && <div className="dim small" style={{ marginTop: 2 }}>{t('since {0}', fmtWhen(Date.parse(boundAt)))}</div>}
    </div>}
    <div className="dim small" style={{ marginBottom: 16, lineHeight: 1.6 }}>
      {t('Changed phone, or reinstalled? Ask your coach to release the old device and then sign in again here.')}
    </div>
    <Button variant="primary" onClick={close}>{t('Got it')}</Button>
  </>
}

/** True when `e` is the server refusing a second device — see POST /api/login/*. */
export const isDeviceLocked = e => e?.status === 409 && e?.data?.error === 'device_locked'

/**
 * Report a failed sign-in. The device lock gets the sheet above; everything else gets the
 * toast it always got. Cancelling a passkey prompt (NotAllowedError/AbortError) is not a
 * failure at all — the person changed their mind — and says nothing.
 *
 * Every sign-in path in the app funnels through here so there is one answer to "what happens
 * when a second device tries", rather than four catch blocks that each half-remember it.
 */
export function reportSignInError(e, fallback) {
  if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') return
  if (isDeviceLocked(e)) {
    useUI.getState().openSheet(close =>
      <DeviceLocked close={close} boundLabel={e.data.boundLabel} boundAt={e.data.boundAt} />)
    return
  }
  useUI.getState().toast(e?.message || fallback || t('Sign-in failed'))
}
