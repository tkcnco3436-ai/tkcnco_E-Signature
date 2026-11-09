'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PdfPages from '@/components/PdfPages'
import SignaturePad from '@/components/sign/SignaturePad'
import type { SignField, SignSubmitBody, SignViewResponse } from '@/components/sign/types'
import type { DocumentStatus, SignerStatus } from '@/lib/types'

const CONSENT_TEXT = '본 문서 내용을 확인했으며 전자서명에 동의합니다. 전자서명은 자필 서명과 동일한 효력을 가집니다.'
const SIG_KEY = '__signature__'

function todaySeoul(): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function formatDateTime(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
  } catch {
    return iso
  }
}

const DOC_STATUS: Record<DocumentStatus, string> = {
  draft: '준비 중',
  sent: '서명 진행 중',
  completed: '서명 완료',
  voided: '취소됨',
}
const SIGNER_STATUS: Record<SignerStatus, string> = {
  pending: '대기',
  sent: '서명 요청됨',
  viewed: '열람함',
  signed: '서명함',
}

type LoadState = { kind: 'loading' } | { kind: 'notfound' } | { kind: 'error'; message: string } | { kind: 'ready'; data: SignViewResponse }

export default function SignClient({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [done, setDone] = useState<{ completed: boolean } | null>(null)
  const base = `/api/sign/${encodeURIComponent(token)}`

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const res = await fetch(base, { cache: 'no-store' })
      if (res.status === 404) return setState({ kind: 'notfound' })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body) return setState({ kind: 'error', message: body?.error ?? '문서 정보를 불러오지 못했습니다.' })
      setState({ kind: 'ready', data: body as SignViewResponse })
    } catch {
      setState({ kind: 'error', message: '네트워크 오류로 문서 정보를 불러오지 못했습니다.' })
    }
  }, [base])

  useEffect(() => {
    void load()
  }, [load])

  if (state.kind === 'loading') {
    return (
      <Shell>
        <div role="status" className="flex items-center gap-2 py-24 text-sm text-[var(--muted)]">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--line)] border-t-[var(--accent)]" aria-hidden />
          문서 정보를 불러오는 중...
        </div>
      </Shell>
    )
  }
  if (state.kind === 'notfound') {
    return (
      <Shell>
        <Notice title="유효하지 않은 서명 링크입니다" body="링크가 잘못되었거나 문서가 삭제되었습니다. 문서를 보낸 분께 확인해 주세요." />
      </Shell>
    )
  }
  if (state.kind === 'error') {
    return (
      <Shell>
        <Notice title="문서를 불러오지 못했습니다" body={state.message}>
          <button type="button" onClick={() => void load()} className={secondaryBtn}>
            다시 시도
          </button>
        </Notice>
      </Shell>
    )
  }

  const data = state.data
  const downloadHref = `${base}/download`

  if (done) {
    return (
      <Shell>
        <DocHeader data={data} />
        {done.completed ? (
          <Notice title="모든 서명이 완료되었습니다" body="최종 서명본 PDF가 생성되었습니다. 서명자 모두에게 이메일로도 발송됩니다.">
            <a href={downloadHref} className={primaryBtn}>
              서명본 PDF 다운로드
            </a>
          </Notice>
        ) : (
          <Notice
            title="서명이 제출되었습니다"
            body="다른 서명자의 서명을 기다리고 있습니다. 모든 서명이 끝나면 최종 서명본을 이메일로 보내드립니다."
          />
        )}
      </Shell>
    )
  }

  const { document: doc, signer } = data

  if (doc.status === 'voided') {
    return (
      <Shell>
        <DocHeader data={data} />
        <Notice title="취소된 문서입니다" body="문서를 보낸 분이 서명 요청을 취소했습니다. 더 이상 서명할 수 없습니다." />
      </Shell>
    )
  }
  if (doc.status === 'completed') {
    return (
      <Shell>
        <DocHeader data={data} />
        <Notice title="모든 서명이 완료된 문서입니다" body="최종 서명본 PDF를 내려받을 수 있습니다.">
          <a href={downloadHref} className={primaryBtn}>
            서명본 PDF 다운로드
          </a>
        </Notice>
      </Shell>
    )
  }
  if (signer.status === 'signed') {
    return (
      <Shell>
        <DocHeader data={data} />
        <Notice
          title="이미 서명하셨습니다"
          body={`${formatDateTime(signer.signed_at)}에 서명을 제출했습니다. 다른 서명자의 서명을 기다리고 있습니다.`}
        />
      </Shell>
    )
  }
  if (!data.canSign) {
    return (
      <Shell>
        <DocHeader data={data} />
        <Notice title="지금은 서명할 수 없습니다" body={data.reason ?? '서명 순서가 아니거나 서명이 가능한 상태가 아닙니다.'} />
        {doc.status === 'sent' && (
          <section aria-label="문서 미리보기" className="mt-6">
            <PdfPages url={`${base}/file`} renderOverlay={(page, size) => <ReadonlyOverlay fields={data.fields} page={page} size={size} />} />
          </section>
        )}
      </Shell>
    )
  }

  return <SignForm data={data} base={base} onDone={setDone} />
}

