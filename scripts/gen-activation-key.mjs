/**
 * \u751f\u6210\u6b63\u5f0f\u7248\u6fc0\u6d3b\u7801\uff08\u4e0e electron/main/license.ts \u7b97\u6cd5\u4e00\u81f4\uff09
 *
 * \u7528\u6cd5\uff1a
 *   node scripts/gen-activation-key.mjs 2026-12-31
 *   node scripts/gen-activation-key.mjs +365
 */
import { createHash } from 'node:crypto'

const LICENSE_SECRET = 'unions-moni-license-v1'

function checksum4(input) {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).toUpperCase().padStart(4, '0').slice(-4)
}

function formatActivationKey(expiresAt) {
  const d = new Date(expiresAt)
  const dateStr = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('')
  return `UNIONS-${dateStr}-${checksum4(`${dateStr}:${LICENSE_SECRET}`)}`
}

function parseExpiresArg(arg) {
  if (!arg) {
    const d = new Date()
    d.setFullYear(d.getFullYear() + 1)
    return d.getTime()
  }
  if (/^\+?\d+$/.test(arg)) {
    const days = Number(arg.replace(/^\+/, ''))
    return Date.now() + days * 24 * 60 * 60 * 1000
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(arg)
  if (!m) {
    console.error('Invalid date. Use YYYY-MM-DD or +365')
    process.exit(1)
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime()
}

const expiresAt = parseExpiresArg(process.argv[2])
const key = formatActivationKey(expiresAt)
console.log(key)
console.log(`expires: ${new Date(expiresAt).toISOString()}`)
