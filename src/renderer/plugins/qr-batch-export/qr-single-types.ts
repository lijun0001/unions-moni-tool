export type QrErrorLevel = 'L' | 'M' | 'Q' | 'H'

export type QrStylePreset = 'basic' | 'brand' | 'inverted'

export interface SingleQrSettings {
  errorLevel: QrErrorLevel
  size: number
  /** 0 = 自动 */
  version: number
  margin: number
  style: QrStylePreset
}

export const ERROR_LEVEL_OPTIONS: { label: string; value: QrErrorLevel; percent: string }[] = [
  { label: '7%', value: 'L', percent: '7%' },
  { label: '15%', value: 'M', percent: '15%' },
  { label: '25%', value: 'Q', percent: '25%' },
  { label: '30%', value: 'H', percent: '30%' },
]

export const SIZE_OPTIONS = [85, 128, 200, 256, 400, 512] as const

export const VERSION_OPTIONS: { label: string; value: number }[] = [
  { label: '\u81ea\u52a8', value: 0 },
  { label: '1 (21\u00d721)', value: 1 },
  { label: '2 (25\u00d725)', value: 2 },
  { label: '3 (29\u00d729)', value: 3 },
  { label: '4 (33\u00d733)', value: 4 },
  { label: '5 (37\u00d737)', value: 5 },
  { label: '6 (41\u00d741)', value: 6 },
  { label: '7 (45\u00d745)', value: 7 },
  { label: '10 (57\u00d757)', value: 10 },
  { label: '12 (65\u00d765)', value: 12 },
]

export const MARGIN_OPTIONS: { label: string; value: number }[] = [
  { label: '0\u4e2a\u8272\u5757', value: 0 },
  { label: '1\u4e2a\u8272\u5757', value: 1 },
  { label: '2\u4e2a\u8272\u5757', value: 2 },
  { label: '4\u4e2a\u8272\u5757', value: 4 },
]

export const STYLE_PRESETS: { id: QrStylePreset; label: string }[] = [
  { id: 'basic', label: '\u57fa\u7840\u6837\u5f0f' },
  { id: 'brand', label: '\u54c1\u724c\u8272' },
  { id: 'inverted', label: '\u6df1\u8272\u5e95' },
]

export const DEFAULT_SINGLE_SETTINGS: SingleQrSettings = {
  errorLevel: 'M',
  size: 256,
  version: 0,
  margin: 2,
  style: 'basic',
}

/** 过滤回车、空格、换行 */
export function sanitizeQrContent(raw: string): string {
  return raw.replace(/[\s\r\n\u00a0]+/g, '')
}

export function settingsSummary(settings: SingleQrSettings): string {
  const ec = ERROR_LEVEL_OPTIONS.find((o) => o.value === settings.errorLevel)?.percent ?? '15%'
  const ver =
    settings.version === 0
      ? '\u81ea\u52a8'
      : VERSION_OPTIONS.find((o) => o.value === settings.version)?.label ?? String(settings.version)
  return `QR Code, ${ec}\u5bb9\u9519, ${settings.size}\u00d7${settings.size}px, \u7248\u672c ${ver}`
}
