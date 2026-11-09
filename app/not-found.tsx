import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-6 py-16">
      <p className="text-xs font-medium tracking-wide text-[var(--muted)]">404</p>
      <h1 className="mt-2 text-2xl font-semibold">페이지를 찾을 수 없습니다</h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
        주소가 잘못되었거나, 서명 링크가 만료되었거나 문서가 삭제되었습니다. 서명 요청을 받으셨다면 문서를 보낸 분께 확인해 주세요.
      </p>
      <div className="mt-8">
        <Link
          href="/"
          className="inline-flex min-h-12 items-center justify-center rounded-md border border-[var(--line)] bg-white px-5 text-sm font-medium hover:bg-neutral-50"
        >
          처음으로
        </Link>
      </div>
    </main>
  )
}
