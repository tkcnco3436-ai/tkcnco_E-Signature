'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// Handwriting-like stack. Uses whatever is installed; falls back to the generic cursive family.
const HANDWRITING_FONT =
  "'Nanum Pen Script','Nanum Brush Script','Gaegu','Hi Melody','Segoe Script','Bradley Hand','Brush Script MT','Snell Roundhand',cursive"

const INK = '#111827'
const MAX_EXPORT_WIDTH = 1200

interface Pt {
  x: number
  y: number
  w: number // line width in CSS px
}

export interface SignaturePadProps {
  onAdopt: (pngDataUrl: string) => void
  onCancel?: () => void
  defaultName?: string
  adoptLabel?: string
}

type Mode = 'draw' | 'type'

export default function SignaturePad({ onAdopt, onCancel, defaultName = '', adoptLabel = '서명 적용' }: SignaturePadProps) {
  const [mode, setMode] = useState<Mode>('draw')
  const [typed, setTyped] = useState(defaultName)
  const [hasInk, setHasInk] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokes = useRef<Pt[][]>([])
  const current = useRef<Pt[] | null>(null)
  const last = useRef<{ x: number; y: number; t: number } | null>(null)
  const size = useRef({ w: 0, h: 0, dpr: 1 })

  const ctx = () => canvasRef.current?.getContext('2d') ?? null

  const drawStroke = useCallback((c: CanvasRenderingContext2D, pts: Pt[]) => {
    c.strokeStyle = INK
    c.fillStyle = INK
    c.lineCap = 'round'
    c.lineJoin = 'round'
    if (pts.length === 1) {
      c.beginPath()
      c.arc(pts[0].x, pts[0].y, pts[0].w / 2, 0, Math.PI * 2)
      c.fill()
      return
    }
    // Quadratic curves through midpoints, segment by segment so width can vary.
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1]
      const p1 = pts[i]
      const prevMid = i === 1 ? p0 : mid(pts[i - 2], p0)
      const curMid = mid(p0, p1)
      c.beginPath()
      c.lineWidth = (p0.w + p1.w) / 2
      c.moveTo(prevMid.x, prevMid.y)
      c.quadraticCurveTo(p0.x, p0.y, curMid.x, curMid.y)
      if (i === pts.length - 1) c.lineTo(p1.x, p1.y)
      c.stroke()
    }
  }, [])

  const redraw = useCallback(() => {
    const c = ctx()
    const { w, h, dpr } = size.current
    if (!c) return
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, w * dpr, h * dpr)
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (mode === 'draw') {
      for (const s of strokes.current) drawStroke(c, s)
      if (current.current) drawStroke(c, current.current)
    } else {
      const text = typed.trim()
      if (!text) return
      let fontSize = Math.min(h * 0.55, 96)
      c.font = `${fontSize}px ${HANDWRITING_FONT}`
      const maxW = w * 0.88
      const measured = c.measureText(text).width
      if (measured > maxW) {
        fontSize = Math.max(14, (fontSize * maxW) / measured)
        c.font = `${fontSize}px ${HANDWRITING_FONT}`
      }
      c.fillStyle = INK
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillText(text, w / 2, h / 2)
    }
  }, [mode, typed, drawStroke])

  // Size canvas to container, DPR aware.
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const resize = () => {
      const w = wrap.clientWidth
      const h = Math.round(Math.min(Math.max(w * 0.4, 160), 260))
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      const prev = size.current
      if (prev.w && prev.w !== w) {
        // Scale stored strokes to keep the drawing when the box changes size.
        const sx = w / prev.w
        const sy = h / prev.h
        strokes.current = strokes.current.map((s) => s.map((p) => ({ x: p.x * sx, y: p.y * sy, w: p.w })))
      }
      size.current = { w, h, dpr }
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      redraw()
    }
    resize()
    let t: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(t)
      t = setTimeout(resize, 100)
    })
    ro.observe(wrap)
    return () => {
      clearTimeout(t)
      ro.disconnect()
    }
  }, [redraw])

  useEffect(() => {
    redraw()
    if (mode === 'type' && typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => redraw())
    }
  }, [redraw, mode])

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const widthFor = (e: { pointerType: string; pressure: number; timeStamp: number }, x: number, y: number) => {
    const base = Math.max(2, size.current.w / 220)
    if (e.pointerType === 'pen' && e.pressure > 0) return base * (0.5 + e.pressure * 1.2)
    const l = last.current
    if (!l) return base
    const dt = Math.max(1, e.timeStamp - l.t)
    const v = Math.hypot(x - l.x, y - l.y) / dt // px per ms
    const target = base * Math.max(0.55, Math.min(1.35, 1.35 - v * 0.35))
    const prevW = current.current?.[current.current.length - 1]?.w ?? base
    return prevW * 0.7 + target * 0.3
  }

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== 'draw') return
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const { x, y } = pos(e)
    last.current = null
    current.current = [{ x, y, w: widthFor(e, x, y) }]
    last.current = { x, y, t: e.timeStamp }
    setError(null)
    redraw()
  }

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!current.current) return
    e.preventDefault()
    const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : []
    const list = events.length ? events : [e.nativeEvent]
    const r = e.currentTarget.getBoundingClientRect()
    for (const ev of list) {
      const x = ev.clientX - r.left
      const y = ev.clientY - r.top
      const prev = current.current[current.current.length - 1]
      if (Math.hypot(x - prev.x, y - prev.y) < 1.2) continue
      const w = widthFor({ pointerType: e.pointerType, pressure: ev.pressure, timeStamp: ev.timeStamp }, x, y)
      current.current.push({ x, y, w })
      last.current = { x, y, t: ev.timeStamp }
    }
    // Incremental draw of the latest segments.
    const c = ctx()
    if (c) {
      const pts = current.current
      c.setTransform(size.current.dpr, 0, 0, size.current.dpr, 0, 0)
      drawStroke(c, pts.slice(Math.max(0, pts.length - 4)))
    }
  }

  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!current.current) return
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {}
    strokes.current.push(current.current)
    current.current = null
    last.current = null
    setHasInk(true)
    redraw()
  }

  const clear = () => {
    strokes.current = []
    current.current = null
    setHasInk(false)
    if (mode === 'type') setTyped('')
    setError(null)
    redraw()
  }

  const adopt = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (mode === 'draw' && !hasInk) return setError('서명을 그려 주세요.')
    if (mode === 'type' && !typed.trim()) return setError('이름을 입력해 주세요.')
    const png = exportTrimmedPng(canvas)
    if (!png) return setError('서명을 인식하지 못했습니다. 다시 시도해 주세요.')
    onAdopt(png)
  }

  const ready = mode === 'draw' ? hasInk : typed.trim().length > 0

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="서명 방식" className="grid grid-cols-2 rounded-md border border-[var(--line)] bg-neutral-50 p-1 text-sm">
        {(['draw', 'type'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => {
              setMode(m)
              setError(null)
            }}
            className={`min-h-11 rounded px-3 font-medium transition-colors ${
              mode === m ? 'bg-white text-[var(--fg)] shadow-sm ring-1 ring-[var(--line)]' : 'text-[var(--muted)] hover:text-[var(--fg)]'
            }`}
          >
            {m === 'draw' ? '직접 그리기' : '이름 입력'}
          </button>
        ))}
      </div>

      {mode === 'type' && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">서명으로 사용할 이름</span>
          <input
            type="text"
            value={typed}
            maxLength={40}
            autoComplete="name"
            onChange={(e) => {
              setTyped(e.target.value)
              setError(null)
            }}
            className="min-h-11 rounded-md border border-[var(--line)] bg-white px-3 text-base outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20"
          />
        </label>
      )}

      <div ref={wrapRef} className="relative w-full">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={mode === 'draw' ? '서명 입력 영역. 손가락, 펜 또는 마우스로 서명하세요.' : '입력한 이름으로 만든 서명 미리보기'}
          className={`block w-full rounded-md border border-dashed border-neutral-300 bg-white ${mode === 'draw' ? 'cursor-crosshair' : ''}`}
          style={{ touchAction: 'none' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        <div className="pointer-events-none absolute inset-x-6 bottom-8 border-b border-neutral-200" aria-hidden />
        {mode === 'draw' && !hasInk && (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-400" aria-hidden>
            여기에 서명하세요
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={clear}
          className="min-h-11 rounded-md px-4 text-sm font-medium text-[var(--muted)] hover:bg-neutral-100 hover:text-[var(--fg)]"
        >
          지우기
        </button>
        <div className="flex gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="min-h-11 rounded-md border border-[var(--line)] bg-white px-4 text-sm font-medium hover:bg-neutral-50"
            >
              취소
            </button>
          )}
          <button
            type="button"
            onClick={adopt}
            disabled={!ready}
            className="min-h-11 rounded-md bg-[var(--accent)] px-5 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {adoptLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w: (a.w + b.w) / 2 }
}

// Crop transparent margins and downscale to MAX_EXPORT_WIDTH. Returns null when the canvas is empty.
export function exportTrimmedPng(src: HTMLCanvasElement): string | null {
  const c = src.getContext('2d')
  if (!c) return null
  const { width, height } = src
  const data = c.getImageData(0, 0, width, height).data
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  const pad = Math.round(Math.max(width, height) * 0.01) + 2
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(width - 1, maxX + pad)
  maxY = Math.min(height - 1, maxY + pad)
  const cw = maxX - minX + 1
  const ch = maxY - minY + 1
  const scale = Math.min(1, MAX_EXPORT_WIDTH / cw)
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(cw * scale))
  out.height = Math.max(1, Math.round(ch * scale))
  const oc = out.getContext('2d')
  if (!oc) return null
  oc.imageSmoothingQuality = 'high'
  oc.drawImage(src, minX, minY, cw, ch, 0, 0, out.width, out.height)
  return out.toDataURL('image/png')
}
