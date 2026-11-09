import Link from 'next/link'
import { getSigners, listDocuments } from '@/lib/db'
import StatusBadge from '@/components/admin/StatusBadge'
import { fmtDate } from '@/components/admin/format'

export const dynamic = 'force-dynamic'

export default async function AdminHome() {
  const docs = listDocuments().map((d) => {
    const signers = getSigners(d.id)
    return { doc: d, total: signers.length, signed: signers.filter((s) => s.status === 'signed').length }
  })

  return (
    <div>
      <div className="mb-5 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">문서</h1>
          <p className="mt-0.5 text-sm text-[var(--muted)]">총 {docs.length}건</p>
        </div>
      </div>

      {docs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--line)] bg-white px-6 py-16 text-center">
          <p className="text-sm text-[var(--muted)]">아직 문서가 없습니다.</p>
          <Link
            href="/admin/new"
            className="mt-4 inline-block rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            PDF 업로드
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--line)] bg-white">
          {/* Desktop table */}
          <table className="hidden w-full text-sm md:table">
            <thead className="border-b border-[var(--line)] bg-neutral-50 text-left text-xs text-[var(--muted)]">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">제목</th>
                <th scope="col" className="px-4 py-2.5 font-medium">상태</th>
                <th scope="col" className="px-4 py-2.5 font-medium">서명</th>
                <th scope="col" className="px-4 py-2.5 font-medium">생성일</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">작업</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {docs.map(({ doc, total, signed }) => (
                <tr key={doc.id} className="hover:bg-neutral-50/70">
                  <td className="max-w-0 px-4 py-3">
                    <Link href={`/admin/documents/${doc.id}`} className="block truncate font-medium hover:underline">
                      {doc.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={doc.status} />
                  </td>
                  <td className="px-4 py-3 tabular-nums text-[var(--muted)]">
                    <Progress signed={signed} total={total} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 tabular-nums text-[var(--muted)]">{fmtDate(doc.created_at)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <Actions id={doc.id} status={doc.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Mobile list */}
          <ul className="divide-y divide-[var(--line)] md:hidden">
            {docs.map(({ doc, total, signed }) => (
              <li key={doc.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/admin/documents/${doc.id}`} className="min-w-0 flex-1 truncate font-medium">
                    {doc.title}
                  </Link>
                  <StatusBadge status={doc.status} />
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
                  <span className="tabular-nums">
                    {fmtDate(doc.created_at)} · <Progress signed={signed} total={total} />
                  </span>
                  <Actions id={doc.id} status={doc.status} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Progress({ signed, total }: { signed: number; total: number }) {
  if (total === 0) return <span>서명자 없음</span>
  return (
    <span aria-label={`${total}명 중 ${signed}명 서명`}>
      {signed}/{total} 서명
    </span>
  )
}

function Actions({ id, status }: { id: string; status: string }) {
  const link = 'rounded px-2 py-1 text-sm text-[var(--accent)] hover:bg-neutral-100'
  return (
    <span className="inline-flex items-center gap-1">
      {status === 'draft' && (
        <Link href={`/admin/documents/${id}/edit`} className={link}>
          편집
        </Link>
      )}
      {status === 'completed' && (
        <a href={`/api/admin/documents/${id}/file?kind=signed&download=1`} className={link}>
          다운로드
        </a>
      )}
      <Link href={`/admin/documents/${id}`} className={link}>
        상세
      </Link>
    </span>
  )
}
