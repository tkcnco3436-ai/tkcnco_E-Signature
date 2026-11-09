// Node ESM resolve hook so plain `node` (with built-in TypeScript type stripping) can run
// lib/*.ts files that use extensionless relative imports and the `@/` path alias.
// Usage: node --import ./scripts/ts-register.mjs --conditions=react-server scripts/smoke-core.mts
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function tryFile(base) {
  for (const cand of [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand
  }
  return null
}

export async function resolve(specifier, context, next) {
  let base = null
  if (specifier.startsWith('@/')) base = path.join(ROOT, specifier.slice(2))
  else if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:'))
    base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier)
  if (base && !path.extname(base)) {
    const hit = tryFile(base)
    if (hit) return next(pathToFileURL(hit).href, context)
  }
  return next(specifier, context)
}
