import Link from 'next/link'
import { requireAdmin } from '@/lib/auth'
import LogoutButton from '@/components/admin/LogoutButton'

export const metadata = { title: '문서 관리 · PDF 전자서명' }

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Defense in depth: proxy also guards /admin, but never render admin pages without a session.
  await requireAdmin()
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4">
          <Link href="/admin" className="text-[15px] font-semibold tracking-tight">
            PDF 전자서명
          </Link>
          <nav aria-label="관리자 메뉴" className="flex items-center gap-1">
            <Link
              href="/admin/new"
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              새 문서
            </Link>
            <LogoutButton />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  )
}
