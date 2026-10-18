import { $ } from '../../lib/dom'

export const value = (id: string) => $<HTMLInputElement>(id).value.trim()
export const money = (c: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(c / 100)
