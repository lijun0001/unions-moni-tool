import type { UnionsEdition } from '../../src/shared/license-types'
import { resolveExperienceValidSpec } from './experience-valid-resolve'

/** Vite 构建时注入，见 vite.config.ts */
declare const __UNIONS_EDITION__: string
declare const __UNIONS_BUILD_TIME_MS__: string

function readEdition(): UnionsEdition {
  const v = typeof __UNIONS_EDITION__ !== 'undefined' ? __UNIONS_EDITION__ : 'official'
  return v === 'experience' ? 'experience' : 'official'
}

function readBuildTimeMs(): number {
  const raw = typeof __UNIONS_BUILD_TIME_MS__ !== 'undefined' ? __UNIONS_BUILD_TIME_MS__ : ''
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : Date.now()
}

export const BUILD_META = {
  edition: readEdition(),
  buildTimeMs: readBuildTimeMs(),
  /** 体验版有效期规格（1h/1d/1m/1y），仅 experience 版有意义 */
  experienceValid: resolveExperienceValidSpec(),
} as const
