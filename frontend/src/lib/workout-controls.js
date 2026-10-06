// Which optional control groups the workout screen shows besides the sets themselves
// (Settings → During a workout → Workout controls). The lean default keeps the sets and one
// "more" button per exercise; each flag brings one of the old always-visible groups back.
// Lives in its own module so views can read it without the store — the store's DEF only
// references it.
export const WC_DEFAULT = Object.freeze({
  steppers: true,         // +/- buttons on every weight/reps/effort field
  setShortcuts: false,    // "+ Drop" / "+ Burst" chips on every set and the warm-up/remove/add row
  pairButtons: false,     // "Make superset with previous/next" in the exercise header
  exerciseButtons: false, // Move up/down, Swap, Remove exercise below the exercise
  addExercise: true,      // "+ Add exercise" at the foot of the session
  sessionNote: true,      // "Add session note" next to Finish
})

// Two of these put something into the session that was never in the plan: an exercise nobody
// prescribed, and a note the coach will not read. A client's screen is the work they were
// given and a way to log it, so those two are off for them whatever the setting says.
//
// The rest stay. Moving, swapping or dropping an exercise only rearranges today — the plan on
// the server is untouched, and a machine that is taken, or a shoulder that is not having it,
// are exactly the things somebody needs to handle without texting their coach mid-session.
export function workoutControls(S, { admin = false } = {}) {
  const wc = { ...WC_DEFAULT, ...((S && S.wc) || {}) }
  return admin ? wc : { ...wc, addExercise: false, sessionNote: false }
}
