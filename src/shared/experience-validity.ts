/** 体验版有效期规格，如 1h / 1d / 1m / 1y */
export type ExperienceValidUnit = 'h' | 'd' | 'm' | 'y'

export interface ParsedExperienceValidity {
  amount: number
  unit: ExperienceValidUnit
  /** 规范化小写规格，如 1y */
  spec: string
}

export const DEFAULT_EXPERIENCE_VALID = '1y'

const SPEC_RE = /^(\d+)([hdmy])$/i
const SPEC_WORD_RE = /^(\d+)\s*(hours?|hrs?|h|days?|d|months?|mons?|m|years?|yrs?|y)$/i
const SPEC_CN_RE = /^(\d+)\s*([\u65e5\u6708\u5e74])$/

const UNIT_ALIAS: Record<string, ExperienceValidUnit> = {
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

const UNIT_LABEL: Record<ExperienceValidUnit, string> = {
  h: '\u5c0f\u65f6',
  d: '\u5929',
  m: '\u4e2a\u6708',
  y: '\u5e74',
}

function toParsed(amount: number, unit: ExperienceValidUnit): ParsedExperienceValidity | null {
  if (!Number.isFinite(amount) || amount <= 0) return null
  return { amount, unit, spec: `${amount}${unit}` }
}

/** 解析 1h / 2d / 3m / 2y / 2年 / 3 months 等 */
export function parseExperienceValidity(input: string): ParsedExperienceValidity | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  let m = SPEC_RE.exec(trimmed.replace(/\s+/g, ''))
  if (m) return toParsed(Number(m[1]), m[2]!.toLowerCase() as ExperienceValidUnit)

  m = SPEC_CN_RE.exec(trimmed.replace(/\s+/g, ''))
  if (m) {
    const cn = m[2]!
    const unit = UNIT_ALIAS[cn]
    if (unit) return toParsed(Number(m[1]), unit)
  }

  m = SPEC_WORD_RE.exec(trimmed)
  if (m) {
    const unit = UNIT_ALIAS[m[2]!.toLowerCase()]
    if (unit) return toParsed(Number(m[1]), unit)
  }

  return null
}

/**
 * 从命令行参数解析有效期（打包脚本用）
 * 例：['2','y'] ['3','月'] ['2y'] ['7','days']
 */
export function parseExperienceValidFromTokens(tokens: string[]): string | null {
  const parts = tokens.map((t) => t.trim()).filter(Boolean)
  if (!parts.length) return null

  if (parts.length === 1) {
    return parseExperienceValidity(parts[0]!)?.spec ?? null
  }

  const amount = Number(parts[0])
  const unitRaw = parts.slice(1).join('').toLowerCase()
  const unit = UNIT_ALIAS[unitRaw]
  if (unit) {
    const p = toParsed(amount, unit)
    return p?.spec ?? null
  }

  return parseExperienceValidity(parts.join(''))?.spec ?? null
}

/** 非法或空则回退默认 1y */
export function normalizeExperienceValid(input: string | undefined | null): string {
  const raw = (input ?? '').trim().toLowerCase()
  if (!raw) return DEFAULT_EXPERIENCE_VALID
  return parseExperienceValidity(raw)?.spec ?? DEFAULT_EXPERIENCE_VALID
}

export function formatExperienceValidityLabel(spec: string): string {
  const p = parseExperienceValidity(spec)
  if (!p) return spec
  return `${p.amount}${UNIT_LABEL[p.unit]}`
}

/** 自 baseMs（打包时刻）起按规格计算截止时间 */
export function experienceExpiresAtMs(baseMs: number, spec: string): number {
  const p = parseExperienceValidity(normalizeExperienceValid(spec))
  if (!p) return baseMs
  const base = new Date(baseMs)
  switch (p.unit) {
    case 'h':
      return baseMs + p.amount * 60 * 60 * 1000
    case 'd':
      return baseMs + p.amount * 24 * 60 * 60 * 1000
    case 'm': {
      const end = new Date(base)
      end.setMonth(end.getMonth() + p.amount)
      return end.getTime()
    }
    case 'y': {
      const end = new Date(base)
      end.setFullYear(end.getFullYear() + p.amount)
      return end.getTime()
    }
    default:
      return baseMs
  }
}
