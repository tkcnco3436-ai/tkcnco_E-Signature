import 'server-only'
import { Resend } from 'resend'
import type { DocumentRow, SignerRow } from './types'

export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
  attachments?: { filename: string; content: Buffer }[]
}

export interface MailTemplate {
  subject: string
  html: string
  text: string
}

/** Sends via Resend when RESEND_API_KEY is set; otherwise logs the message and returns ok:false. */
export async function sendMail(msg: MailMessage): Promise<{ ok: boolean; error?: string }> {
  const key = process.env.RESEND_API_KEY
  if (!key) {
    const att = msg.attachments?.map((a) => `${a.filename} (${a.content.length} bytes)`).join(', ') || 'none'
    console.log(
      `[mail] RESEND_API_KEY not set; not sending.\n  to: ${msg.to}\n  subject: ${msg.subject}\n  attachments: ${att}\n${msg.text
        .split('\n')
        .map((l) => '  | ' + l)
        .join('\n')}`,
    )
    return { ok: false, error: 'no RESEND_API_KEY' }
  }
  try {
    const resend = new Resend(key)
    const { error } = await resend.emails.send({
      from: process.env.MAIL_FROM || 'pdf-esign <onboarding@resend.dev>',
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content })),
    })
    if (error) return { ok: false, error: `${error.name}: ${error.message}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Strip CR/LF so user text can never inject headers via the subject.
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

function layout(inner: string): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;border:1px solid #e3e5e8;">
<tr><td style="padding:28px 28px 8px 28px;font-family:'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',Arial,sans-serif;color:#1f2328;font-size:15px;line-height:1.6;">
${inner}
</td></tr>
<tr><td style="padding:16px 28px 24px 28px;font-family:'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',Arial,sans-serif;color:#8a9099;font-size:12px;line-height:1.5;border-top:1px solid #eef0f2;">
본 메일은 전자서명 시스템에서 자동 발송되었습니다. 링크는 본인만 사용하도록 타인과 공유하지 마세요.
</td></tr>
</table>
</td></tr>
</table>
</body></html>`
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;background:#1f6feb;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;">${escapeHtml(label)}</a></p>
<p style="margin:0 0 16px 0;font-size:12px;color:#8a9099;word-break:break-all;">버튼이 동작하지 않으면 아래 주소를 브라우저에 붙여넣으세요.<br>${escapeHtml(href)}</p>`
}

function messageBlock(doc: DocumentRow): { html: string; text: string } {
  if (!doc.message?.trim()) return { html: '', text: '' }
  const m = doc.message.trim()
  return {
    html: `<div style="margin:16px 0;padding:12px 14px;background:#f6f8fa;border-left:3px solid #d0d7de;white-space:pre-wrap;">${escapeHtml(m)}</div>`,
    text: `\n메시지:\n${m}\n`,
  }
}

export function signRequestEmail(doc: DocumentRow, signer: SignerRow, link: string): MailTemplate {
  const msg = messageBlock(doc)
  const subject = oneLine(`[서명 요청] ${doc.title}`)
  const html = layout(`
<h1 style="margin:0 0 16px 0;font-size:20px;">서명 요청</h1>
<p style="margin:0 0 8px 0;">${escapeHtml(signer.name)}님, 안녕하세요.</p>
<p style="margin:0 0 8px 0;">아래 문서에 대한 전자서명을 요청드립니다.</p>
<p style="margin:12px 0;"><strong>문서:</strong> ${escapeHtml(doc.title)}</p>
${msg.html}
${button(link, '문서 확인 및 서명하기')}`)
  const text = `${signer.name}님, 안녕하세요.

아래 문서에 대한 전자서명을 요청드립니다.
문서: ${doc.title}
${msg.text}
서명하기: ${link}

링크는 본인만 사용하도록 타인과 공유하지 마세요.`
  return { subject, html, text }
}

export function completedEmail(doc: DocumentRow, signer: SignerRow, downloadLink: string): MailTemplate {
  const subject = oneLine(`[서명 완료] ${doc.title}`)
  const html = layout(`
<h1 style="margin:0 0 16px 0;font-size:20px;">모든 서명이 완료되었습니다</h1>
<p style="margin:0 0 8px 0;">${escapeHtml(signer.name)}님, 안녕하세요.</p>
<p style="margin:0 0 8px 0;"><strong>${escapeHtml(doc.title)}</strong> 문서에 모든 서명자가 서명을 마쳤습니다.</p>
<p style="margin:0 0 8px 0;">최종 서명본 PDF를 첨부합니다. 아래 버튼으로도 내려받을 수 있습니다.</p>
${button(downloadLink, '서명 완료본 내려받기')}
<p style="margin:0 0 8px 0;font-size:13px;color:#57606a;">서명본에는 감사 증명서 페이지와 위·변조 확인용 전자서명(PAdES)이 포함되어 있습니다.</p>`)
  const text = `${signer.name}님, 안녕하세요.

"${doc.title}" 문서에 모든 서명자가 서명을 마쳤습니다.
최종 서명본 PDF를 첨부합니다.

내려받기: ${downloadLink}

서명본에는 감사 증명서 페이지와 위·변조 확인용 전자서명(PAdES)이 포함되어 있습니다.`
  return { subject, html, text }
}
