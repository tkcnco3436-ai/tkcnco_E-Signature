'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import PdfPages from '@/components/PdfPages'
import SignaturePad from '@/components/sign/SignaturePad'
import type { SignField, SignSubmitBody, SignViewResponse } from '@/components/sign/types'
import { DOC_STATUS_LABEL, SIGNER_STATUS_LABEL } from '@/components/labels'

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

  // After submitting: re-read status/progress without flashing the loading screen.
  const finish = useCallback(
    async (r: { completed: boolean }) => {
      try {
        const res = await fetch(base, { cache: 'no-store' })
        const body = res.ok ? await res.json().catch(() => null) : null
        if (body) setState({ kind: 'ready', data: body as SignViewResponse })
      } catch {
        // Keep the previous data; the completion notice is still correct.
      }
      setDone(r)
    },
    [base],
  )

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

  return <SignForm data={data} base={base} onDone={finish} />
}

/* ---------------------------------------------------------------- signing form */

function SignForm({ data, base, onDone }: { data: SignViewResponse; base: string; onDone: (r: { completed: boolean }) => Promise<void> }) {
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
  const [editingId, setEditingId] = useState<string | null>(null)
  const [otpVerified, setOtpVerified] = useState(data.otp.verified)
  const [otpOpen, setOtpOpen] = useState(false)
  // Code requested automatically when the signer first opens the signature pad (mail arrives while they sign).
  const [otpAuto, setOtpAuto] = useState<{ at: number; resendIn: number; expiresIn: number } | null>(null)
  const otpAutoTried = useRef(false)
  const consentRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!padOpen || otpAutoTried.current || !data.otp.required || otpVerified) return
    otpAutoTried.current = true
    void (async () => {
      try {
        const res = await fetch(`${base}/otp`, { method: 'POST' })
        const json = await res.json().catch(() => null)
        // 429 = a code was sent moments ago (e.g. page reload): treat it as sent.
        if (res.ok || res.status === 429) {
          setOtpAuto({
            at: Date.now(),
            resendIn: typeof json?.resend_in === 'number' ? json.resend_in : typeof json?.retry_after === 'number' ? json.retry_after : 30,
            expiresIn: typeof json?.expires_in === 'number' ? json.expires_in : 300,
          })
        }
      } catch {
        /* silent: the OTP sheet still lets the signer request a code */
      }
    })()
  }, [padOpen, data.otp.required, otpVerified, base])
  const textFields = useMemo(() => myFields.filter((f) => f.type !== 'signature'), [myFields])

  // Bring a field into the upper part of the screen so the bottom sheet does not cover it.
  const revealField = (id: string) => {
    const el = document.getElementById(`field-${id}`)
    if (!el) return
    const r = el.getBoundingClientRect()
    const target = window.scrollY + r.top - Math.max(16, window.innerHeight * 0.22)
    window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
  }
  const openEditor = (id: string) => {
    setEditingId(id)
    revealField(id)
  }

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
    if (next.type !== 'signature') return openEditor(next.id)
    const el = document.getElementById(`field-${next.id}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlashId(next.id)
    window.setTimeout(() => setFlashId((id) => (id === next.id ? null : id)), 1200)
    window.setTimeout(() => (el as HTMLElement).focus({ preventScroll: true }), 350)
  }

  const submit = async (skipOtpCheck = false) => {
    if (!ready || !signature) return
    // Email OTP: verify first, then this runs again automatically (onVerified).
    if (data.otp.required && !otpVerified && !skipOtpCheck) {
      setError(null)
      setOtpOpen(true)
      return
    }
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
        setSubmitting(false)
        if (res.status === 403 && data.otp.required) {
          // Verification expired (30 min) or missing: ask again.
          setOtpVerified(false)
          setOtpOpen(true)
          return
        }
        setError(json?.error ?? '서명을 제출하지 못했습니다. 다시 시도해 주세요.')
        return
      }
      await onDone({ completed: !!json?.completed })
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
          const style: Box = {
            left: f.x * size.width,
            top: f.y * size.height,
            width: f.w * size.width,
            height: f.h * size.height,
          }
          if (!f.mine) return <OtherField key={f.id} f={f} style={style} />
          const flash = flashId === f.id || editingId === f.id ? 'ring-4 ring-[var(--accent)]/40' : ''
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
          // Small boxes are not edited in place: tapping opens the bottom-sheet editor with a full-size input.
          const label = fieldLabel(f)
          const v = values[f.id] ?? ''
          return (
            <button
              key={f.id}
              id={`field-${f.id}`}
              type="button"
              onClick={() => openEditor(f.id)}
              aria-label={`${label} 입력${v ? `: ${v}` : ''}`}
              aria-haspopup="dialog"
              className={`${boxCls} block overflow-hidden px-1 text-left outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent)]/40`}
              style={style}
            >
              <FitText text={v || label} boxHeight={f.h * size.height} className={v ? 'text-[var(--fg)]' : 'text-[var(--accent)]/60'} />
            </button>
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

      {editingId && (
        <FieldSheet
          fields={textFields}
          activeId={editingId}
          values={values}
          onChange={(id, v) => setValues((prev) => ({ ...prev, [id]: v }))}
          onNavigate={openEditor}
          onClose={() => {
            const id = editingId
            setEditingId(null)
            document.getElementById(`field-${id}`)?.focus({ preventScroll: true })
          }}
        />
      )}

      {otpOpen && (
        <OtpSheet
          base={base}
          emailMasked={data.otp.email_masked}
          autoSent={otpAuto}
          onClose={() => setOtpOpen(false)}
          onVerified={() => {
            setOtpVerified(true)
            setOtpOpen(false)
            void submit(true)
          }}
        />
      )}

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
        .map((f) => {
          const style = { left: f.x * size.width, top: f.y * size.height, width: f.w * size.width, height: f.h * size.height }
          if (!f.mine || f.signed) return <OtherField key={f.id} f={f} style={style} />
          return (
            <div
              key={f.id}
              aria-hidden
              className="absolute rounded-[2px] border border-dashed border-[var(--accent)]/60 bg-[var(--accent)]/10"
              style={style}
            />
          )
        })}
    </>
  )
}

function fieldLabel(f: SignField): string {
  return f.label || (f.type === 'name' ? '이름' : f.type === 'date' ? '날짜' : '텍스트')
}

type Box = { left: number; top: number; width: number; height: number }

// A field that is not ours to fill. Once its signer has signed, show what they entered.
function OtherField({ f, style }: { f: SignField; style: Box }) {
  if (!f.signed) {
    return <div aria-hidden className="absolute rounded-[2px] border border-dashed border-neutral-300 bg-neutral-400/10" style={style} />
  }
  const cls = 'absolute overflow-hidden rounded-[2px] border border-emerald-600/40 bg-emerald-50/40'
  if (f.type === 'signature') {
    return (
      <div className={cls} style={style} title="서명 완료">
        {f.signature_png ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={f.signature_png} alt="서명 완료된 서명" className="h-full w-full object-contain" draggable={false} />
        ) : (
          <span className="sr-only">서명 완료</span>
        )}
      </div>
    )
  }
  return (
    <div className={`${cls} px-1`} style={style} title="서명 완료">
      <FitText text={f.value ?? ''} boxHeight={style.height} className="text-[var(--fg)]" />
    </div>
  )
}

// Single-line text that shrinks its font until it fits the parent box: no ellipsis, no horizontal scroll.
function FitText({ text, boxHeight, className = '' }: { text: string; boxHeight: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const base = Math.max(6, Math.min(boxHeight * 0.62, 32))
  const [size, setSize] = useState(base)
  useLayoutEffect(() => {
    const el = ref.current
    const box = el?.parentElement
    if (!el || !box) return
    el.style.fontSize = `${base}px`
    const cs = getComputedStyle(box)
    const avail = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const need = el.scrollWidth
    const fitted = need > avail && need > 0 ? Math.max(1, Math.floor(((base * avail) / need) * 10) / 10) : base
    el.style.fontSize = `${fitted}px`
    setSize(fitted)
  }, [text, base])
  return (
    <span ref={ref} className={`flex h-full w-max items-center whitespace-nowrap ${className}`} style={{ fontSize: size, lineHeight: 1 }}>
      {text}
    </span>
  )
}

// Bottom-sheet editor for text/name/date fields: full-size input (16px, 48px tall) with previous/next navigation.
function FieldSheet({
  fields,
  activeId,
  values,
  onChange,
  onNavigate,
  onClose,
}: {
  fields: SignField[]
  activeId: string
  values: Record<string, string>
  onChange: (id: string, value: string) => void
  onNavigate: (id: string) => void
  onClose: () => void
}) {
  const idx = Math.max(0, fields.findIndex((f) => f.id === activeId))
  const f = fields[idx]
  const prev = fields[idx - 1]
  const next = fields[idx + 1]
  const inputRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // Keep the sheet above the on-screen keyboard (iOS does not shrink the layout viewport).
  const [kb, setKb] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setKb(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [activeId])
  if (!f) return null
  const label = fieldLabel(f)
  const navBtn =
    'inline-flex min-h-12 min-w-[4.5rem] items-center justify-center rounded-md border border-[var(--line)] bg-white px-3 text-sm font-medium text-[var(--fg)] hover:bg-neutral-50 disabled:opacity-40'
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/15" aria-hidden onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="field-sheet-title"
        className="fixed inset-x-0 z-50 border-t border-[var(--line)] bg-white shadow-[0_-4px_24px_rgba(0,0,0,0.12)] sm:mx-auto sm:mb-4 sm:max-w-xl sm:rounded-xl sm:border"
        style={{ bottom: kb }}
      >
        <form
          className="flex flex-col gap-3 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          onSubmit={(e) => {
            e.preventDefault()
            if (next) onNavigate(next.id)
            else onClose()
          }}
        >
          <div className="flex items-center justify-between">
            <label id="field-sheet-title" htmlFor="field-sheet-input" className="text-sm font-semibold">
              {label}
              <span className="ml-2 text-xs font-normal text-[var(--muted)] tabular-nums">
                {idx + 1}/{fields.length}
              </span>
            </label>
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
          <input
            ref={inputRef}
            id="field-sheet-input"
            type="text"
            value={values[f.id] ?? ''}
            onChange={(e) => onChange(f.id, e.target.value)}
            placeholder={f.type === 'date' ? 'YYYY-MM-DD' : label}
            maxLength={500}
            inputMode={f.type === 'date' ? 'numeric' : undefined}
            autoComplete={f.type === 'name' ? 'name' : 'off'}
            enterKeyHint={next ? 'next' : 'done'}
            className="min-h-12 w-full rounded-md border border-[var(--line)] bg-white px-3 text-[16px] text-[var(--fg)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/30"
          />
          <div className="flex items-center gap-2">
            <button type="button" className={navBtn} disabled={!prev} onClick={() => prev && onNavigate(prev.id)}>
              이전
            </button>
            <button type="button" className={navBtn} disabled={!next} onClick={() => next && onNavigate(next.id)}>
              다음
            </button>
            <button type="button" className={`${primaryBtn} ml-auto`} onClick={onClose}>
              완료
            </button>
          </div>
        </form>
      </div>
    </>
  )
}

// Bottom sheet for the email OTP: request a code, enter 6 digits, confirm. Stays above the on-screen keyboard.
function OtpSheet({
  base,
  emailMasked,
  autoSent,
  onVerified,
  onClose,
}: {
  base: string
  emailMasked: string
  autoSent: { at: number; resendIn: number; expiresIn: number } | null
  onVerified: () => void
  onClose: () => void
}) {
  // If a code went out automatically when signing started and has not expired, open in the "sent" state.
  const autoElapsed = autoSent ? Math.floor((Date.now() - autoSent.at) / 1000) : 0
  const autoValid = !!autoSent && autoElapsed < autoSent.expiresIn
  const [sent, setSent] = useState(autoValid)
  const [cooldown, setCooldown] = useState(autoValid && autoSent ? Math.max(0, autoSent.resendIn - autoElapsed) : 0)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'send' | 'verify' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(
    autoValid
      ? '서명을 시작할 때 인증번호를 메일로 보냈습니다. 메일함(스팸함 포함)을 확인하세요. 5분간 유효하며, 만료되면 다시 받을 수 있습니다.'
      : autoSent
        ? '앞서 보낸 인증번호가 만료되었습니다. 새 인증번호를 받아 주세요.'
        : null,
  )
  useEffect(() => {
    if (autoValid) window.setTimeout(() => inputRef.current?.focus(), 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const inputRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [kb, setKb] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setKb(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (cooldown <= 0) return
    const t = window.setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000)
    return () => window.clearTimeout(t)
  }, [cooldown])

  const send = async () => {
    if (busy || cooldown > 0) return
    setBusy('send')
    setError(null)
    setInfo(null)
    try {
      const res = await fetch(`${base}/otp`, { method: 'POST' })
      const json = await res.json().catch(() => null)
      if (typeof json?.retry_after === 'number') setCooldown(json.retry_after)
      if (!res.ok) {
        setError(json?.error ?? '인증번호를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.')
        return
      }
      setSent(true)
      setCode('')
      setCooldown(typeof json?.resend_in === 'number' ? json.resend_in : 30)
      setInfo('인증번호를 보냈습니다. 메일함(스팸함 포함)을 확인하세요. 5분간 유효합니다.')
      window.setTimeout(() => inputRef.current?.focus(), 0)
    } catch {
      setError('네트워크 오류로 인증번호를 보내지 못했습니다.')
    } finally {
      setBusy(null)
    }
  }

  const verify = async () => {
    if (busy || code.length !== 6) return
    setBusy('verify')
    setError(null)
    try {
      const res = await fetch(`${base}/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        onVerified()
        return
      }
      setError(json?.error ?? '인증에 실패했습니다. 다시 시도해 주세요.')
      if (res.status === 410 || res.status === 429) {
        // Code is no longer usable: a new one is needed.
        setCode('')
        setInfo(null)
      } else {
        inputRef.current?.select()
      }
    } catch {
      setError('네트워크 오류로 확인하지 못했습니다. 다시 시도해 주세요.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/25" aria-hidden onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="otp-sheet-title"
        className="fixed inset-x-0 z-50 border-t border-[var(--line)] bg-white shadow-[0_-4px_24px_rgba(0,0,0,0.12)] sm:mx-auto sm:mb-4 sm:max-w-xl sm:rounded-xl sm:border"
        style={{ bottom: kb }}
      >
        <form
          className="flex flex-col gap-3 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          onSubmit={(e) => {
            e.preventDefault()
            void verify()
          }}
        >
          <div className="flex items-center justify-between">
            <h2 id="otp-sheet-title" className="text-base font-semibold">
              이메일 본인 확인
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
          <p className="text-sm leading-relaxed text-[var(--muted)]">
            서명 전에 본인 확인이 필요합니다. <span className="font-medium text-[var(--fg)]">{emailMasked}</span>로 6자리 인증번호를
            보내드립니다.
          </p>
          <div className="flex items-center gap-2">
            <label htmlFor="otp-input" className="sr-only">
              인증번호 6자리
            </label>
            <input
              ref={inputRef}
              id="otp-input"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="인증번호 6자리"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              enterKeyHint="done"
              maxLength={6}
              aria-invalid={!!error}
              aria-describedby="otp-status"
              className="min-h-12 min-w-0 flex-1 rounded-md border border-[var(--line)] bg-white px-3 text-[20px] tracking-[0.3em] tabular-nums text-[var(--fg)] outline-none placeholder:text-[16px] placeholder:tracking-normal focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/30"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy !== null || cooldown > 0}
              className={`${secondaryBtn} shrink-0 tabular-nums disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {busy === 'send' ? '보내는 중...' : cooldown > 0 ? `재전송 ${cooldown}초` : sent ? '다시 받기' : '인증번호 받기'}
            </button>
          </div>
          <div id="otp-status" aria-live="polite" className="min-h-5 text-sm">
            {error ? <p className="text-red-700">{error}</p> : info ? <p className="text-[var(--muted)]">{info}</p> : null}
          </div>
          <button type="submit" disabled={busy !== null || code.length !== 6} className={`${primaryBtn} w-full`}>
            {busy === 'verify' ? '확인 중...' : '확인'}
          </button>
        </form>
      </div>
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
          <dd className="font-medium">{DOC_STATUS_LABEL[doc.status]}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-[var(--muted)]">내 상태</dt>
          <dd className="font-medium">{SIGNER_STATUS_LABEL[signer.status]}</dd>
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
