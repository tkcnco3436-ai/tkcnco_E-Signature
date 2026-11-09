# pdf-esign — Implementation Plan

## Goal
Self-hosted PDF e-signature tool. The owner uploads an existing PDF, places signature
fields for each signer, signs it, and sends a link to the other party by email.
When every signer has signed, the app produces one sealed PDF and emails it to all signers.
Runs on the owner's PC first (SQLite + local files, cloudflared tunnel for the public link).
Later it can be handed to company developers as a git repo and deployed to a server.

## Stack
- Next.js 16 (App Router) + React 19 + TypeScript + Tailwind 4
- Node >= 22.5, `node:sqlite` (no native build), files on disk under `./data`
- `pdf-lib` + `@pdf-lib/fontkit` for stamping, Noto Sans KR (OFL) for Korean text
- `pdfjs-dist` for rendering pages in the browser
- `@signpdf/*` + `node-forge` for a PAdES digital signature (tamper evidence)
- `resend` for email (falls back to console log + copy-link when no key)

## Env (`.env.local`, see `.env.example`)
| Key | Purpose |
|---|---|
| `APP_URL` | Public base URL used in email links (tunnel URL or domain) |
| `ADMIN_PASSWORD` | Owner login password |
| `SESSION_SECRET` | HMAC key for the owner session cookie (32+ chars) |
| `RESEND_API_KEY` | Optional. Without it, emails are logged and links shown in UI |
| `MAIL_FROM` | Sender, e.g. `회사 <info@example.com>` (domain must be verified in Resend) |
| `OWNER_NAME`, `OWNER_EMAIL` | Defaults for the owner signer |
| `DATA_DIR` | Optional data folder override |

## Data model
See `lib/types.ts` and `lib/db.ts` (already written — treat as the contract).
Field coordinates are normalized 0..1 with origin top-left.

