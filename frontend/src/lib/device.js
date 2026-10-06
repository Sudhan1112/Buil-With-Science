// A stable id for this installation, sent with every sign-in so the server can hold an account
// to one device (`claimDevice` in api/server.js).
//
// What this is and is not: it is a random number this browser remembers, not a fingerprint. It
// identifies the *install*, so clearing site data or reinstalling from the home screen looks
// like a new device and needs the coach to release the binding — which is the right trade. A
// fingerprint would survive that, and would also follow the person around; this does neither.
//
// The id is not a secret and gives nothing away on its own: the session cookie is what
// authenticates, and the server only ever compares this against the one it bound.
const KEY = 'carefit_device_v1'

// base64url of 16 random bytes, which matches the server's /^[A-Za-z0-9_-]{8,64}$/.
function mint() {
  const b = new Uint8Array(16)
  ;(globalThis.crypto || {}).getRandomValues?.(b)
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * This device's id, minted on first use and kept from then on.
 *
 * A browser that refuses storage (private mode with everything blocked) gets a fresh id each
 * call. That is deliberate: the alternative is to fail the sign-in outright, and locking
 * someone out of the app they are paying for because their browser will not keep a cookie-sized
 * string is the worse of the two failures. The server still binds the first one it is given.
 */
export function deviceId() {
  try {
    const got = localStorage.getItem(KEY)
    if (got) return got
    const made = mint()
    localStorage.setItem(KEY, made)
    return made
  } catch { return mint() }
}
