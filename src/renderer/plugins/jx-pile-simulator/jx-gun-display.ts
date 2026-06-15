import type { JxPileOrder } from './types'
import type { JxTopologyPile } from './types'

export function gunLabelFromPile(pile: JxTopologyPile, gunId: string): string {
  const idx = pile.guns.findIndex((g) => g.gunId === gunId)
  if (idx < 0) return `${gunId}枪`
  return `${String.fromCharCode(65 + idx)}枪`
}

export function gunStatusLabel(state: string): string {
  if (state === 'linked') return '链接'
  if (state === 'occupied') return '占用'
  if (state === 'charging') return '充电中'
  if (state === 'fault') return '故障'
  return '空闲'
}

export function gunStatusForPile(pileOnlineState: string | undefined, gunState: string): string {
  if (pileOnlineState !== 'online') return '-'
  return gunStatusLabel(gunState)
}

export function isVirtualCarForPile(pile: JxTopologyPile, gunId: string): boolean {
  const gun = pile.guns.find((x) => x.gunId === gunId)
  if (!gun) return false
  if (pile.onlineState !== 'online') return true
  return !gun.vin
}

export function gunHudCharging(gun: { status: string }): boolean {
  return gun.status === 'charging'
}

export function gunHudShowsLiveCharging(pile: { status: string }, gun: { status: string }): boolean {
  return pile.status === 'charging' && gun.status === 'charging'
}

export function gunHudSocDisplay(
  pile: { status: string; pileId: string },
  gunId: string,
  gun: { status: string; soc?: number },
  orders: JxPileOrder[],
): string {
  if (!gunHudShowsLiveCharging(pile, gun)) return '-'
  const o = orders.find((x) => x.gunId === gunId && ['charging', 'starting', 'start-accepted'].includes(x.status))
  const s = o?.latestBms?.soc
  if (typeof s === 'number' && Number.isFinite(s)) return `${Math.round(s)}%`
  if (typeof gun.soc === 'number') return `${gun.soc}%`
  return '-'
}

export function gunHudEnergyLine(
  pile: { status: string; pileId: string },
  gunId: string,
  gun: { status: string },
  orders: JxPileOrder[],
): string {
  if (!gunHudShowsLiveCharging(pile, gun)) return '-'
  const o = orders.find((x) => x.gunId === gunId && x.status === 'charging')
  const kwh = o?.latest25?.chargeEnergyKwh
  if (typeof kwh === 'number' && Number.isFinite(kwh)) return `${kwh.toFixed(2)}kWh`
  return '-'
}

export function gunHudAmountLine(
  pile: { status: string; pileId: string },
  gunId: string,
  gun: { status: string },
  orders: JxPileOrder[],
): string {
  if (!gunHudShowsLiveCharging(pile, gun)) return '-'
  const o = orders.find((x) => x.gunId === gunId && x.status === 'charging')
  const y = o?.latest25?.chargeAmountYuan
  if (typeof y === 'number' && Number.isFinite(y)) return `${y.toFixed(2)}元`
  return '-'
}

export function pileChargingGunCount(pile: JxTopologyPile): number {
  return pile.guns.filter((g) => g.status === 'charging').length
}
