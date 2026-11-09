'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { DocumentBundle, EventRow, EventType, SignerRow } from '@/lib/types'
import StatusBadge from './StatusBadge'
import { fmtDateTime, signerColor, signerStatusLabel } from './format'

type Notified = { signerId: string; link: string; emailed: boolean }
type NotifiedKind = 'request' | 'completed'

// Signer ids whose most recent email attempt failed (an email_failed newer than their last email_sent).
function failedEmailSigners(events: EventRow[]): Set<string> {
  const last = new Map<string, { type: EventType; at: string; idx: number }>()
  events.forEach((e, idx) => {
    if (!e.signer_id || (e.type !== 'email_sent' && e.type !== 'email_failed')) return
    const prev = last.get(e.signer_id)
    if (!prev || e.at > prev.at || (e.at === prev.at && idx > prev.idx)) last.set(e.signer_id, { type: e.type, at: e.at, idx })
  })
  return new Set([...last].filter(([, v]) => v.type === 'email_failed').map(([id]) => id))
}

const EVENT_LABEL: Record<EventType, string> = {
  created: '문서 생성',
  sent: '발송',
  email_sent: '이메일 발송',
  email_failed: '이메일 발송 실패',
  viewed: '열람',
  signed: '서명',
  completed: '서명 완료 및 날인본 생성',
  voided: '무효 처리',
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

function CopyButton({
  text,
  label = '링크 복사',
  className = '',
  highlight = false,
}: {
  text: string
  label?: string
  className?: string
  highlight?: boolean
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  return (
    <button
      type="button"
      onClick={async () => {
        setState((await copyText(text)) ? 'ok' : 'fail')
        setTimeout(() => setState('idle'), 1800)
      }}
      className={`rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
        highlight
          ? 'border-amber-400 bg-amber-100 text-amber-900 ring-2 ring-amber-300 hover:bg-amber-200'
          : 'border-[var(--line)] bg-white hover:bg-neutral-50'
      } ${className}`}
    >
      <span aria-live="polite">{state === 'ok' ? '복사됨' : state === 'fail' ? '복사 실패' : label}</span>
    </button>
  )
}

export default function DocumentDetail({ bundle, links }: { bundle: DocumentBundle; links: Record<string, string> }) {
  const router = useRouter()
  const { document: doc, signers, events } = bundle
  const [notified, setNotified] = useState<Notified[] | null>(null)
  const [notifiedKind, setNotifiedKind] = useState<NotifiedKind>('request')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Pick up the notified list handed over by the editor after "저장 후 발송".
  useEffect(() => {
    try {
      const key = `esign:notified:${doc.id}`
      const raw = sessionStorage.getItem(key)
      if (raw) {
        sessionStorage.removeItem(key)
        const v = JSON.parse(raw) as unknown
        if (Array.isArray(v)) {
          setNotifiedKind('request')
          setNotified(v as Notified[])
        }
      }
    } catch {}
  }, [doc.id])

  const byId = new Map(signers.map((s) => [s.id, s]))
  const owner = signers.find((s) => s.is_owner === 1)
  const ownerTurn =
    doc.status === 'sent' &&
    owner &&
    owner.status !== 'signed' &&
    signers.every((s) => s.order_index >= owner.order_index || s.status === 'signed')
  const signedCount = signers.filter((s) => s.status === 'signed').length
  // Everyone signed but the document never reached `completed`: sealing failed. Resend retries it server-side.
  const sealFailed = doc.status === 'sent' && signers.length > 0 && signedCount === signers.length
  const emailFailed = failedEmailSigners(events)
  const canDelete = doc.status !== 'sent'

  async function call(action: 'resend' | 'void' | 'delete') {
    setError(null)
    if (action === 'void' && !window.confirm('이 문서를 무효 처리할까요? 더 이상 서명할 수 없게 됩니다.')) return
    if (action === 'delete') {
      if (!canDelete) return
      if (doc.status === 'completed') {
        const typed = window.prompt(
          '서명이 완료된 문서입니다. 삭제하면 날인본과 모든 서명 기록이 영구히 사라집니다.\n계속하려면 "삭제"를 입력하세요.',
        )
        if (typed === null) return
        if (typed.trim() !== '삭제') {
          setError('입력이 일치하지 않아 삭제하지 않았습니다.')
          return
        }
      } else if (!window.confirm('이 문서와 모든 서명 기록을 삭제할까요? 되돌릴 수 없습니다.')) return
    }
    if (action === 'resend' && doc.status === 'completed' && !window.confirm('모든 서명자에게 완료본 이메일을 다시 보낼까요?')) return
    setBusy(action)
    try {
      const res =
        action === 'delete'
          ? await fetch(`/api/admin/documents/${doc.id}`, { method: 'DELETE' })
          : await fetch(`/api/admin/documents/${doc.id}/${action}`, { method: 'POST' })
      if (res.status === 401) {
        window.location.assign(`/login?next=/admin/documents/${doc.id}`)
        return
      }
      const data = (await res.json().catch(() => null)) as {
        error?: string
        notified?: Notified | Notified[] | null
        notifiedAll?: Notified[]
      } | null
      if (!res.ok) throw new Error(data?.error ?? '요청을 처리하지 못했습니다.')
      if (action === 'delete') {
        router.push('/admin')
        router.refresh()
        return
      }
      if (action === 'resend') {
        // Completed docs: server re-sends to every signer and returns them in notifiedAll.
        const n = data?.notified
        const list = data?.notifiedAll?.length ? data.notifiedAll : Array.isArray(n) ? n : n ? [n] : []
        if (list.length > 0) {
          setNotifiedKind(doc.status === 'completed' ? 'completed' : 'request')
          setNotified(list)
        } else if (!sealFailed) setError('알림을 보낼 서명자가 없습니다.')
      }
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다.')
    }
    setBusy(null)
  }

  const btn = 'rounded-md border border-[var(--line)] bg-white px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50'

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link href="/admin" className="text-sm text-[var(--muted)] hover:text-[var(--fg)]">
          문서 목록
        </Link>
        <div className="mt-2 flex flex-wrap items-start gap-x-3 gap-y-2">
          <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight break-words">{doc.title}</h1>
          <StatusBadge status={doc.status} />
        </div>
        <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--muted)]">
          <div>
            <dt className="inline">생성 </dt>
            <dd className="inline tabular-nums">{fmtDateTime(doc.created_at)}</dd>
          </div>
          {doc.sent_at && (
            <div>
              <dt className="inline">발송 </dt>
              <dd className="inline tabular-nums">{fmtDateTime(doc.sent_at)}</dd>
            </div>
          )}
          {doc.completed_at && (
            <div>
              <dt className="inline">완료 </dt>
              <dd className="inline tabular-nums">{fmtDateTime(doc.completed_at)}</dd>
            </div>
          )}
          <div>
            <dt className="inline">페이지 </dt>
            <dd className="inline tabular-nums">{doc.page_count}</dd>
          </div>
          <div>
            <dt className="inline">서명 </dt>
            <dd className="inline tabular-nums">
              {signedCount}/{signers.length}
            </dd>
          </div>
        </dl>
        {doc.message && (
          <p className="mt-3 rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm whitespace-pre-wrap">{doc.message}</p>
        )}
      </div>

      {ownerTurn && owner && (() => {
        const nextSigner = signers.find((s) => s.order_index > owner.order_index && s.status !== 'signed')
        return (
          <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            지금은 내 서명 차례입니다. 순차 서명이라 아직 다른 서명자에게 메일이 가지 않았습니다.
            {nextSigner ? ` 내가 서명을 마치면 ${nextSigner.name}(${nextSigner.email})님에게 서명 요청 메일이 자동 발송됩니다.` : ''}
          </p>
        )
      })()}

      {/* Primary actions */}
      <div className="flex flex-wrap gap-2">
        {ownerTurn && owner && (
          <a
            href={`/sign/${owner.token}`}
            className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            지금 서명하기
          </a>
        )}
        {doc.status === 'draft' && (
          <Link
            href={`/admin/documents/${doc.id}/edit`}
            className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            서명 위치 편집
          </Link>
        )}
        {doc.status === 'completed' && (
          <a
            href={`/api/admin/documents/${doc.id}/file?kind=signed&download=1`}
            className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            서명 완료본 다운로드
          </a>
        )}
        <a href={`/api/admin/documents/${doc.id}/file?kind=original&download=1`} className={btn}>
          원본 다운로드
        </a>
        {doc.status === 'completed' && (
          <button type="button" className={btn} disabled={busy !== null} onClick={() => call('resend')}>
            {busy === 'resend' ? '보내는 중...' : '완료본 다시 보내기'}
          </button>
        )}
        {doc.status === 'sent' && (
          <>
            {!sealFailed && (
              <button type="button" className={btn} disabled={busy !== null} onClick={() => call('resend')}>
                {busy === 'resend' ? '보내는 중...' : '알림 재발송'}
              </button>
            )}
            <button type="button" className={btn} disabled={busy !== null} onClick={() => call('void')}>
              {busy === 'void' ? '처리 중...' : '무효 처리'}
            </button>
          </>
        )}
        <span className="inline-flex items-center gap-2">
          <button
            type="button"
            disabled={busy !== null || !canDelete}
            onClick={() => call('delete')}
            aria-describedby={canDelete ? undefined : 'delete-hint'}
            title={canDelete ? undefined : '서명 진행 중인 문서는 먼저 무효 처리하세요'}
            className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
          >
            {busy === 'delete' ? '삭제 중...' : '삭제'}
          </button>
          {!canDelete && (
            <span id="delete-hint" className="text-xs text-[var(--muted)]">
              먼저 무효 처리하세요
            </span>
          )}
        </span>
      </div>

      {sealFailed && (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-red-300 bg-red-50 px-4 py-3 sm:flex-row sm:items-center">
          <p className="flex-1 text-sm text-red-800">
            <span className="font-semibold">날인본 생성 실패</span> — 모든 서명이 끝났지만 최종 PDF를 만들지 못했습니다.
          </p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => call('resend')}
            className="self-start rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50 sm:self-auto"
          >
            {busy === 'resend' ? '다시 시도하는 중...' : '다시 시도'}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {notified && (
        <NotifiedPanel notified={notified} kind={notifiedKind} byId={byId} onClose={() => setNotified(null)} />
      )}

      {/* Signers */}
      <section aria-labelledby="signers-h" className="rounded-lg border border-[var(--line)] bg-white">
        <h2 id="signers-h" className="border-b border-[var(--line)] px-4 py-3 text-sm font-semibold">
          서명자
        </h2>
        {signers.length === 0 ? (
          <p className="px-4 py-6 text-sm text-[var(--muted)]">아직 서명자가 없습니다.</p>
        ) : (
          <ol className="divide-y divide-[var(--line)]">
            {signers.map((s, i) => (
              <SignerItem
                key={s.id}
                s={s}
                i={i}
                link={links[s.id]}
                showLink={doc.status === 'sent' && s.status !== 'signed'}
                emailFailed={doc.status === 'sent' && s.status !== 'signed' && emailFailed.has(s.id)}
              />
            ))}
          </ol>
        )}
      </section>

      {/* Timeline */}
      <section aria-labelledby="events-h" className="rounded-lg border border-[var(--line)] bg-white">
        <h2 id="events-h" className="border-b border-[var(--line)] px-4 py-3 text-sm font-semibold">
          이력 <span className="font-normal text-[var(--muted)]">(한국 시간)</span>
        </h2>
        {events.length === 0 ? (
          <p className="px-4 py-6 text-sm text-[var(--muted)]">기록이 없습니다.</p>
        ) : (
          <ol className="px-4 py-3">
            {events.map((e, idx) => {
              const s = e.signer_id ? byId.get(e.signer_id) : undefined
              return (
                <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                  {idx < events.length - 1 && (
                    <span className="absolute top-3 left-[5px] h-full w-px bg-[var(--line)]" aria-hidden />
                  )}
                  <span
                    className={`relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full border-2 bg-white ${
                      e.type === 'email_failed' ? 'border-red-500' : e.type === 'completed' ? 'border-emerald-600' : 'border-[var(--accent)]'
                    }`}
                    aria-hidden
                  />
                  <div className="min-w-0 text-sm">
                    <p>
                      <span className="font-medium">{EVENT_LABEL[e.type] ?? e.type}</span>
                      {s && <span className="text-[var(--muted)]"> · {s.name}</span>}
                    </p>
                    <p className="text-xs text-[var(--muted)] tabular-nums">
                      {fmtDateTime(e.at)}
                      {e.ip ? ` · IP ${e.ip}` : ''}
                    </p>
                    {e.detail && <p className="mt-0.5 text-xs break-words text-[var(--muted)]">{e.detail}</p>}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </section>

      {doc.original_sha256 && (
        <p className="text-xs break-all text-[var(--muted)]">
          원본 SHA-256: <span className="font-mono">{doc.original_sha256}</span>
          {doc.signed_sha256 && (
            <>
              <br />
              서명본 SHA-256: <span className="font-mono">{doc.signed_sha256}</span>
            </>
          )}
        </p>
      )}
    </div>
  )
}

function SignerItem({
  s,
  i,
  link,
  showLink,
  emailFailed,
}: {
  s: SignerRow
  i: number
  link?: string
  showLink: boolean
  emailFailed: boolean
}) {
  const tone =
    s.status === 'signed' ? 'text-emerald-700' : s.status === 'viewed' ? 'text-amber-700' : 'text-[var(--muted)]'
  return (
    <li className={`flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center ${emailFailed ? 'bg-amber-50/60' : ''}`}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
          style={{ background: signerColor(i) }}
          aria-label={`${i + 1}번째 서명자`}
        >
          {i + 1}
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{s.name}</span>
            {s.is_owner === 1 && (
              <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-[10px] leading-none font-semibold text-white">나</span>
            )}
          </p>
          <p className="truncate text-xs text-[var(--muted)]">{s.email}</p>
          <p className="mt-0.5 text-xs tabular-nums">
            <span className={tone}>{signerStatusLabel(s.status, s.is_owner)}</span>
            {s.signed_at && <span className="text-[var(--muted)]"> · {fmtDateTime(s.signed_at)}</span>}
            {s.ip && <span className="text-[var(--muted)]"> · IP {s.ip}</span>}
          </p>
          {emailFailed && (
            <p role="status" className="mt-1 text-xs font-medium text-amber-800">
              메일 발송 실패 — 링크를 직접 전달하세요
            </p>
          )}
        </div>
      </div>
      {showLink && link && (
        <CopyButton
          text={link}
          highlight={emailFailed}
          className="self-start sm:self-center"
        />
      )}
    </li>
  )
}

function NotifiedPanel({
  notified,
  kind,
  byId,
  onClose,
}: {
  notified: Notified[]
  kind: NotifiedKind
  byId: Map<string, SignerRow>
  onClose: () => void
}) {
  return (
    <section aria-labelledby="notified-h" className="rounded-lg border border-[var(--accent)]/30 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="notified-h" className="text-sm font-semibold">
          알림 결과
        </h2>
        <button type="button" onClick={onClose} className="text-xs text-[var(--muted)] hover:text-[var(--fg)]">
          닫기
        </button>
      </div>
      {notified.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">알림을 받은 서명자가 없습니다.</p>
      ) : (
        <ul className="space-y-3">
          {notified.map((n) => {
            const s = byId.get(n.signerId)
            const name = s?.name ?? '서명자'
            if (kind === 'completed') {
              return n.emailed ? (
                <li key={n.signerId} className="text-sm">
                  {name}님({s?.email})에게 완료본을 이메일로 보냈습니다.
                </li>
              ) : (
                <li key={n.signerId} className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900">
                  {name}님에게 완료본 이메일을 보내지 못했습니다.
                </li>
              )
            }
            if (s?.is_owner === 1) {
              return (
                <li key={n.signerId} className="text-sm">
                  지금은 본인(나) 차례입니다{n.emailed ? ' (알림 이메일도 보냈습니다)' : ''}.{' '}
                  <a href={new URL(n.link, 'http://x').pathname} className="font-medium text-[var(--accent)] underline">
                    지금 서명하기
                  </a>
                </li>
              )
            }
            if (n.emailed) {
              return (
                <li key={n.signerId} className="text-sm">
                  {name}님({s?.email})에게 서명 요청 이메일을 보냈습니다.
                </li>
              )
            }
            return (
              <li key={n.signerId} className="rounded-md border border-amber-300 bg-amber-50 p-3">
                <p className="text-sm font-medium text-amber-900">
                  {name}님에게 이메일을 보내지 못했습니다. 아래 링크를 직접 전달해 주세요.
                </p>
                <p className="mt-1 text-xs text-amber-900/80">
                  RESEND_API_KEY가 설정되지 않았거나 이메일 발송에 실패했습니다.
                </p>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    readOnly
                    value={n.link}
                    aria-label={`${name}님 서명 링크`}
                    onFocus={(e) => e.currentTarget.select()}
                    className="min-w-0 flex-1 rounded-md border border-amber-300 bg-white px-2.5 py-1.5 font-mono text-xs"
                  />
                  <CopyButton text={n.link} className="self-start sm:self-auto" />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
