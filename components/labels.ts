// Shared status wording for admin and signer pages. Keep every user-facing status label here.
import type { DocumentStatus, SignerStatus } from '@/lib/types'

export const DOC_STATUS_LABEL: Record<DocumentStatus, string> = {
  draft: '작성 중',
  sent: '서명 진행 중',
  completed: '완료',
  voided: '무효',
}

export const SIGNER_STATUS_LABEL: Record<SignerStatus, string> = {
  pending: '대기',
  sent: '서명 요청됨',
  viewed: '열람함',
  signed: '서명 완료',
}

// The owner gets no request link of their own: for them `sent` just means it is their turn.
export function signerStatusLabel(status: SignerStatus, isOwner: boolean | 0 | 1): string {
  if (isOwner && status === 'sent') return '서명 차례'
  return SIGNER_STATUS_LABEL[status]
}