## Flow
1. Owner logs in (`/login`), uploads PDF (`/admin/new`). Document status `draft`.
2. Editor (`/admin/documents/[id]/edit`): add signers (owner is signer #0 by default),
   drag fields onto pages per signer, save.
3. Send: status `sent`. The first signer in order gets notified.
   - If the first signer is the owner: no email, the admin UI shows "Sign now" linking to `/sign/[token]`.
   - Otherwise an email with `${APP_URL}/sign/${token}` is sent.
4. Signer page (`/sign/[token]`): renders PDF with their fields highlighted, draws signature
   (canvas), fills text/name/date, agrees to the consent checkbox, submits.
   Only the signer whose turn it is may sign (all lower order_index signed).
5. After each signature: notify the next signer. After the last: build the sealed PDF,
   set status `completed`, email all signers with the PDF attached and a download link.
6. Sealed PDF = original pages + stamped field values + appended audit certificate page
   (document id, original SHA-256, each signer name/email/IP/UA/time, event log)
   + PAdES signature with a self-signed certificate generated on first run (`data/cert.p12`).
   `signed_sha256` stored. Download: `/api/sign/[token]/download` (after completion) and admin.

## Modules and owners (parallel work)
- **A. Core server** (`lib/pdf.ts`, `lib/seal.ts`, `lib/mail.ts`, `lib/auth.ts`, `lib/workflow.ts`, `lib/http.ts`, `proxy.ts` or `middleware.ts`, `assets/fonts/`)
- **B. Admin UI + admin API** (`app/login`, `app/admin/**`, `app/api/admin/**`, `app/api/auth/**`, `components/admin/**`)
- **C. Signer UI + signer API** (`app/sign/[token]/**`, `app/api/sign/**`, `components/sign/**`, shared `components/PdfPages.tsx`)

## Module A exports (contract for B and C)
```ts
// lib/auth.ts
export async function isAdmin(): Promise<boolean>          // reads cookie via next/headers
export async function requireAdmin(): Promise<void>         // throws/redirects when not admin (route handlers: return 401 using isAdmin)
export function checkPassword(pw: string): boolean          // timing-safe compare with ADMIN_PASSWORD
export async function createSession(): Promise<void>        // sets httpOnly cookie 'esign_session'
export async function destroySession(): Promise<void>

// lib/http.ts
export function clientInfo(req: Request): { ip: string | null; userAgent: string | null }

// lib/workflow.ts  (all DB state transitions live here)
export function createDocument(input: { title: string; pdf: Uint8Array; message?: string | null }): Promise<DocumentRow>
export function saveDraft(documentId: string, input: {
  title?: string; message?: string | null;
  signers: { id?: string; name: string; email: string; is_owner: boolean; order_index: number }[];
  fields: { signer_ref: number /* index into signers array */; page: number; x: number; y: number; w: number; h: number; type: FieldType; label?: string | null }[];
}): DocumentBundle                                          // only while draft; replaces signers+fields
export function sendDocument(documentId: string): Promise<{ notified: { signerId: string; link: string; emailed: boolean }[] }>
export function signerView(token: string): { bundle: DocumentBundle; signer: SignerRow; canSign: boolean; reason?: string } | undefined
export function markViewed(token: string, info: { ip: string | null; userAgent: string | null }): void
export function submitSignature(token: string, input: {
  signaturePng: string;                 // data:image/png;base64,...
  values: Record<string /* fieldId */, string>;
  consent: true;
}, info: { ip: string | null; userAgent: string | null }): Promise<{ completed: boolean }>
export function voidDocument(documentId: string): void
export function deleteDocument(documentId: string): void
export function resendNotification(documentId: string): Promise<{ signerId: string; link: string; emailed: boolean } | null>
export function signLink(token: string): string            // `${APP_URL}/sign/${token}`

// lib/seal.ts
export async function buildSealedPdf(bundle: DocumentBundle): Promise<{ bytes: Uint8Array; timestamp: { at: Date; tsa: string } | null; timestampError?: string }>  // RFC 3161 via lib/tsa.ts
```
Errors from workflow functions: throw `WorkflowError(message, status)` exported from `lib/workflow.ts`.

## HTTP API
Admin (cookie session; 401 if absent):
- `POST /api/auth/login` `{password}` -> 200 / 401 (rate limit 5/min per IP)
- `POST /api/auth/logout`
- `POST /api/admin/documents` multipart `file`, `title`, `message?` -> `{id}` (PDF only, max 20 MB, `%PDF-` magic check)
- `GET  /api/admin/documents/[id]` -> DocumentBundle (signer tokens included — admin only)
- `PUT  /api/admin/documents/[id]` saveDraft body -> DocumentBundle
- `POST /api/admin/documents/[id]/send` -> notified list
- `POST /api/admin/documents/[id]/resend` -> notified
- `POST /api/admin/documents/[id]/void`
- `DELETE /api/admin/documents/[id]`
- `GET  /api/admin/documents/[id]/file?kind=original|signed` -> application/pdf

Signer (token in path, no session):
- `GET  /api/sign/[token]` -> `{ document: {id,title,message,page_count,status}, signer: {id,name,email,status}, fields (own fields + others' field boxes without values), canSign, reason }` — never leak other tokens or emails
- `GET  /api/sign/[token]/file` -> original PDF (or signed when completed)
- `POST /api/sign/[token]` `{signaturePng, values, consent}` -> `{completed}`
- `GET  /api/sign/[token]/download` -> sealed PDF when completed, else 409

## Security
- Tokens: 32 random bytes hex. Signing page never exposes other signers' tokens.
- Admin session: HMAC-signed cookie, httpOnly, sameSite=lax, secure when APP_URL is https.
- Upload validation: size, magic bytes, pdf-lib parse.
- Signature PNG: must be `data:image/png;base64,`, max 500 KB.
- All writes in SQLite transactions. A signer can sign once; order enforced server-side.
- `data/` and `.env.local` git-ignored.

## Verification
- `npm run typecheck` and `npm run build` pass.
- `scripts/e2e.mjs`: against a running server, log in, upload sample PDF, set 2 signers, send,
  sign as owner then external via API, assert completed, download sealed PDF, check `%PDF`, audit page exists.
- Manual: browser walk-through, cloudflared tunnel link opened from phone.
