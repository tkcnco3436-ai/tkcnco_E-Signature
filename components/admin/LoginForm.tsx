'use client'

import { useState } from 'react'

export default function LoginForm({ next }: { next: string }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        // Full navigation so the new cookie is used by server components and proxy.
        window.location.assign(next)
        return
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null
      setError(data?.error ?? '로그인에 실패했습니다.')
    } catch {
      setError('네트워크 오류가 발생했습니다.')
    }
    setBusy(false)
  }

  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm">
      <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
        비밀번호
      </label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        autoFocus
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'login-error' : undefined}
        className="w-full rounded-md border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20"
      />
      {error && (
        <p id="login-error" role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !password}
        className="mt-4 w-full rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
      >
        {busy ? '확인 중...' : '로그인'}
      </button>
    </form>
  )
}
