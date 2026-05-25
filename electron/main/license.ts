import type Store from 'electron-store'
import type {
  LicenseActivateResult,
  LicenseBlockReason,
  LicenseStatus,
  UnionsEdition,
} from '../../src/shared/license-types'
import {
  experienceExpiresAtMs,
  formatExperienceValidityLabel,
} from '../../src/shared/experience-validity'
import { BUILD_META } from './build-meta'

const TRIAL_DAYS = 7
const LICENSE_SECRET = 'unions-moni-license-v1'

type LicenseStoreShape = {
  license?: {
    activationKey?: string
    activationExpiresAt?: number
    activatedAt?: number
  }
  runtime?: {
    firstLaunchAt?: number
  }
}

function checksum4(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).toUpperCase().padStart(4, '0').slice(-4)
}

/** 解析激活码 UNIONS-YYYYMMDD-XXXX（XXXX 为校验段） */
export function parseActivationKey(key: string): { expiresAt: number } | null {
  const m = /^UNIONS-(\d{8})-([A-F0-9]{4})$/i.exec(key.trim())
  if (!m) return null
  const dateStr = m[1]!
  const check = m[2]!.toUpperCase()
  const expected = checksum4(`${dateStr}:${LICENSE_SECRET}`)
  if (check !== expected) return null
  const y = Number(dateStr.slice(0, 4))
  const mo = Number(dateStr.slice(4, 6)) - 1
  const d = Number(dateStr.slice(6, 8))
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null
  const expiresAt = new Date(y, mo, d, 23, 59, 59, 999).getTime()
  return { expiresAt }
}

/** 生成示例激活码（内部/文档用） */
export function formatActivationKey(expiresAt: number): string {
  const d = new Date(expiresAt)
  const dateStr = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('')
  return `UNIONS-${dateStr}-${checksum4(`${dateStr}:${LICENSE_SECRET}`)}`
}

function formatDateTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function experienceBuildExpiresAt(): number {
  return experienceExpiresAtMs(BUILD_META.buildTimeMs, BUILD_META.experienceValid)
}

function ensureFirstLaunch(store: Store<LicenseStoreShape>): number {
  const cur = store.get('runtime') ?? {}
  if (cur.firstLaunchAt && cur.firstLaunchAt > 0) return cur.firstLaunchAt
  const firstLaunchAt = Date.now()
  store.set('runtime', { ...cur, firstLaunchAt })
  return firstLaunchAt
}

export function getLicenseStatus(store: Store<LicenseStoreShape>): LicenseStatus {
  const edition: UnionsEdition = BUILD_META.edition
  const buildTimeMs = BUILD_META.buildTimeMs

  if (edition === 'experience') {
    const buildExpiresAt = experienceBuildExpiresAt()
    const experienceValidSpec = BUILD_META.experienceValid
    const experienceValidLabel = formatExperienceValidityLabel(experienceValidSpec)
    const allowed = Date.now() < buildExpiresAt
    return {
      edition,
      allowed,
      blockReason: allowed ? undefined : 'experience_expired',
      canActivate: false,
      activated: false,
      effectiveExpiresAt: buildExpiresAt,
      buildExpiresAt,
      experienceValidSpec,
      experienceValidLabel,
      trialExpiresAt: null,
      activationExpiresAt: null,
      buildTimeMs,
      message: allowed
        ? `体验版有效期至 ${formatDateTime(buildExpiresAt)}（自打包日起 ${experienceValidLabel}，重装不可延长）`
        : `体验版已于 ${formatDateTime(buildExpiresAt)} 到期，程序无法继续使用`,
      quitOnBlock: true,
    }
  }

  const firstLaunchAt = ensureFirstLaunch(store)
  const trialExpiresAt = firstLaunchAt + TRIAL_DAYS * 24 * 60 * 60 * 1000
  const lic = store.get('license') ?? {}
  const activationExpiresAt =
    lic.activationExpiresAt && lic.activationExpiresAt > 0 ? lic.activationExpiresAt : null
  const activated = Boolean(lic.activationKey && activationExpiresAt)
  const effectiveExpiresAt = activated ? activationExpiresAt : trialExpiresAt
  const now = Date.now()
  const allowed = effectiveExpiresAt != null && now < effectiveExpiresAt

  let blockReason: LicenseBlockReason | undefined
  let message: string
  if (allowed) {
    if (activated) {
      message = `已激活，到期时间 ${formatDateTime(activationExpiresAt!)}`
    } else {
      message = `体验期至 ${formatDateTime(trialExpiresAt)}，激活后可按许可证延期`
    }
  } else if (activated) {
    blockReason = 'activation_expired'
    message = `激活已过期（${formatDateTime(activationExpiresAt!)}），请重新激活`
  } else if (now >= trialExpiresAt) {
    blockReason = 'trial_expired'
    message = `7 天体验已结束（${formatDateTime(trialExpiresAt)}），请激活后继续使用`
  } else {
    blockReason = 'not_activated'
    message = '请激活后使用'
  }

  return {
    edition,
    allowed,
    blockReason: allowed ? undefined : blockReason,
    canActivate: true,
    activated,
    effectiveExpiresAt,
    buildExpiresAt: null,
    experienceValidSpec: null,
    experienceValidLabel: null,
    trialExpiresAt,
    activationExpiresAt,
    buildTimeMs,
    message,
    quitOnBlock: false,
  }
}

export function activateLicense(
  store: Store<LicenseStoreShape>,
  key: string,
): LicenseActivateResult {
  if (BUILD_META.edition === 'experience') {
    return { ok: false, error: '体验版不支持激活' }
  }
  const parsed = parseActivationKey(key)
  if (!parsed) {
    return { ok: false, error: '激活码格式无效或校验失败' }
  }
  if (parsed.expiresAt <= Date.now()) {
    return { ok: false, error: '激活码已过期，请使用有效期限内的许可证' }
  }
  store.set('license', {
    activationKey: key.trim().toUpperCase(),
    activationExpiresAt: parsed.expiresAt,
    activatedAt: Date.now(),
  })
  const status = getLicenseStatus(store)
  return { ok: true, status }
}

export function experienceExpiredMessage(status: LicenseStatus): string {
  return status.message || '体验版已过期'
}

export function officialBlockedMessage(_status: LicenseStatus): string {
  return '请重新激活'
}
