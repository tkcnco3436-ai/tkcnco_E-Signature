'use client'

import { useState } from 'react'

export default function LogoutButton() {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await fetch('/api/auth/logout', { method: 'POST' })
        } finally {
          window.location.assign('/login')
        }
      }}
      className="rounded-md px-3 py-1.5 text-sm text-[var(--muted)] hover:bg-neutral-100 hover:text-[var(--fg)] disabled:opacity-50"
    >
      로그아웃
    </button>
  )
}
