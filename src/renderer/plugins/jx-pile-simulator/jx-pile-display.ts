/** 桩自定义名称最大长度 */
export const JX_PILE_NAME_MAX_LEN = 20

/** 未填写名称时的默认展示文案 */
export const PILE_DEFAULT_DISPLAY_NAME = '--'

export function normalizePileName(input: unknown): string | undefined {
  const s = String(input ?? '').trim()
  if (!s) return undefined
  return s.slice(0, JX_PILE_NAME_MAX_LEN)
}

/** 校验名称；空字符串合法，返回错误文案或 null */
export function validatePileName(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (trimmed.length > JX_PILE_NAME_MAX_LEN) {
    return `名称不超过 ${JX_PILE_NAME_MAX_LEN} 个字符`
  }
  return null
}

export function pileHasCustomName(pile: { name?: string }): boolean {
  return Boolean(pile.name?.trim())
}

/** 桩名称展示文案（未填写时为 `--`） */
export function pileDisplayLabel(pile: { name?: string }): string {
  return pile.name?.trim() || PILE_DEFAULT_DISPLAY_NAME
}

/** @deprecated 使用 pileDisplayLabel */
export function pileDisplayName(pile: { name?: string; pileId: string }): string {
  return pileDisplayLabel(pile)
}
