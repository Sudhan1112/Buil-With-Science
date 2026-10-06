// @vitest-environment happy-dom
// Who is offered the control that hands out coach access. The rule is enforced server-side
// (requireOwner in api/server.js, api/test/server-roles.test.js); this is about not showing a
// second coach a button whose only purpose would be to refuse them.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Admin from './Admin.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ me: null, target: null, calls: [], confirm: vi.fn(), sheets: [] }))
vi.mock('../lib/api.js', () => ({
  api: (path, init) => {
    const key = path.split('?')[0]
    mocks.calls.push([key, init ? JSON.parse(init.body) : null])
    if (key === '/api/admin/users') return Promise.resolve({ users: [{ id: 'u1', name: 'Bo', workouts: 0, lastSync: null, disabled: false }], invite_only: false })
    if (key === '/api/admin/user') return Promise.resolve({
      user: { id: 'u1', name: 'Bo', created: '2026-09-01T00:00:00Z', disabled: false, ...mocks.target },
      unit: 'kg', lastSync: null, routines: [], bodyweight: [], workouts: []
    })
    return Promise.resolve({ ok: true })
  }
}))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: mocks.me, S: {} })
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
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../sheets.jsx', () => ({ confirmSheet: mocks.confirm }))
vi.mock('./AdminCoach.jsx', () => ({ default: () => null }))
vi.mock('./AdminClient.jsx', () => ({ default: () => null, SubPill: () => null }))

const OWNER = { id: 'adm', name: 'Sudhan', admin: true, owner: true }
const SECOND = { id: 'two', name: 'Second', admin: true, owner: false }

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

// The account-settings sheet behind the ⚙, which is where coach access lives.
async function openAccount() {
  const page = await render(<Admin />)
  await settle()
  const row = [...page.querySelectorAll('.item')].find(el => el.textContent.includes('Bo'))
  await act(async () => { row.querySelector('button[aria-label^="Account settings"]').click() })
  const sheet = await render(mocks.sheets.at(-1)(() => {}))
  await settle()
  return sheet
}
const button = (host, label) => [...host.querySelectorAll('button')].find(b => b.textContent === label)
// The body of the role call, wherever it fell: a successful one is followed by a reload of the
// client list, so it is never the most recent thing the component did.
const roleCall = () => mocks.calls.find(([p]) => p === '/api/admin/user/role')?.[1]

beforeEach(() => {
  mocks.calls.length = 0
  mocks.sheets.length = 0
  mocks.confirm.mockReset()
  mocks.me = OWNER
  mocks.target = { admin: false }
})
afterEach(async () => { if (live) { await act(async () => live.unmount()); live = null } })

describe('coach access', () => {
  it('the owner can promote a client, and the confirm is what actually sends it', async () => {
    const sheet = await openAccount()
    const promote = button(sheet, 'Make them a coach')
    expect(promote).toBeTruthy()
    expect(button(sheet, 'Remove coach access')).toBeUndefined()

    await act(async () => { promote.click() })
    const asked = mocks.confirm.mock.calls.at(-1)[0]
    expect(asked.title).toBe('Make Bo a coach?')
    // The sentence has to say both halves: what they get, and what they do not.
    expect(asked.message).toMatch(/every client’s workouts/)
    expect(asked.message).toMatch(/not be able to give coach access to anyone else/)
    expect(roleCall()).toBeUndefined()

    await act(async () => { await asked.onConfirm() })
    expect(roleCall()).toEqual({ id: 'u1', admin: true })
  })

  it('an existing coach is offered the way back out, and it is a destructive confirm', async () => {
    mocks.target = { admin: true }
    const sheet = await openAccount()
    expect(button(sheet, 'Make them a coach')).toBeUndefined()

    await act(async () => { button(sheet, 'Remove coach access').click() })
    const asked = mocks.confirm.mock.calls.at(-1)[0]
    expect(asked.danger).toBe(true)
    expect(asked.message).toMatch(/signed out everywhere/)
    await act(async () => { await asked.onConfirm() })
    expect(roleCall()).toEqual({ id: 'u1', admin: false })
  })

  it('a second coach is not shown the control at all', async () => {
    mocks.me = SECOND
    const sheet = await openAccount()
    expect(button(sheet, 'Make them a coach')).toBeUndefined()
    expect(button(sheet, 'Remove coach access')).toBeUndefined()
    // They still have the rest of the account sheet — this is one missing button, not a wall.
    expect(button(sheet, 'Disable account')).toBeTruthy()
  })

  it('an owner is not something the owner is offered a toggle for', async () => {
    mocks.target = { admin: true, owner: true }
    const sheet = await openAccount()
    expect(button(sheet, 'Remove coach access')).toBeUndefined()
    expect(sheet.textContent).toContain('owner')
  })
})
