'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import PdfPages from '@/components/PdfPages'
import type { DocumentBundle, FieldType } from '@/lib/types'
import { signerColor } from './format'

// ---------- types & constants ----------

interface EdSigner {
  key: string
  id?: string
  name: string
  email: string
  is_owner: boolean
}

interface EdField {
  key: string
  signerKey: string
  page: number
  x: number
  y: number
  w: number
  h: number
  type: FieldType
  label: string | null
}

const TYPES: FieldType[] = ['signature', 'name', 'date', 'text']
const TYPE_LABEL: Record<FieldType, string> = { signature: '서명', name: '이름', date: '날짜', text: '텍스트' }
const DEFAULT_SIZE: Record<FieldType, { w: number; h: number }> = {
  signature: { w: 0.22, h: 0.06 },
  name: { w: 0.18, h: 0.03 },
  date: { w: 0.18, h: 0.03 },
  text: { w: 0.18, h: 0.03 },
}
const MIN_W = 0.03
const MIN_H = 0.015
const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/

let seq = 0
const uid = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function fromBundle(bundle: DocumentBundle, owner: { name: string; email: string }) {
  let signers: EdSigner[] = bundle.signers.map((s) => ({
    key: s.id,
    id: s.id,
    name: s.name,
    email: s.email,
    is_owner: s.is_owner === 1,
  }))
  if (signers.length === 0) signers = [{ key: 'owner-init', name: owner.name, email: owner.email, is_owner: true }]
  const fields: EdField[] = bundle.fields.map((f) => ({
    key: f.id,
    signerKey: f.signer_id,
    page: f.page,
    x: f.x,
    y: f.y,
    w: f.w,
    h: f.h,
    type: f.type,
    label: f.label,
  }))
  return { signers, fields }
}

type Drag = {
  key: string
  mode: 'move' | 'resize'
  sx: number
  sy: number
  orig: { x: number; y: number; w: number; h: number }
  pw: number
  ph: number
  moved: boolean
}

// ---------- component ----------

