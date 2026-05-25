/**
 * 体验版有效期解析（供打包脚本使用，与 src/shared/experience-validity.ts 保持一致）
 */

const SPEC_RE = /^(\d+)([hdmy])$/i
const SPEC_WORD_RE = /^(\d+)\s*(hours?|hrs?|h|days?|d|months?|mons?|m|years?|yrs?|y)$/i
const SPEC_CN_RE = /^(\d+)\s*([\u65e5\u6708\u5e74])$/

const UNIT_ALIAS = {
  h: 'h',
  hr: 'h',
  hrs: 'h',
  hour: 'h',
  hours: 'h',
  d: 'd',
  day: 'd',
  days: 'd',
  '\u65e5': 'd',
  m: 'm',
  mon: 'm',
  mons: 'm',
  month: 'm',
  months: 'm',
  '\u6708': 'm',
  y: 'y',
  yr: 'y',
  yrs: 'y',
  year: 'y',
  years: 'y',
  '\u5e74': 'y',
}

function toParsed(amount, unit) {
  if (!Number.isFinite(amount) || amount <= 0) return null
  return { amount, unit, spec: `${amount}${unit}` }
}

export function parseExperienceValidity(input) {
  const trimmed = String(input).trim()
  if (!trimmed) return null

  let m = SPEC_RE.exec(trimmed.replace(/\s+/g, ''))
  if (m) return toParsed(Number(m[1]), m[2].toLowerCase())

  m = SPEC_CN_RE.exec(trimmed.replace(/\s+/g, ''))
  if (m) {
    const unit = UNIT_ALIAS[m[2]]
    if (unit) return toParsed(Number(m[1]), unit)
  }

  m = SPEC_WORD_RE.exec(trimmed)
  if (m) {
    const unit = UNIT_ALIAS[m[2].toLowerCase()]
    if (unit) return toParsed(Number(m[1]), unit)
  }

  return null
}

export function parseExperienceValidFromTokens(tokens) {
  const parts = tokens.map((t) => String(t).trim()).filter(Boolean)
  if (!parts.length) return null

  if (parts.length === 1) {
    return parseExperienceValidity(parts[0])?.spec ?? null
  }

  const amount = Number(parts[0])
  const unitRaw = parts.slice(1).join('').toLowerCase()
  const unit = UNIT_ALIAS[unitRaw]
  if (unit) {
    return toParsed(amount, unit)?.spec ?? null
  }

  return parseExperienceValidity(parts.join(''))?.spec ?? null
}
