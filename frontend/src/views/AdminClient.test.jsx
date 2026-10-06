// @vitest-environment happy-dom
// The coaching sheet: what the coach sees about one client, and the two things they do from
// here that are about the coaching rather than the account — answering a request and going off
// to write the plan. Payments and the device lock are in AdminClient.access.test.jsx.
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
  intake: { goal: 'build_muscle', experience: 'beginner', days: 4, injuries: 'left shoulder' },
  request: null, device: null,
  plan: { routines: [], week: {}, _rev: 0, updatedAt: null, note: '' },
  adherence: { d7: null, d28: null, perWeek: 0 },
  unit: 'kg', lastSync: null, routines: [], bodyweight: [], workouts: [],
  ...over
})

// One live root at a time, mounted inside an async act(). The synchronous form —
// act(() => root.render(…)) — stopped flushing the mount effect part-way through this file,
// and a component whose effect never ran renders an empty host, which reads as "it rendered
// nothing" rather than "it never got as far as fetching".
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

describe('the coaching sheet', () => {
  it('shows what they asked for, and says they are waiting on a plan', async () => {
    const host = await open()
    expect(host.textContent).toContain('Build muscle')
    expect(host.textContent).toContain('New to training')
    expect(host.textContent).toContain('left shoulder')
    expect(host.textContent).toContain('No plan yet')
    expect(button(host, 'Write their plan')).toBeTruthy()
  })

  it('resolves an open request with the note the coach typed', async () => {
    const host = await open({ request: { id: 'rq1', status: 'open', note: 'Knee is better', created: '2026-09-20T09:00:00Z' } })
    expect(host.textContent).toContain('Knee is better')
    const input = [...host.querySelectorAll('input')].find(i => i.placeholder?.startsWith('Reply'))
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'swapped the squat')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => button(host, 'Mark done').click())
    expect(sent('/api/admin/requests/resolve')[0]).toEqual({ id: 'rq1', status: 'done', adminNote: 'swapped the squat' })
  })

  it('leaves for the plan editor rather than editing in the sheet', async () => {
    const host = await open({ plan: { routines: [{ id: 'r1', name: 'Upper', ex: [] }], week: { 1: ['r1'] }, _rev: 3, updatedAt: '2026-09-18T08:00:00Z', note: 'four weeks' } })
    expect(host.textContent).toContain('four weeks')
    act(() => button(host, 'Edit their plan').click())
    expect(mocks.nav).toHaveBeenCalledWith('/admin/client/u1/plan')
  })
})
