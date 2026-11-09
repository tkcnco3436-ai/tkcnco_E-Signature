import type { DocumentStatus } from '@/lib/types'
import { DOC_STATUS_LABEL } from '@/components/labels'

export { SIGNER_STATUS_LABEL, signerStatusLabel } from '@/components/labels'

const kst = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const kstDate = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '-' : kst.format(d)
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '-' : kstDate.format(d)
}

export const DOC_STATUS: Record<DocumentStatus, { label: string; cls: string }> = {
  draft: { label: DOC_STATUS_LABEL.draft, cls: 'bg-neutral-100 text-neutral-700 ring-neutral-300' },
  sent: { label: DOC_STATUS_LABEL.sent, cls: 'bg-amber-50 text-amber-800 ring-amber-300' },
  completed: { label: DOC_STATUS_LABEL.completed, cls: 'bg-emerald-50 text-emerald-800 ring-emerald-300' },
  voided: { label: DOC_STATUS_LABEL.voided, cls: 'bg-red-50 text-red-700 ring-red-200' },
}

// Distinct, readable colors for signers (index = signing order).
export const SIGNER_COLORS = ['#1f4e79', '#b45309', '#047857', '#7c3aed', '#be123c', '#0e7490', '#4d7c0f', '#a21caf']
export const signerColor = (i: number) => SIGNER_COLORS[i % SIGNER_COLORS.length]
