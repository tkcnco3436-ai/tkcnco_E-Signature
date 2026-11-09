'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

const MAX_BYTES = 20 * 1024 * 1024

function fmtSize(n: number) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

export default function NewDocumentPage() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [titleTouched, setTitleTouched] = useState(false)
  const [message, setMessage] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function pick(f: File | undefined | null) {
    setError(null)
    if (!f) return
    const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
    if (!isPdf) return setError('PDF 파일만 업로드할 수 있습니다.')
    if (f.size > MAX_BYTES) return setError(`파일이 너무 큽니다 (${fmtSize(f.size)}). 20MB 이하만 가능합니다.`)
    if (f.size === 0) return setError('빈 파일입니다.')
    setFile(f)
    if (!titleTouched || !title.trim()) setTitle(f.name.replace(/\.pdf$/i, ''))
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file || busy) return
    setBusy(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('title', title.trim() || file.name.replace(/\.pdf$/i, ''))
      if (message.trim()) fd.append('message', message.trim())
      const res = await fetch('/api/admin/documents', { method: 'POST', body: fd })
      const data = (await res.json().catch(() => null)) as { id?: string; error?: string } | null
      if (res.status === 401) {
        window.location.assign('/login?next=/admin/new')
        return
      }
      if (!res.ok || !data?.id) throw new Error(data?.error ?? '업로드에 실패했습니다.')
      router.push(`/admin/documents/${data.id}/edit`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '업로드에 실패했습니다.')
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-semibold tracking-tight">새 문서</h1>
      <p className="mt-0.5 text-sm text-[var(--muted)]">서명받을 PDF를 업로드하면 서명 위치를 지정할 수 있습니다.</p>

      <form onSubmit={onSubmit} className="mt-6 space-y-5">
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            pick(e.dataTransfer.files?.[0])
          }}
          className={`rounded-lg border-2 border-dashed bg-white px-6 py-10 text-center transition ${
            dragOver ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--line)]'
          }`}
        >
          <input
            ref={inputRef}
            id="pdf-file"
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            onChange={(e) => pick(e.target.files?.[0])}
          />
          {file ? (
            <div>
              <p className="font-medium break-all">{file.name}</p>
              <p className="mt-1 text-sm text-[var(--muted)]">{fmtSize(file.size)}</p>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="mt-3 rounded-md border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-neutral-50"
              >
                다른 파일 선택
              </button>
            </div>
          ) : (
            <div>
              <p className="text-sm text-[var(--muted)]">PDF 파일을 이곳에 끌어다 놓거나</p>
              <label
                htmlFor="pdf-file"
                className="mt-3 inline-block cursor-pointer rounded-md border border-[var(--line)] px-4 py-2 text-sm font-medium hover:bg-neutral-50"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    inputRef.current?.click()
                  }
                }}
              >
                파일 선택
              </label>
              <p className="mt-3 text-xs text-[var(--muted)]">PDF, 최대 20MB</p>
            </div>
          )}
        </div>

        <div>
          <label htmlFor="title" className="mb-1.5 block text-sm font-medium">
            문서 제목
          </label>
          <input
            id="title"
            value={title}
            maxLength={200}
            onChange={(e) => {
              setTitle(e.target.value)
              setTitleTouched(true)
            }}
            placeholder="파일을 선택하면 파일명이 입력됩니다"
            className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20"
          />
        </div>

        <div>
          <label htmlFor="message" className="mb-1.5 block text-sm font-medium">
            서명자에게 전할 메시지 <span className="font-normal text-[var(--muted)]">(선택)</span>
          </label>
          <textarea
            id="message"
            value={message}
            maxLength={2000}
            rows={3}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="이메일과 서명 화면에 표시됩니다"
            className="w-full resize-y rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20"
          />
        </div>

        {error && (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => router.push('/admin')}
            className="rounded-md border border-[var(--line)] bg-white px-4 py-2 text-sm hover:bg-neutral-50"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={!file || busy}
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? '업로드 중...' : '업로드 후 서명 위치 지정'}
          </button>
        </div>
      </form>
    </div>
  )
}
