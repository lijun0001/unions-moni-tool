/** 内置 V2.25 协议 ID（当前 UI 禁止选用） */
export const JX_PROTOCOL_V225_ID = 'jx-v2.25-core'

export const JX_PROTOCOL_V224_ID = 'jx-v2.24-core'

/** 是否可在下拉框中选择（V2.25 禁用） */
export function isJxProtocolSelectable(protocolId: string): boolean {
  if (!protocolId) return false
  const id = protocolId.toLowerCase()
  if (id === JX_PROTOCOL_V225_ID) return false
  if (id.includes('2.25') || id.includes('v2.25')) return false
  return true
}

export function normalizeSelectableProtocolId(
  protocolId: string,
  fallback: string = JX_PROTOCOL_V224_ID,
): string {
  return isJxProtocolSelectable(protocolId) ? protocolId : fallback
}
