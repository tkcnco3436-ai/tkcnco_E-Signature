import Link from 'next/link'

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-6 py-16">
      <p className="text-xs font-medium tracking-wide text-[var(--muted)]">PDF 전자서명</p>
      <h1 className="mt-2 text-2xl font-semibold leading-tight">PDF에 서명하고, 상대방 서명을 받아 함께 보관합니다.</h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
        서명 요청을 받으셨다면 이메일의 링크로 접속해 주세요. 문서 관리자는 아래에서 로그인할 수 있습니다.
      </p>
      <div className="mt-8">
        <Link
          href="/admin"
          className="inline-flex min-h-12 items-center justify-center rounded-md bg-[var(--accent)] px-6 text-sm font-semibold text-white hover:opacity-90"
        >
          관리자 페이지
        </Link>
      </div>
    </main>
  )
}
