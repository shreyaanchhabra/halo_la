import { pages } from '../config/pages'

const page = pages.find(p => p.href === location.pathname) ?? pages[0]
const nav = pages.map(p => `<a href="${p.href}" ${p === page ? 'aria-current="page"' : ''}>${p.label}</a>`).join('')
document.querySelector('.top')!.innerHTML = `<strong>HALO</strong><span>Care portal</span><nav aria-label="Care portal">${nav}</nav>`
if (page.href === '/refills.html') {
  document.querySelector('main')!.insertAdjacentHTML('afterbegin', '<div class="page-intro"><h1>Medicine refills</h1><p class="hint">Track medication stock and review family refill approvals.</p></div>')
}
