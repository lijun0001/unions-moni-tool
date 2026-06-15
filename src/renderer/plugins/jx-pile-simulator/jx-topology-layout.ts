/** 拓扑枪位组横向间距（与 JxMainView.css --jx-gun-gap 一致） */
export const TOPOLOGY_GUN_GAP = 0

/** 单枪列宽（与 --jx-gun-node-width 默认一致） */
export const TOPOLOGY_GUN_NODE_WIDTH_SINGLE = 100

/** 多枪列宽（与 .is-gun-count-2+ --jx-gun-node-width 一致） */
export const TOPOLOGY_GUN_NODE_WIDTH_MULTI = 82

/** 桩列之间的最小间隔（jx-topology / jx-car-strip flex gap） */
export const PILE_COLUMN_GAP = 5

export type GunLayoutMode = 'row' | 'grid'
export type GunDensity = 'normal' | 'compact' | 'relaxed'

/** 列表详区 2×2 枪位网格 */
export function gunLayoutMode(gunCount: number): GunLayoutMode {
  return gunCount >= 3 ? 'grid' : 'row'
}

export function gunNodeWidth(gunCount: number, density: GunDensity = 'normal'): number {
  if (density === 'relaxed') return 100
  if (density === 'compact' && gunCount >= 3) return 80
  return gunCount <= 1 ? TOPOLOGY_GUN_NODE_WIDTH_SINGLE : TOPOLOGY_GUN_NODE_WIDTH_MULTI
}

/** 拓扑横排下单枪节点宽度 */
export function topologyGunNodeWidth(gunCount: number): number {
  const n = Math.max(1, gunCount || 1)
  return n <= 1 ? TOPOLOGY_GUN_NODE_WIDTH_SINGLE : TOPOLOGY_GUN_NODE_WIDTH_MULTI
}

/** 单桩枪簇所需横向宽度（不含桩列间距） */
export function pileGunClusterWidth(gunCount: number): number {
  const n = Math.max(1, gunCount || 1)
  const nodeW = topologyGunNodeWidth(n)
  return n * nodeW + (n - 1) * TOPOLOGY_GUN_GAP
}

/**
 * 拓扑单列宽度：按枪数计算，避免枪簇与邻桩重叠。
 */
export function pileColumnWidth(gunCount: number): number {
  return pileGunClusterWidth(gunCount)
}

export function totalGunCount(piles: { guns: unknown[] }[]): number {
  return piles.reduce((sum, p) => sum + p.guns.length, 0)
}

export type RowLayoutResult = {
  gap: number
  minWidth: number
  needsScroll: boolean
  columnWidths: number[]
}

/**
 * 根据容器宽度计算桩列间距：在不低于 PILE_COLUMN_GAP 的前提下尽量铺满整行；
 * 若最小宽度仍超出容器则保持最小间距并触发横向滚动。
 */
export function computeRowLayout(
  columnWidths: number[],
  containerWidth: number,
  minGap: number = PILE_COLUMN_GAP,
): RowLayoutResult {
  const n = columnWidths.length
  const sumCols = columnWidths.reduce((a, b) => a + b, 0)
  if (n <= 1) {
    const minWidth = sumCols
    const needsScroll = containerWidth > 0 && minWidth > containerWidth
    return { gap: minGap, minWidth, needsScroll, columnWidths }
  }
  const minWidth = sumCols + (n - 1) * minGap
  const avail = Math.max(containerWidth, 0)
  if (avail >= minWidth) {
    const gap = (avail - sumCols) / (n - 1)
    return { gap, minWidth: avail, needsScroll: false, columnWidths }
  }
  return { gap: minGap, minWidth, needsScroll: true, columnWidths }
}

/**
 * 按容器宽度与桩列最小宽度将桩拆成多行：当前行无法再容纳下一桩（保持最小间距）时换行。
 */
export function splitPilesIntoRowsByWidth<T extends { guns: unknown[] }>(
  piles: T[],
  containerWidth: number,
  minGap: number = PILE_COLUMN_GAP,
): T[][] {
  if (!piles.length) return []
  if (containerWidth <= 0) return [piles]

  const rows: T[][] = []
  let current: T[] = []

  for (const pile of piles) {
    if (!current.length) {
      current.push(pile)
      continue
    }
    const trial = [...current, pile]
    const columnWidths = trial.map((p) => pileColumnWidth(p.guns.length))
    const layout = computeRowLayout(columnWidths, containerWidth, minGap)
    if (!layout.needsScroll) {
      current.push(pile)
    } else {
      rows.push(current)
      current = [pile]
    }
  }
  if (current.length) rows.push(current)
  return rows
}
