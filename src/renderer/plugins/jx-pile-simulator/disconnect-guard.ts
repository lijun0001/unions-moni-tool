import type { JxTopologyPile } from './types'

export function getDisconnectBlockReason(
  onlineState: JxTopologyPile['onlineState'],
  disconnecting: boolean,
): string | null {
  if (disconnecting) return '设备正在断开中，请稍后'
  if (onlineState === 'offline') return '设备已断开，无需重复断开'
  return null
}