export default function FieldEditor({
  bundle,
  owner,
}: {
  bundle: DocumentBundle
  owner: { name: string; email: string }
}) {
  const router = useRouter()
  const docId = bundle.document.id
  const initial = useMemo(() => fromBundle(bundle, owner), []) // eslint-disable-line react-hooks/exhaustive-deps

  const [title, setTitle] = useState(bundle.document.title)
  const [message, setMessage] = useState(bundle.document.message ?? '')
  const [signers, setSigners] = useState<EdSigner[]>(initial.signers)
  const [fields, setFields] = useState<EdField[]>(initial.fields)
  const [activeKey, setActiveKey] = useState<string>(initial.signers[0]?.key ?? '')
  const [tool, setTool] = useState<FieldType | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [pageCount, setPageCount] = useState<number>(bundle.document.page_count)
  const [busy, setBusy] = useState<'save' | 'send' | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const drag = useRef<Drag | null>(null)

  const signerIndex = useCallback((key: string) => signers.findIndex((s) => s.key === key), [signers])
  const colorOf = (key: string) => signerColor(Math.max(0, signerIndex(key)))
  const nameOf = (key: string) => {
    const i = signerIndex(key)
    const s = signers[i]
    return s?.name.trim() || `서명자 ${i + 1}`
  }
  const active = signers.find((s) => s.key === activeKey) ?? signers[0]
  const selectedField = fields.find((f) => f.key === selected) ?? null

  const touch = () => {
    setDirty(true)
    setNotice(null)
  }

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  // ----- field ops -----

  const updateField = (key: string, patch: Partial<EdField>) =>
    setFields((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)))

  const deleteField = useCallback((key: string) => {
    setFields((fs) => fs.filter((f) => f.key !== key))
    setSelected((s) => (s === key ? null : s))
    setDirty(true)
  }, [])

  // Keyboard: Delete/Backspace removes, arrows nudge, Escape clears tool/selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.key === 'Escape') {
        setTool(null)
        setSelected(null)
        return
      }
      if (!selected) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteField(selected)
        return
      }
      const step = e.shiftKey ? 0.01 : 0.002
      const d =
        e.key === 'ArrowLeft' ? [-step, 0] : e.key === 'ArrowRight' ? [step, 0] : e.key === 'ArrowUp' ? [0, -step] : e.key === 'ArrowDown' ? [0, step] : null
      if (!d) return
      e.preventDefault()
      setFields((fs) =>
        fs.map((f) => (f.key === selected ? { ...f, x: clamp(f.x + d[0], 0, 1 - f.w), y: clamp(f.y + d[1], 0, 1 - f.h) } : f)),
      )
      setDirty(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, deleteField])

  function placeField(page: number, px: number, py: number) {
    if (!tool || !active) return
    const { w, h } = DEFAULT_SIZE[tool]
    const f: EdField = {
      key: uid(),
      signerKey: active.key,
      page,
      x: clamp(px - w / 2, 0, 1 - w),
      y: clamp(py - h / 2, 0, 1 - h),
      w,
      h,
      type: tool,
      label: null,
    }
    setFields((fs) => [...fs, f])
    setSelected(f.key)
    setTool(null)
    touch()
  }

  function startDrag(e: React.PointerEvent, f: EdField, mode: Drag['mode'], size: { width: number; height: number }) {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setSelected(f.key)
    drag.current = {
      key: f.key,
      mode,
      sx: e.clientX,
      sy: e.clientY,
      orig: { x: f.x, y: f.y, w: f.w, h: f.h },
      pw: size.width,
      ph: size.height,
      moved: false,
    }
  }

  function onDragMove(e: React.PointerEvent) {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.sx) / d.pw
    const dy = (e.clientY - d.sy) / d.ph
    if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 3) return
    d.moved = true
    const o = d.orig
    if (d.mode === 'move') {
      updateField(d.key, { x: clamp(o.x + dx, 0, 1 - o.w), y: clamp(o.y + dy, 0, 1 - o.h) })
    } else {
      updateField(d.key, { w: clamp(o.w + dx, MIN_W, 1 - o.x), h: clamp(o.h + dy, MIN_H, 1 - o.y) })
    }
  }

  function endDrag(e: React.PointerEvent) {
    const d = drag.current
    if (!d) return
    try {
      ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
    } catch {}
    if (d.moved) touch()
    drag.current = null
  }

  // ----- signer ops -----

  function addSigner() {
    const s: EdSigner = { key: uid(), name: '', email: '', is_owner: false }
    setSigners((ss) => [...ss, s])
    setActiveKey(s.key)
    touch()
  }

  function addOwner() {
    const s: EdSigner = { key: uid(), name: owner.name, email: owner.email, is_owner: true }
    setSigners((ss) => [s, ...ss])
    setActiveKey(s.key)
    touch()
  }

  function removeSigner(key: string) {
    const n = fields.filter((f) => f.signerKey === key).length
    if (n > 0 && !window.confirm(`이 서명자에게 배치된 필드 ${n}개도 함께 삭제됩니다. 계속할까요?`)) return
    const rest = signers.filter((s) => s.key !== key)
    setSigners(rest)
    setFields((fs) => fs.filter((f) => f.signerKey !== key))
    if (selectedField?.signerKey === key) setSelected(null)
    if (activeKey === key) setActiveKey(rest[0]?.key ?? '')
    touch()
  }

  function moveSigner(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= signers.length) return
    setSigners((ss) => {
      const next = [...ss]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
    touch()
  }

  const updateSigner = (key: string, patch: Partial<EdSigner>) => {
    setSigners((ss) => ss.map((s) => (s.key === key ? { ...s, ...patch } : s)))
    touch()
  }

  // ----- validation & persistence -----

  function validate(forSend: boolean): string[] {
    const errs: string[] = []
    if (!title.trim()) errs.push('문서 제목을 입력해 주세요.')
    if (signers.length === 0) errs.push('서명자를 1명 이상 추가해 주세요.')
    if (signers.filter((s) => s.is_owner).length > 1) errs.push('본인(나)은 한 번만 지정할 수 있습니다.')
    const seen = new Set<string>()
    signers.forEach((s, i) => {
      const label = `${i + 1}번 서명자${s.name.trim() ? `(${s.name.trim()})` : ''}`
      if (!s.name.trim()) errs.push(`${i + 1}번 서명자의 이름을 입력해 주세요.`)
      if (!EMAIL_RE.test(s.email.trim())) errs.push(`${label}의 이메일 주소가 올바르지 않습니다.`)
      const k = s.email.trim().toLowerCase()
      if (k && seen.has(k)) errs.push(`${label}의 이메일 주소가 다른 서명자와 중복됩니다.`)
      seen.add(k)
      if (forSend && !fields.some((f) => f.signerKey === s.key && f.type === 'signature'))
        errs.push(`${label}에게 서명 필드를 1개 이상 배치해 주세요.`)
    })
    return errs
  }

  async function save(): Promise<boolean> {
    const payload = {
      title: title.trim(),
      message: message.trim() || null,
      signers: signers.map((s, i) => ({
        ...(s.id ? { id: s.id } : {}),
        name: s.name.trim(),
        email: s.email.trim(),
        is_owner: s.is_owner,
        order_index: i,
      })),
      fields: fields
        .filter((f) => f.page <= pageCount)
        .map((f) => ({
          signer_ref: signerIndex(f.signerKey),
          page: f.page,
          x: f.x,
          y: f.y,
          w: f.w,
          h: f.h,
          type: f.type,
          label: f.label?.trim() || null,
        }))
        .filter((f) => f.signer_ref >= 0),
    }
    const res = await fetch(`/api/admin/documents/${docId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.status === 401) {
      window.location.assign(`/login?next=/admin/documents/${docId}/edit`)
      return false
    }
    const data = (await res.json().catch(() => null)) as (DocumentBundle & { error?: string }) | null
    if (!res.ok || !data?.document) {
      setErrors([data?.error ?? '저장에 실패했습니다.'])
      return false
    }
    // Re-key from server ids so later saves update the same rows.
    const activeIdx = Math.max(0, signerIndex(activeKey))
    const next = fromBundle(data, owner)
    setSigners(next.signers)
    setFields(next.fields)
    setActiveKey(next.signers[activeIdx]?.key ?? next.signers[0]?.key ?? '')
    setSelected(null)
    setTitle(data.document.title)
    setMessage(data.document.message ?? '')
    setDirty(false)
    return true
  }

  async function onSave() {
    setNotice(null)
    const errs = validate(false)
    setErrors(errs)
    if (errs.length) return
    setBusy('save')
    try {
      if (await save()) setNotice('저장했습니다.')
    } catch {
      setErrors(['네트워크 오류가 발생했습니다.'])
    }
    setBusy(null)
  }

  async function onSend() {
    setNotice(null)
    const errs = validate(true)
    setErrors(errs)
    if (errs.length) return
    const first = signers[0]
    const firstDesc = first.is_owner ? '첫 서명자는 본인(나)이므로 발송 후 바로 서명할 수 있습니다.' : `${first.name.trim()}님에게 먼저 서명 요청이 발송됩니다.`
    if (!window.confirm(`발송하면 문서와 서명 위치를 더 이상 수정할 수 없습니다.\n${firstDesc}\n\n발송할까요?`)) return
    setBusy('send')
    try {
      if (!(await save())) {
        setBusy(null)
        return
      }
      const res = await fetch(`/api/admin/documents/${docId}/send`, { method: 'POST' })
      const data = (await res.json().catch(() => null)) as { notified?: unknown; error?: string } | null
      if (!res.ok) {
        setErrors([data?.error ?? '발송에 실패했습니다. 저장은 완료되었습니다.'])
        setBusy(null)
        return
      }
      try {
        sessionStorage.setItem(`esign:notified:${docId}`, JSON.stringify(data?.notified ?? []))
      } catch {}
      router.push(`/admin/documents/${docId}?sent=1`)
      router.refresh()
    } catch {
      setErrors(['네트워크 오류가 발생했습니다.'])
      setBusy(null)
    }
  }

  // ----- render helpers -----

  const counts = useMemo(() => {
    const m = new Map<string, { sig: number; other: number }>()
    for (const f of fields) {
      const c = m.get(f.signerKey) ?? { sig: 0, other: 0 }
      if (f.type === 'signature') c.sig++
      else c.other++
      m.set(f.signerKey, c)
    }
    return m
  }, [fields])

  const renderOverlay = (page: number, size: { width: number; height: number }) => (
    <div
      className="absolute inset-0"
      style={{ cursor: tool ? 'crosshair' : 'default' }}
      onClick={(e) => {
        if (!tool) {
          setSelected(null)
          return
        }
        const r = e.currentTarget.getBoundingClientRect()
        placeField(page, (e.clientX - r.left) / size.width, (e.clientY - r.top) / size.height)
      }}
    >
      {fields
        .filter((f) => f.page === page)
        .map((f) => {
          const color = colorOf(f.signerKey)
          const isSel = f.key === selected
          const name = nameOf(f.signerKey)
          return (
            <div
              key={f.key}
              role="button"
              tabIndex={0}
              aria-label={`${name} ${TYPE_LABEL[f.type]} 필드${isSel ? ', 선택됨' : ''}`}
              aria-pressed={isSel}
              onFocus={() => setSelected(f.key)}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => startDrag(e, f, 'move', size)}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className="group absolute select-none outline-none"
              style={{
                left: f.x * size.width,
                top: f.y * size.height,
                width: f.w * size.width,
                height: f.h * size.height,
                border: `${isSel ? 2 : 1.5}px ${isSel ? 'solid' : 'dashed'} ${color}`,
                background: `${color}1f`,
                borderRadius: 3,
                cursor: 'move',
                touchAction: 'none',
                boxShadow: isSel ? `0 0 0 3px ${color}33` : undefined,
                zIndex: isSel ? 2 : 1,
              }}
            >
              <span
                className="pointer-events-none absolute inset-0 flex items-center overflow-hidden px-1 text-[11px] leading-none font-medium whitespace-nowrap"
                style={{ color }}
              >
                {TYPE_LABEL[f.type]}
                {f.label ? `: ${f.label}` : ''} · {name}
              </span>
              {isSel && (
                <>
                  <button
                    type="button"
                    aria-label="필드 삭제"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteField(f.key)
                    }}
                    className="absolute -top-3 -right-3 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--line)] bg-white text-sm leading-none text-neutral-600 shadow hover:text-red-700"
                  >
                    ×
                  </button>
                  <span
                    role="presentation"
                    onPointerDown={(e) => startDrag(e, f, 'resize', size)}
                    className="absolute -right-2 -bottom-2 flex h-5 w-5 items-center justify-center"
                    style={{ cursor: 'nwse-resize', touchAction: 'none' }}
                  >
                    <span className="block h-2.5 w-2.5 rounded-sm border-2 bg-white" style={{ borderColor: color }} />
                  </span>
                </>
              )}
            </div>
          )
        })}
    </div>
  )

  const input =
    'w-full rounded-md border border-[var(--line)] bg-white px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20'
  const hasOwner = signers.some((s) => s.is_owner)

  return (
    <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
      {/* ---------- side panel ---------- */}
      <aside className="space-y-5 lg:sticky lg:top-[4.5rem] lg:max-h-[calc(100vh-5.5rem)] lg:self-start lg:overflow-y-auto lg:pr-1">
        <section className="rounded-lg border border-[var(--line)] bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold">문서</h2>
          <label htmlFor="doc-title" className="mb-1 block text-xs text-[var(--muted)]">
            제목
          </label>
          <input
            id="doc-title"
            value={title}
            maxLength={200}
            onChange={(e) => {
              setTitle(e.target.value)
              touch()
            }}
            className={input}
          />
          <label htmlFor="doc-message" className="mt-3 mb-1 block text-xs text-[var(--muted)]">
            서명자에게 전할 메시지 (선택)
          </label>
          <textarea
            id="doc-message"
            value={message}
            maxLength={2000}
            rows={2}
            onChange={(e) => {
              setMessage(e.target.value)
              touch()
            }}
            className={`${input} resize-y`}
          />
        </section>

        <section className="rounded-lg border border-[var(--line)] bg-white p-4" aria-labelledby="signers-h">
          <div className="mb-1 flex items-center justify-between">
            <h2 id="signers-h" className="text-sm font-semibold">
              서명자 <span className="font-normal text-[var(--muted)]">(서명 순서)</span>
            </h2>
          </div>
          <p className="mb-3 text-xs text-[var(--muted)]">위에서부터 순서대로 서명합니다.</p>
          <ol className="space-y-3">
            {signers.map((s, i) => {
              const c = counts.get(s.key) ?? { sig: 0, other: 0 }
              const color = signerColor(i)
              const isActive = s.key === active?.key
              return (
                <li
                  key={s.key}
                  className={`rounded-md border p-2.5 ${isActive ? 'border-[var(--accent)]/50 bg-neutral-50' : 'border-[var(--line)]'}`}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
                    <span className="text-xs font-medium tabular-nums">{i + 1}</span>
                    {s.is_owner && (
                      <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">나</span>
                    )}
                    <span className={`text-xs ${c.sig === 0 ? 'text-amber-700' : 'text-[var(--muted)]'}`}>
                      서명 {c.sig}
                      {c.other > 0 ? ` · 기타 ${c.other}` : ''}
                    </span>
                    <span className="ml-auto flex items-center">
                      <IconBtn label={`${i + 1}번 서명자 위로`} disabled={i === 0} onClick={() => moveSigner(i, -1)}>
                        <path d="M6 15l6-6 6 6" />
                      </IconBtn>
                      <IconBtn label={`${i + 1}번 서명자 아래로`} disabled={i === signers.length - 1} onClick={() => moveSigner(i, 1)}>
                        <path d="M6 9l6 6 6-6" />
                      </IconBtn>
                      <IconBtn label={`${i + 1}번 서명자 삭제`} onClick={() => removeSigner(s.key)}>
                        <path d="M6 6l12 12M18 6L6 18" />
                      </IconBtn>
                    </span>
                  </div>
                  <div className="grid gap-1.5">
                    <input
                      aria-label={`${i + 1}번 서명자 이름`}
                      placeholder="이름"
                      value={s.name}
                      maxLength={100}
                      onChange={(e) => updateSigner(s.key, { name: e.target.value })}
                      onFocus={() => setActiveKey(s.key)}
                      className={input}
                    />
                    <input
                      aria-label={`${i + 1}번 서명자 이메일`}
                      placeholder="이메일"
                      type="email"
                      inputMode="email"
                      autoComplete="off"
                      value={s.email}
                      maxLength={254}
                      onChange={(e) => updateSigner(s.key, { email: e.target.value })}
                      onFocus={() => setActiveKey(s.key)}
                      className={input}
                    />
                  </div>
                </li>
              )
            })}
          </ol>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={addSigner}
              disabled={signers.length >= 20}
              className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50"
            >
              서명자 추가
            </button>
            {!hasOwner && (
              <button
                type="button"
                onClick={addOwner}
                className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-neutral-50"
              >
                나를 서명자로 추가
              </button>
            )}
          </div>
        </section>

        {selectedField && (
          <section className="rounded-lg border border-[var(--line)] bg-white p-4" aria-labelledby="field-h">
            <h2 id="field-h" className="mb-3 text-sm font-semibold">
              선택한 필드 <span className="font-normal text-[var(--muted)]">· {selectedField.page}페이지</span>
            </h2>
            <div className="grid gap-2.5">
              <div>
                <label htmlFor="field-type" className="mb-1 block text-xs text-[var(--muted)]">
                  종류
                </label>
                <select
                  id="field-type"
                  value={selectedField.type}
                  onChange={(e) => {
                    updateField(selectedField.key, { type: e.target.value as FieldType })
                    touch()
                  }}
                  className={input}
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="field-signer" className="mb-1 block text-xs text-[var(--muted)]">
                  서명자
                </label>
                <select
                  id="field-signer"
                  value={selectedField.signerKey}
                  onChange={(e) => {
                    updateField(selectedField.key, { signerKey: e.target.value })
                    touch()
                  }}
                  className={input}
                >
                  {signers.map((s, i) => (
                    <option key={s.key} value={s.key}>
                      {i + 1}. {s.name.trim() || `서명자 ${i + 1}`}
                      {s.is_owner ? ' (나)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              {selectedField.type === 'text' && (
                <div>
                  <label htmlFor="field-label" className="mb-1 block text-xs text-[var(--muted)]">
                    항목 이름 (예: 회사명, 주소)
                  </label>
                  <input
                    id="field-label"
                    value={selectedField.label ?? ''}
                    maxLength={100}
                    onChange={(e) => {
                      updateField(selectedField.key, { label: e.target.value })
                      touch()
                    }}
                    className={input}
                  />
                </div>
              )}
              <button
                type="button"
                onClick={() => deleteField(selectedField.key)}
                className="justify-self-start rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
              >
                필드 삭제
              </button>
              <p className="text-xs text-[var(--muted)]">끌어서 이동, 오른쪽 아래 모서리로 크기 조절. 방향키로 미세 이동, Delete 키로 삭제.</p>
            </div>
          </section>
        )}

        <section className="space-y-2">
          {errors.length > 0 && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <ul className="list-disc space-y-0.5 pl-4">
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {notice && (
            <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              {notice}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onSave}
              disabled={busy !== null}
              className="flex-1 rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
            >
              {busy === 'save' ? '저장 중...' : dirty ? '저장' : '저장됨'}
            </button>
            <button
              type="button"
              onClick={onSend}
              disabled={busy !== null}
              className="flex-1 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'send' ? '발송 중...' : '저장 후 발송'}
            </button>
          </div>
        </section>
      </aside>

      {/* ---------- canvas ---------- */}
      <div className="min-w-0">
        <div
          role="toolbar"
          aria-label="필드 배치 도구"
          className="sticky top-14 z-20 -mx-4 mb-4 border-b border-[var(--line)] bg-[var(--bg)]/95 px-4 py-2.5 backdrop-blur lg:mx-0 lg:rounded-lg lg:border lg:bg-white/95"
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <label htmlFor="active-signer" className="text-xs text-[var(--muted)]">
                배치 대상
              </label>
              <span className="h-3 w-3 rounded-full" style={{ background: active ? colorOf(active.key) : '#999' }} aria-hidden />
              <select
                id="active-signer"
                value={active?.key ?? ''}
                onChange={(e) => setActiveKey(e.target.value)}
                className="max-w-[12rem] rounded-md border border-[var(--line)] bg-white px-2 py-1 text-sm"
              >
                {signers.map((s, i) => (
                  <option key={s.key} value={s.key}>
                    {i + 1}. {s.name.trim() || `서명자 ${i + 1}`}
                    {s.is_owner ? ' (나)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1" role="group" aria-label="필드 종류">
              {TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={tool === t}
                  disabled={!active}
                  onClick={() => setTool((cur) => (cur === t ? null : t))}
                  className={`rounded-md border px-3 py-1 text-sm transition disabled:opacity-50 ${
                    tool === t
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                      : 'border-[var(--line)] bg-white hover:bg-neutral-50'
                  }`}
                >
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
            <p className="text-xs text-[var(--muted)]" aria-live="polite">
              {tool
                ? `페이지를 클릭해 ${active ? nameOf(active.key) : ''}의 ${TYPE_LABEL[tool]} 필드를 놓으세요. (Esc 취소)`
                : '필드 종류를 고른 뒤 페이지를 클릭하세요.'}
            </p>
          </div>
        </div>

        <PdfPages
          url={`/api/admin/documents/${docId}/file?kind=original`}
          maxWidth={880}
          onLoaded={setPageCount}
          renderOverlay={renderOverlay}
        />
      </div>
    </div>
  )
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  )
}
