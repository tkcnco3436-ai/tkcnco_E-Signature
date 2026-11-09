import { notFound, redirect } from 'next/navigation'
import { getBundle } from '@/lib/db'
import FieldEditor from '@/components/admin/FieldEditor'

export const dynamic = 'force-dynamic'

export default async function EditDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const bundle = getBundle(id)
  if (!bundle) notFound()
  if (bundle.document.status !== 'draft') redirect(`/admin/documents/${id}`)

  // Strip secrets the editor does not need. JSON round-trip: node:sqlite rows have a null
  // prototype, which React cannot pass to Client Components.
  const safe = JSON.parse(
    JSON.stringify({ ...bundle, signers: bundle.signers.map((s) => ({ ...s, token: '', signature_png: null })) }),
  ) as typeof bundle

  return (
    <FieldEditor
      bundle={safe}
      owner={{ name: process.env.OWNER_NAME ?? '', email: process.env.OWNER_EMAIL ?? '' }}
    />
  )
}
