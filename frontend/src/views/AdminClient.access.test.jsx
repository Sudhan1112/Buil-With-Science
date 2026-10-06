// @vitest-environment happy-dom
// The two levers that decide whether a client can open the app at all: recording a payment and
// releasing the device lock. What goes on the wire is pinned here rather than left to a
// click-through, because getting either wrong locks a paying customer out.
//
// Split from AdminClient.test.jsx rather than added to it: a sixth mount in one file stopped
// running its effect under happy-dom, and a component that never fetched looks exactly like a
// component that rendered nothing.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminClient from './AdminClient.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ detail: null, calls: [], confirm: vi.fn(), nav: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  api: (path, init) => {
    mocks.calls.push([path.split('?')[0], init ? JSON.parse(init.body) : null])
    if (path.startsWith('/api/admin/user?')) return Promise.resolve(mocks.detail)
    return Promise.resolve({ ok: true })
  }
}))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: { id: 'adm', name: 'Coach', admin: true }, S: { routines: [] } })
  const useStore = selector => (selector ? selector(snap()) : snap())
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: () => {}, openSheet: () => {} })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.nav }))
vi.mock('../sheets.jsx', () => ({ confirmSheet: mocks.confirm }))

const detail = over => ({
  user: { id: 'u1', name: 'Bo', created: '2026-09-01T00:00:00Z', disabled: false, admin: false },
  sub: { status: 'pending', paidUntil: null, activatedAt: null, note: '' },
  intake: null, request: null, device: null,
  plan: { routines: [], week: {}, _rev: 0, updatedAt: null, note: '' },
  adherence: { d7: null, d28: null, perWeek: 0 },
  unit: 'kg', lastSync: null, routines: [], bodyweight: [], workouts: [],
  ...over
})

let live = null
async function render(el) {
  if (live) { await act(async () => live.unmount()); live = null }
  document.body.innerHTML = ''
  const host = document.createElement('div')
  document.body.appendChild(host)
  live = createRoot(host)
  await act(async () => { live.render(el) })
  return host
}
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const open = async over => {
  mocks.detail = detail(over)
  const host = await render(<AdminClient id="u1" onChanged={() => {}} close={() => {}} />)
  await settle()
  return host
}
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text))
const sent = path => mocks.calls.filter(([p]) => p === path).map(([, body]) => body)

beforeEach(() => {
  mocks.calls.length = 0
  mocks.confirm.mockClear()
  mocks.nav.mockClear()
})
afterEach(async () => {
  if (live) { await act(async () => live.unmount()); live = null }
  document.body.innerHTML = ''
})

describe('opening and closing a client’s access', () => {
  // The first payment and a renewal are the same call with a different action, and the wording
  // has to match which one it is — "extend" on an account that has never paid reads as a bug.
  it('records a first payment as activate, and a renewal as extend', async () => {
    let host = await open()
    act(() => button(host, 'Record payment & open access').click())
    expect(sent('/api/admin/user/subscription')[0]).toEqual({ id: 'u1', action: 'activate', months: 1, note: '' })

    mocks.calls.length = 0
    host = await open({ sub: { status: 'active', paidUntil: Date.now() + 20 * 86400000, note: '' } })
    act(() => button(host, 'Record payment & extend').click())
    expect(sent('/api/admin/user/subscription')[0].action).toBe('extend')
  })

  it('does not end access without a confirmation', async () => {
    const host = await open({ sub: { status: 'active', paidUntil: Date.now() + 86400000, note: '' } })
    act(() => button(host, 'End access now').click())
    expect(sent('/api/admin/user/subscription')).toHaveLength(0)
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    act(() => mocks.confirm.mock.calls[0][0].onConfirm())
    expect(sent('/api/admin/user/subscription')[0].action).toBe('expire')
  })

  // An account that predates subscriptions is not gated, and offering to "extend" nothing
  // would be a lie about what the button does.
  it('says a legacy account is not gated, and offers to start one', async () => {
    const host = await open({ sub: { status: 'active', paidUntil: null, note: '', legacy: true } })
    expect(host.textContent).toContain('predates subscriptions')
    expect(button(host, 'Record payment & open access')).toBeTruthy()
    expect(button(host, 'End access now')).toBeUndefined()
  })

  it('names the bound device and releases it behind a confirmation', async () => {
    const host = await open({ device: { label: 'Bo’s iPhone', boundAt: '2026-09-02T10:00:00Z' } })
    expect(host.textContent).toContain('Bo’s iPhone')
    act(() => button(host, 'Release the device lock').click())
    expect(sent('/api/admin/user/device/release')).toHaveLength(0)
    act(() => mocks.confirm.mock.calls[0][0].onConfirm())
    expect(sent('/api/admin/user/device/release')[0]).toEqual({ id: 'u1' })
  })
})
