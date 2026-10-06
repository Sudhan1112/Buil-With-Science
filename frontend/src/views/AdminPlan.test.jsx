// @vitest-environment happy-dom
// Publishing a client's programme.
//
// Two things matter here and neither is visible by clicking around. First, what gets sent: the
// whole plan document plus the revision it was taken from, because `baseRev` is the only thing
// standing between two coach tabs and a silently lost edit. Second, that a routine is *copied*
// out of the coach's own library rather than referenced — a coach who hands "Upper A" to six
// people and then edits their own copy must not rewrite six people's training.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPlan from './AdminPlan.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mine = [{ id: 'mine-1', name: 'Upper A', emoji: 'barbell', ex: [{ id: '1001' }, { id: '1002' }] }]
const mocks = vi.hoisted(() => ({ plan: null, calls: [], sheets: [], confirm: vi.fn(), nav: vi.fn(), fail: null, mine: [] }))
vi.mock('../lib/api.js', () => ({
  api: (path, init) => {
    mocks.calls.push([path.split('?')[0], init?.method || 'GET', init ? JSON.parse(init.body) : null])
    if (init?.method === 'PUT') {
      if (mocks.fail) { const e = new Error('conflict'); e.status = mocks.fail; mocks.fail = null; return Promise.reject(e) }
      return Promise.resolve({ ok: true, plan: { ...mocks.plan, _rev: (mocks.plan._rev || 0) + 1 } })
    }
    return Promise.resolve({ plan: mocks.plan, user: { id: 'u1', name: 'Bo' } })
  }
}))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: { id: 'adm', name: 'Coach', admin: true }, S: { routines: mocks.mine, weekStart: 1 } })
  const useStore = selector => (selector ? selector(snap()) : snap())
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: () => {}, openSheet: render => mocks.sheets.push(render) })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.nav, useParams: () => ({ id: 'u1' }) }))
vi.mock('../sheets.jsx', () => ({ confirmSheet: mocks.confirm }))

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
const open = async plan => {
  mocks.plan = { routines: [], week: {}, note: '', _rev: 0, updatedAt: null, ...plan }
  const host = await render(<AdminPlan />)
  await settle()
  return host
}
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text))
// The sheets this screen opens render into the same host, which is enough to drive them.
const inSheet = async host => {
  const sheet = mocks.sheets.at(-1)
  const sub = document.createElement('div')
  host.appendChild(sub)
  const root = createRoot(sub)
  await act(async () => { root.render(sheet(() => {})) })
  return sub
}
const published = () => mocks.calls.filter(([, m]) => m === 'PUT').map(([, , body]) => body)

beforeEach(() => {
  mocks.calls.length = 0
  mocks.sheets.length = 0
  mocks.confirm.mockClear()
  mocks.nav.mockClear()
  mocks.fail = null
  mocks.mine = mine
})
afterEach(async () => {
  if (live) { await act(async () => live.unmount()); live = null }
  document.body.innerHTML = ''
})

describe('writing a client’s plan', () => {
  it('starts empty and will not publish until something changes', async () => {
    const host = await open()
    expect(host.textContent).toContain('Nothing published yet')
    expect(button(host, 'Published').disabled).toBe(true)
  })

  /* A coach on a fresh instance has no routines, so the library this screen copies from is
     empty — and the screen used to say so and then offer nothing but "Close", which is a wall
     on the one path that matters on day one. Both empty states now lead to the Plan tab. */
  it('sends a coach with no routines of their own to the tab where routines are written', async () => {
    mocks.mine = []
    const host = await open()
    expect(host.textContent).toContain('no routines of your own to copy')

    act(() => button(host, 'Go and write one').click())
    expect(mocks.nav).toHaveBeenCalledWith('/plan')

    // And the same way out of the picker, which is where they land if they tap "Copy one in".
    mocks.nav.mockClear()
    act(() => button(host, 'Copy one in').click())
    const sheet = await inSheet(host)
    expect(sheet.textContent).toContain('No routines of your own yet')
    act(() => button(sheet, 'Go and write one').click())
    expect(mocks.nav).toHaveBeenCalledWith('/plan')
  })

  it('asks before walking off to the Plan tab with an unpublished draft', async () => {
    mocks.mine = []
    const host = await open({ _rev: 1 })
    // A note typed but not published is still a draft worth warning about.
    act(() => host.querySelector('textarea').dispatchEvent(new Event('input', { bubbles: true })))

    act(() => button(host, 'Go and write one').click())
    // Same guard as the back button: the draft lives in this tab until it is published.
    expect(mocks.nav).not.toHaveBeenCalled()
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    act(() => mocks.confirm.mock.calls[0][0].onConfirm())
    expect(mocks.nav).toHaveBeenCalledWith('/plan')
  })

  it('copies a routine in under a new id, and publishes it with the revision it was read at', async () => {
    const host = await open({ _rev: 4, routines: [], week: {} })
    act(() => button(host, 'Copy one in').click())
    const sheet = await inSheet(host)
    await act(async () => { [...sheet.querySelectorAll('.item')][0].click() })

    act(() => button(host, 'Publish to Bo').click())
    await settle()
    const sent = published()[0]
    expect(sent.id).toBe('u1')
    expect(sent.baseRev).toBe(4)
    expect(sent.plan.routines).toHaveLength(1)
    expect(sent.plan.routines[0].name).toBe('Upper A')
    // A copy: same content, its own id, and no shared reference back to the coach's array.
    expect(sent.plan.routines[0].id).not.toBe('mine-1')
    expect(sent.plan.routines[0].ex).toEqual(mine[0].ex)
    expect(sent.plan.routines[0].ex).not.toBe(mine[0].ex)
  })

  it('removes a routine from the days it was on, and only after a confirmation', async () => {
    const host = await open({ _rev: 2, routines: [{ id: 'r1', name: 'Upper A', ex: [] }], week: { 1: ['r1'], 4: ['r1'] } })
    expect(host.textContent).toContain('2 training days a week')
    act(() => host.querySelector('button[aria-label="Remove Upper A"]').click())
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    await act(async () => { mocks.confirm.mock.calls[0][0].onConfirm() })

    act(() => button(host, 'Publish to Bo').click())
    await settle()
    expect(published()[0].plan).toMatchObject({ routines: [], week: {} })
  })

  // Two tabs. The server refuses the stale write; the screen reloads rather than asking the
  // coach to work out which half of their plan survived.
  it('reloads instead of retrying when the server says the plan moved on', async () => {
    const host = await open({ _rev: 1, routines: [{ id: 'r1', name: 'Upper A', ex: [] }], week: {} })
    act(() => host.querySelector('textarea').dispatchEvent(new Event('input', { bubbles: true })))
    act(() => host.querySelector('button[aria-label="Remove Upper A"]').click())
    await act(async () => { mocks.confirm.mock.calls[0][0].onConfirm() })

    mocks.fail = 409
    act(() => button(host, 'Publish to Bo').click())
    await settle()
    expect(published()).toHaveLength(1)
    // The reload is a fresh GET, and the screen is back to what the server holds.
    expect(mocks.calls.filter(([, m]) => m === 'GET')).toHaveLength(2)
    expect(host.textContent).toContain('Upper A')
  })
})
