import { normalizeExperienceValid } from '../../src/shared/experience-validity'

/** 从启动参数读取 --experience-valid=1d 或 --experience-valid 1d */
export function readArgvExperienceValid(): string | undefined {
  const argv = process.argv
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const eq = /^--experience-valid=(.+)$/i.exec(a)
    if (eq?.[1]) return eq[1].trim()
    if (a === '--experience-valid' || a === '-ev') {
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) return next.trim()
    }
  }
  return undefined
}

declare const __UNIONS_EXPERIENCE_VALID__: string

function readBakedExperienceValid(): string {
  const raw = typeof __UNIONS_EXPERIENCE_VALID__ !== 'undefined' ? __UNIONS_EXPERIENCE_VALID__ : ''
  return normalizeExperienceValid(raw)
}

/**
 * 体验版有效期规格优先级：启动参数 > 环境变量 > 打包注入 > 默认 1y
 */
export function resolveExperienceValidSpec(): string {
  const fromArgv = readArgvExperienceValid()
  if (fromArgv) return normalizeExperienceValid(fromArgv)
  const fromEnv = process.env.UNIONS_EXPERIENCE_VALID?.trim()
  if (fromEnv) return normalizeExperienceValid(fromEnv)
  return readBakedExperienceValid()
}
