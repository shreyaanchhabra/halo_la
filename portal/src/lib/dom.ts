export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

// Writes html into an element only when it changed, so typing and focus are never disturbed.
export function htmlCache() {
  const shown: Record<string, string> = {}
  return {
    shown,
    set(id: string, html: string) {
      if (shown[id] === html) return
      shown[id] = html
      $(id).innerHTML = html
    },
  }
}
