'use client'

import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentLoadingTask, PDFPageProxy } from 'pdfjs-dist'

// Worker is served from /public (copied from node_modules/pdfjs-dist/build/pdf.worker.min.mjs).
// Keep it in sync with the installed pdfjs-dist version when upgrading.
const WORKER_SRC = '/pdf.worker.min.mjs'

export interface PdfPagesProps {
  url: string
  maxWidth?: number
  renderOverlay?: (page: number, size: { width: number; height: number }) => React.ReactNode
  onLoaded?: (pageCount: number) => void
}

interface PageInfo {
  proxy: PDFPageProxy
  baseWidth: number
  baseHeight: number
}

export default function PdfPages({ url, maxWidth = 900, renderOverlay, onLoaded }: PdfPagesProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [pages, setPages] = useState<PageInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [width, setWidth] = useState(0)
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded

  // Load document.
  useEffect(() => {
    let cancelled = false
    let task: PDFDocumentLoadingTask | null = null
    setPages(null)
    setError(null)
    ;(async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        if (pdfjs.GlobalWorkerOptions.workerSrc !== WORKER_SRC) pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC
        task = pdfjs.getDocument({ url })
        const doc = await task.promise
        if (cancelled) return
        const list: PageInfo[] = []
        for (let i = 1; i <= doc.numPages; i++) {
          const proxy = await doc.getPage(i)
          const vp = proxy.getViewport({ scale: 1 })
          list.push({ proxy, baseWidth: vp.width, baseHeight: vp.height })
        }
        if (cancelled) return
        setPages(list)
        onLoadedRef.current?.(doc.numPages)
      } catch (e) {
        if (!cancelled) {
          console.error(e)
          setError('문서를 불러오지 못했습니다.')
        }
      }
    })()
    return () => {
      cancelled = true
      if (task) void task.destroy()
    }
  }, [url])

  // Track container width (debounced).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let t: ReturnType<typeof setTimeout> | undefined
    const measure = () => setWidth(Math.floor(el.clientWidth))
    measure()
    const ro = new ResizeObserver(() => {
      clearTimeout(t)
      t = setTimeout(measure, 150)
    })
    ro.observe(el)
    return () => {
      clearTimeout(t)
      ro.disconnect()
    }
  }, [])

  const pageWidth = Math.max(0, Math.min(width, maxWidth))

  return (
    <div ref={containerRef} className="w-full">
      {error && (
        <div role="alert" className="mx-auto rounded-md border border-[var(--line)] bg-white p-6 text-center text-sm text-[var(--muted)]">
          {error}
        </div>
      )}
      {!error && !pages && (
        <div
          role="status"
          aria-live="polite"
          className="mx-auto flex aspect-[1/1.414] w-full items-center justify-center rounded-sm border border-[var(--line)] bg-white text-sm text-[var(--muted)]"
          style={{ maxWidth }}
        >
          <span className="flex items-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--line)] border-t-[var(--accent)]" aria-hidden />
            문서를 불러오는 중...
          </span>
        </div>
      )}
      {pages && pageWidth > 0 && (
        <div className="flex flex-col items-center gap-6">
          {pages.map((p, i) => {
            const w = pageWidth
            const h = Math.round((p.baseHeight / p.baseWidth) * w)
            return (
              <figure key={i} className="m-0 flex flex-col items-center gap-2" aria-label={`${i + 1}페이지`}>
                <div className="relative bg-white shadow-[0_1px_3px_rgba(0,0,0,0.12)] ring-1 ring-[var(--line)]" style={{ width: w, height: h }}>
                  <LazyPageCanvas page={p} width={w} height={h} />
                  {renderOverlay && (
                    <div className="absolute inset-0" style={{ width: w, height: h }}>
                      {renderOverlay(i + 1, { width: w, height: h })}
                    </div>
                  )}
                </div>
                <figcaption className="text-xs text-[var(--muted)]">
                  {i + 1} / {pages.length}
                </figcaption>
              </figure>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Placeholder keeps the page's exact size (so overlays and scroll positions are stable); the canvas is only
// rendered while the page is within ~1 viewport, and released again once it is ~3 viewports away.
function LazyPageCanvas({ page, width, height }: { page: PageInfo; width: number; height: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setActive(true)
      return
    }
    const near = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setActive(true), { rootMargin: '100% 0px' })
    const far = new IntersectionObserver((es) => es.every((e) => !e.isIntersecting) && setActive(false), { rootMargin: '300% 0px' })
    near.observe(el)
    far.observe(el)
    return () => {
      near.disconnect()
      far.disconnect()
    }
  }, [])
  return (
    <div ref={ref} className="absolute inset-0">
      {active ? <PageCanvas page={page} width={width} height={height} /> : <div className="absolute inset-0 bg-neutral-100/60" aria-hidden />}
    </div>
  )
}

function PageCanvas({ page, width, height }: { page: PageInfo; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [rendering, setRendering] = useState(true)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const scale = (width / page.baseWidth) * dpr
    const viewport = page.proxy.getViewport({ scale })
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    setRendering(true)
    const task = page.proxy.render({ canvas, viewport })
    task.promise.then(
      () => setRendering(false),
      (e: unknown) => {
        if ((e as { name?: string })?.name !== 'RenderingCancelledException') console.error(e)
      },
    )
    return () => task.cancel()
  }, [page, width, height])

  return (
    <>
      <canvas ref={ref} className="block" style={{ width, height }} aria-hidden />
      {rendering && <div className="absolute inset-0 animate-pulse bg-neutral-100/60" aria-hidden />}
    </>
  )
}
