import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'PDF 전자서명',
  description: 'PDF에 서명하고 상대방 서명을 받아 날인본을 함께 보관합니다.',
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  )
}
