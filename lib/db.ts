import 'server-only'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { DocumentBundle, DocumentRow, EventRow, EventType, FieldRow, SignerRow } from './types'

// Data lives in ./data (git-ignored). DATA_DIR can override it.
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'))
export const FILES_DIR = path.join(DATA_DIR, 'files')

const g = globalThis as unknown as { __esignDb?: DatabaseSync }

function open(): DatabaseSync {
  fs.mkdirSync(FILES_DIR, { recursive: true })
  const db = new DatabaseSync(path.join(DATA_DIR, 'esign.db'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      page_count INTEGER NOT NULL,
      original_sha256 TEXT NOT NULL,
      signed_sha256 TEXT,
      message TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS signers (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      is_owner INTEGER NOT NULL DEFAULT 0,
      order_index INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      signature_png TEXT,
      signed_at TEXT,
      ip TEXT,
      user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS fields (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      signer_id TEXT NOT NULL REFERENCES signers(id) ON DELETE CASCADE,
      page INTEGER NOT NULL,
      x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
      type TEXT NOT NULL,
      label TEXT,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      signer_id TEXT,
      type TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      detail TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signers_doc ON signers(document_id);
    CREATE INDEX IF NOT EXISTS idx_fields_doc ON fields(document_id);
    CREATE INDEX IF NOT EXISTS idx_events_doc ON events(document_id);
  `)
  return db
}

export function db(): DatabaseSync {
  if (!g.__esignDb) g.__esignDb = open()
  return g.__esignDb
}

export const newId = () => crypto.randomUUID()
export const newToken = () => crypto.randomBytes(32).toString('hex')
export const nowIso = () => new Date().toISOString()
export const sha256 = (buf: Uint8Array) => crypto.createHash('sha256').update(buf).digest('hex')

// File paths for a document.
export const docDir = (id: string) => path.join(FILES_DIR, id)
export const originalPdfPath = (id: string) => path.join(docDir(id), 'original.pdf')
export const signedPdfPath = (id: string) => path.join(docDir(id), 'signed.pdf')

export function getDocument(id: string): DocumentRow | undefined {
  return db().prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined
}

export function listDocuments(): DocumentRow[] {
  return db().prepare('SELECT * FROM documents ORDER BY created_at DESC').all() as unknown as DocumentRow[]
}

export function getSigners(documentId: string): SignerRow[] {
  return db()
    .prepare('SELECT * FROM signers WHERE document_id = ? ORDER BY order_index ASC')
    .all(documentId) as unknown as SignerRow[]
}

export function getSignerByToken(token: string): SignerRow | undefined {
  if (!/^[0-9a-f]{64}$/.test(token)) return undefined
  return db().prepare('SELECT * FROM signers WHERE token = ?').get(token) as SignerRow | undefined
}

export function getFields(documentId: string): FieldRow[] {
  return db()
    .prepare('SELECT * FROM fields WHERE document_id = ? ORDER BY page, y, x')
    .all(documentId) as unknown as FieldRow[]
}

export function getEvents(documentId: string): EventRow[] {
  return db()
    .prepare('SELECT * FROM events WHERE document_id = ? ORDER BY at ASC')
    .all(documentId) as unknown as EventRow[]
}

export function getBundle(id: string): DocumentBundle | undefined {
  const document = getDocument(id)
  if (!document) return undefined
  return { document, signers: getSigners(id), fields: getFields(id), events: getEvents(id) }
}

export function logEvent(e: {
  document_id: string
  signer_id?: string | null
  type: EventType
  ip?: string | null
  user_agent?: string | null
  detail?: string | null
}) {
  db()
    .prepare(
      'INSERT INTO events (id, document_id, signer_id, type, ip, user_agent, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(newId(), e.document_id, e.signer_id ?? null, e.type, e.ip ?? null, e.user_agent ?? null, e.detail ?? null, nowIso())
}

// Run fn inside a transaction.
export function tx<T>(fn: () => T): T {
  const d = db()
  d.exec('BEGIN')
  try {
    const r = fn()
    d.exec('COMMIT')
    return r
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
}
