// @vitest-environment happy-dom
// The programme editor offers the starter plan to a client who has no routines yet. It used to
// wire the button straight to the loader, which quietly handed the click event in as the plan
// id and loaded nothing at all — so the entry point is pinned here.
//
// Home used to carry the same button and is covered no longer: a client cannot load a plan on
// themselves (views/Home.jsx asks the coach for one instead), and the coach reaches the loader
// from the editor.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { starterPlanSheet } from '../sheets.jsx'
import PlanEdit from './PlanEdit.jsx'

vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), bwSheet: vi.fn(), goalSheet: vi.fn(), dayOverrideSheet: vi.fn(),
  calendarSheet: vi.fn(), startFlow: vi.fn(), bwDeltaColor: () => '', weighInsSheet: vi.fn(),
  dayAssignSheet: vi.fn(), planToolsSheet: vi.fn(),
}))

let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  starterPlanSheet.mockClear()
  useStore.setState(s => ({ S: { ...s.S, routines: [], week: {}, active: null }, user: null }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const starterButton = () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Load starter plan')

describe('the programme editor, empty', () => {
  it('opens the starter plan chooser instead of loading one plan blind', () => {
    act(() => root.render(<PlanEdit />))
    const button = starterButton()
    expect(button).toBeTruthy()

    act(() => { button.click() })
    expect(starterPlanSheet).toHaveBeenCalledTimes(1)
  })

  it('drops the offer once there are routines', () => {
    useStore.setState(s => ({ S: { ...s.S, routines: [{ id: 'r', name: 'Mine', emoji: 'star', ex: [] }] } }))
    act(() => root.render(<PlanEdit />))
    expect(starterButton()).toBeFalsy()
  })
})
