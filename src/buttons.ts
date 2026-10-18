export type Press = 'click' | 'double'
export type PressAction = 'home' | 'toggle-pause' | 'tap'

// On a menu page every press means "back". At home a double press pauses or resumes listening.
// A press while paused resumes — it must not shut the page down, or the glasses go black.
export function pressAction(press: Press, at: { onPage: boolean; paused: boolean }): PressAction {
  if (at.onPage) return 'home'
  if (press === 'double' || at.paused) return 'toggle-pause'
  return 'tap'
}
