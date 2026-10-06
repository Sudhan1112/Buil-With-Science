// @vitest-environment happy-dom
// What a client's workout screen does not have.
//
// Two of the controls put something into the session that the coach never prescribed and will
// never read: an exercise picked on the spot, and a session note. Both are gone for a client
// and both stay for the coach (lib/workout-controls.js), and because they are gated on the
// signed-in profile rather than on a setting, the switch in Settings cannot bring them back.
//
// What is *not* removed matters as much, and is pinned below: moving, swapping and dropping an
// exercise only rearrange today. A taken machine or a shoulder that is not having it are the
// everyday reasons somebody needs those mid-session, and the plan on the server is untouched
// either way.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Workout from './Workout.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'

vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), vibrate: vi.fn(), unlock: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({})), beacon: vi.fn() }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const clone = value => JSON.parse(JSON.stringify(value))
const client = { id: 'u2', name: 'Bo' }
const coach = { id: 'u1', name: 'Ana', admin: true }

let root, container

// Everything optional turned on, so a control that is missing is missing because of the
// profile and not because of the setting.
function render(user) {
  const S = clone(DEF)
  S.wc = { ...S.wc, exerciseButtons: true, addExercise: true, sessionNote: true }
  S.active = {
    id: 'client-test', d: '2026-08-11', start: Date.now(), routineId: null,
    name: 'Session', bw: null, cur: 0,
    entries: [{ id: '1001', target: { sets: 1, reps: 1 }, sets: [{ w: 0, r: 1, done: false }] }]
  }
  useStore.setState({ S, user })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<MemoryRouter><Workout /></MemoryRouter>))
}

const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.includes(text))

beforeEach(() => {
  localStorage.clear()
  useUI.setState({ sheets: [], toastMsg: '', timer: null, work: null })
  useStore.setState({ S: clone(DEF), user: null })
  root = null
  container = null
})
afterEach(() => {
  if (root) act(() => root.unmount())
  if (container) container.remove()
})

describe('a client\u2019s workout screen', () => {
  it('has no Add exercise and no session note, whatever the setting says', () => {
    render(client)
    expect(button('Add exercise')).toBeUndefined()
    expect(button('session note')).toBeUndefined()
  })

  it('keeps the controls that only rearrange today', () => {
    render(client)
    expect(button('Remove exercise')).toBeTruthy()
    expect(button('Move down')).toBeTruthy()
  })

  it('gives the coach both back', () => {
    render(coach)
    expect(button('Add exercise')).toBeTruthy()
    expect(button('session note')).toBeTruthy()
  })
})
