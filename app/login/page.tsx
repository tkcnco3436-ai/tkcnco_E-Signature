import LoginForm from '@/components/admin/LoginForm'

export const metadata = { title: '로그인 · PDF 전자서명' }

function safeNext(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v
  // Only same-origin absolute paths; reject protocol-relative and backslash tricks.
  if (!s || !s.startsWith('/') || s.startsWith('//') || s.includes('\\')) return '/admin'
  return s
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">PDF 전자서명</h1>
        <p className="mb-6 text-sm text-[var(--muted)]">관리자 비밀번호를 입력하세요.</p>
        <LoginForm next={safeNext(sp.next)} />
      </div>
    </main>
  )
}
