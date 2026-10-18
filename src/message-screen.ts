import type { PatientMessage } from '../shared/messages.ts'
import { fit } from './screens.ts'

// Full bodies are paginated, never truncated. Review every page before sending.
export function messagePages(text: string): string[][] {
  const lines: string[] = []
  let line = ''
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (line && line.length + word.length + 1 > 34) { lines.push(line); line = '' }
    let rest = word
    while (rest.length > 34) { if (line) { lines.push(line); line = '' }; lines.push(rest.slice(0, 34)); rest = rest.slice(34) }
    line = line ? `${line} ${rest}` : rest
  }
  if (line) lines.push(line)
  const pages: string[][] = []
  for (let i = 0; i < lines.length; i += 3) pages.push(lines.slice(i, i + 3))
  return pages.length ? pages : [['']]
}
export function messageScreen(m: PatientMessage, text: string, page: number, review = false): string {
  const pages = messagePages(text), index = Math.min(page, pages.length - 1)
  const last = index === pages.length - 1
  const title = review ? `Reply to ${m.name}` : `${m.demo ? 'DEMO ' : ''}${m.name} (${m.relation})`
  const hint = !last ? `Tap: next ${index + 1}/${pages.length}` : review ? 'Tap: send | Hold: cancel' : 'Tap: done | Hold: reply'
  return [fit(title), ...pages[index], ...Array(3 - pages[index].length).fill(''), hint].join('\n')
}
