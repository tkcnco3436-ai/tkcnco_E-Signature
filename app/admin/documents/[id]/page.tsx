import { notFound } from 'next/navigation'
import { getBundle } from '@/lib/db'
import { signLink } from '@/lib/workflow'
import DocumentDetail from '@/components/admin/DocumentDetail'

export const dynamic = 'force-dynamic'

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const bundle = getBundle(id)
  if (!bundle) notFound()

  const links: Record<string, string> = {}
  for (const s of bundle.signers) links[s.id] = signLink(s.token)

  // Signature images are not needed here; keep the payload small. JSON round-trip: node:sqlite
  // rows have a null prototype, which React cannot pass to Client Components.
  const safe = JSON.parse(
    JSON.stringify({ ...bundle, signers: bundle.signers.map((s) => ({ ...s, signature_png: null })) }),
  ) as typeof bundle
  return <DocumentDetail bundle={safe} links={links} />
}
