import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getDocument, getSignerByToken } from '@/lib/db'
import SignClient from '@/components/sign/SignClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '문서 서명 | PDF 전자서명',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  // Existence check only. All document data is loaded by the client from /api/sign/[token],
  // so the page never hands the client more than the API returns.
  const signer = getSignerByToken(token)
  if (!signer || !getDocument(signer.document_id)) notFound()
  return <SignClient token={token} />
}