/* ---------------------------------------------------------------- signing form */

function SignForm({ data, base, onDone }: { data: SignViewResponse; base: string; onDone: (r: { completed: boolean }) => void }) {
  const { signer } = data
  const myFields = useMemo(
    () => data.fields.filter((f) => f.mine).sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x),
    [data.fields],
  )
  const hasSigFields = myFields.some((f) => f.type === 'signature')

  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    const today = todaySeoul()
    for (const f of myFields) {
      if (f.type === 'signature') continue
      init[f.id] = f.value ?? (f.type === 'name' ? signer.name : f.type === 'date' ? today : '')
    }
    return init
  })
  const [signature, setSignature] = useState<string | null>(null)
  const [padOpen, setPadOpen] = useState(false)
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const consentRef = useRef<HTMLInputElement>(null)

  const isDone = (f: SignField) => (f.type === 'signature' ? !!signature : (values[f.id] ?? '').trim().length > 0)
  const incomplete = myFields.filter((f) => !isDone(f))
  const needsSigOnly = !hasSigFields && !signature // signature image is always required by the API
  const doneCount = myFields.length - incomplete.length
  const ready = incomplete.length === 0 && !needsSigOnly && consent && !submitting

  const goNext = () => {
    const next = incomplete[0]
    if (!next) {
      if (needsSigOnly) return setPadOpen(true)
      consentRef.current?.focus()
      consentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    const el = document.getElementById(`field-${next.id}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlashId(next.id)
    window.setTimeout(() => setFlashId((id) => (id === next.id ? null : id)), 1200)
    window.setTimeout(() => (el as HTMLElement).focus({ preventScroll: true }), 350)
  }

  const submit = async () => {
    if (!ready || !signature) return
    setSubmitting(true)
    setError(null)
    const body: SignSubmitBody = {
      signaturePng: signature,
      values: Object.fromEntries(myFields.filter((f) => f.type !== 'signature').map((f) => [f.id, (values[f.id] ?? '').trim()])),
      consent: true,
    }
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setError(json?.error ?? '서명을 제출하지 못했습니다. 다시 시도해 주세요.')
        setSubmitting(false)
        return
      }
      onDone({ completed: !!json?.completed })
      window.scrollTo({ top: 0 })
    } catch {
      setError('네트워크 오류로 제출하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.')
      setSubmitting(false)
    }
  }

  const renderOverlay = (page: number, size: { width: number; height: number }) => (
    <>
      {data.fields
        .filter((f) => f.page === page)
        .map((f) => {
          const style: React.CSSProperties = {
            left: f.x * size.width,
            top: f.y * size.height,
            width: f.w * size.width,
            height: f.h * size.height,
          }
          if (!f.mine) {
            return <div key={f.id} aria-hidden className="absolute rounded-[2px] border border-dashed border-neutral-300 bg-neutral-400/10" style={style} />
          }
          const flash = flashId === f.id ? 'ring-4 ring-[var(--accent)]/40' : ''
          const done = isDone(f)
          const boxCls = `absolute rounded-[2px] border-2 transition-shadow ${
            done ? 'border-[var(--accent)]/50 bg-[var(--accent)]/5' : 'border-[var(--accent)] bg-[var(--accent)]/15'
          } ${flash}`
          if (f.type === 'signature') {
            return (
              <button
                key={f.id}
                id={`field-${f.id}`}
                type="button"
                onClick={() => setPadOpen(true)}
                aria-label={signature ? '서명 다시 하기' : '서명하기'}
                className={`${boxCls} flex items-center justify-center overflow-hidden outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent)]/40`}
                style={style}
              >
                {signature ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={signature} alt="" className="h-full w-full object-contain" draggable={false} />
                ) : (
                  <span
                    className="font-semibold text-[var(--accent)]"
                    style={{ fontSize: Math.max(10, Math.min(16, f.h * size.height * 0.35)) }}
                  >
                    {f.label || '서명'}
                  </span>
                )}
              </button>
            )
          }
          const h = f.h * size.height
          const label = f.label || (f.type === 'name' ? '이름' : f.type === 'date' ? '날짜' : '텍스트')
          return (
            <input
              key={f.id}
              id={`field-${f.id}`}
              type="text"
              value={values[f.id] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
              placeholder={label}
              aria-label={label}
              maxLength={500}
              inputMode={f.type === 'date' ? 'numeric' : undefined}
              autoComplete={f.type === 'name' ? 'name' : 'off'}
              className={`${boxCls} px-1 text-[var(--fg)] outline-none placeholder:text-[var(--accent)]/60 focus:border-[var(--accent)] focus:bg-white`}
              style={{ ...style, fontSize: Math.max(8, Math.min(h * 0.62, 32)), lineHeight: 1 }}
            />
          )
        })}
    </>
  )

  return (
    <>
      <Shell bottomPad>
        <DocHeader data={data} />
        <p className="mb-4 text-sm text-[var(--muted)]">
          파란색으로 표시된 칸이 {signer.name}님이 입력할 항목입니다. 서명 칸을 누르면 서명을 입력할 수 있습니다.
        </p>
        <section aria-label="서명할 문서">
          <PdfPages url={`${base}/file`} renderOverlay={renderOverlay} />
        </section>
      </Shell>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--line)] bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85">
        <div className="mx-auto flex max-w-[900px] flex-col gap-2 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <label className="flex cursor-pointer items-start gap-3 text-[13px] leading-snug sm:text-sm">
            <input
              ref={consentRef}
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
            />
            <span>{CONSENT_TEXT}</span>
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <span className="mr-auto text-xs text-[var(--muted)] sm:text-sm" aria-live="polite">
              입력 {doneCount}/{myFields.length}
              {needsSigOnly ? ' · 서명 필요' : ''}
            </span>
            {(incomplete.length > 0 || needsSigOnly) && (
              <button type="button" onClick={goNext} className={secondaryBtn}>
                {needsSigOnly && incomplete.length === 0 ? '서명하기' : '다음 필드'}
              </button>
            )}
            <button type="button" onClick={() => void submit()} disabled={!ready} className={primaryBtn} aria-disabled={!ready}>
              {submitting ? '제출 중...' : '서명 완료'}
            </button>
          </div>
        </div>
      </div>

      {padOpen && (
        <Modal title="서명 입력" onClose={() => setPadOpen(false)}>
          <SignaturePad
            defaultName={signer.name}
            onCancel={() => setPadOpen(false)}
            onAdopt={(png) => {
              setSignature(png)
              setPadOpen(false)
            }}
          />
          <p className="mt-3 text-xs text-[var(--muted)]">적용한 서명은 이 문서의 모든 서명 칸에 동일하게 사용됩니다.</p>
        </Modal>
      )}
    </>
  )
}

function ReadonlyOverlay({ fields, page, size }: { fields: SignField[]; page: number; size: { width: number; height: number } }) {
  return (
    <>
      {fields
        .filter((f) => f.page === page)
        .map((f) => (
          <div
            key={f.id}
            aria-hidden
            className={`absolute rounded-[2px] border border-dashed ${
              f.mine ? 'border-[var(--accent)]/60 bg-[var(--accent)]/10' : 'border-neutral-300 bg-neutral-400/10'
            }`}
            style={{ left: f.x * size.width, top: f.y * size.height, width: f.w * size.width, height: f.h * size.height }}
          />
        ))}
    </>
  )
}

/* ---------------------------------------------------------------- layout bits */

const primaryBtn =
  'inline-flex min-h-12 items-center justify-center rounded-md bg-[var(--accent)] px-5 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40'
const secondaryBtn =
  'inline-flex min-h-12 items-center justify-center rounded-md border border-[var(--line)] bg-white px-4 text-sm font-medium text-[var(--fg)] hover:bg-neutral-50'

function Shell({ children, bottomPad }: { children: React.ReactNode; bottomPad?: boolean }) {
  return (
    <main className={`mx-auto w-full max-w-[932px] px-4 pt-6 sm:pt-10 ${bottomPad ? 'pb-56' : 'pb-16'}`}>
      <p className="mb-6 text-xs font-medium tracking-wide text-[var(--muted)]">PDF 전자서명</p>
      {children}
    </main>
  )
}

function DocHeader({ data }: { data: SignViewResponse }) {
  const { document: doc, signer, progress } = data
  return (
    <header className="mb-6 border-b border-[var(--line)] pb-5">
      <h1 className="text-xl font-semibold leading-tight break-words sm:text-2xl">{doc.title}</h1>
      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <div className="flex gap-1.5">
          <dt className="text-[var(--muted)]">서명자</dt>
          <dd className="font-medium">{signer.name}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-[var(--muted)]">문서 상태</dt>
          <dd className="font-medium">{DOC_STATUS[doc.status]}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-[var(--muted)]">내 상태</dt>
          <dd className="font-medium">{SIGNER_STATUS[signer.status]}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-[var(--muted)]">진행</dt>
          <dd className="font-medium">
            {progress.signed}/{progress.total}명 서명
          </dd>
        </div>
      </dl>
      {doc.message && (
        <p className="mt-4 whitespace-pre-wrap rounded-md border border-[var(--line)] bg-white px-4 py-3 text-sm leading-relaxed">{doc.message}</p>
      )}
    </header>
  )
}

function Notice({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-[var(--line)] bg-white px-5 py-8 text-center sm:px-8" aria-live="polite">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[var(--muted)]">{body}</p>
      {children && <div className="mt-6 flex justify-center gap-2">{children}</div>}
    </section>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // Close on backdrop only when the press both started and ended on it (a stroke that leaves the pad must not close).
  const downOnBackdrop = useRef(false)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ref.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      prev?.focus?.()
    }
  }, [])
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-6"
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose()
        downOnBackdrop.current = false
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        className="w-full max-w-xl rounded-t-xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl outline-none sm:rounded-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="modal-title" className="text-base font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="-mr-2 inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--muted)] hover:bg-neutral-100"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
              <path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
