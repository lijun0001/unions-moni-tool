/** 打包时注入：experience=体验版，official=正式版 */
export type UnionsEdition = 'experience' | 'official'

export type LicenseBlockReason =
  | 'experience_expired'
  | 'trial_expired'
  | 'activation_expired'
  | 'not_activated'

export interface LicenseStatus {
  edition: UnionsEdition
  /** 当前是否允许使用功能 */
  allowed: boolean
  blockReason?: LicenseBlockReason
  /** 是否可在激活页输入密钥 */
  canActivate: boolean
  /** 是否已完成正式激活 */
  activated: boolean
  /** 当前生效的到期时间（毫秒） */
  effectiveExpiresAt: number | null
  /** 体验版固定截止时间（打包时刻 + 有效期规格，与安装无关） */
  buildExpiresAt: number | null
  /** 体验版有效期规格，如 1y（仅 experience） */
  experienceValidSpec: string | null
  /** 体验版有效期展示，如 1年 */
  experienceValidLabel: string | null
  /** 正式版 7 天体验截止 */
  trialExpiresAt: number | null
  /** 激活码授予的截止 */
  activationExpiresAt: number | null
  /** 打包时间戳 */
  buildTimeMs: number
  /** 展示用文案 */
  message: string
  /** 体验版过期后是否应直接退出应用 */
  quitOnBlock: boolean
}

export interface LicenseActivateResult {
  ok: boolean
  error?: string
  status?: LicenseStatus
}
