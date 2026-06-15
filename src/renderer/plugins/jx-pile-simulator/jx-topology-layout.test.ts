import { describe, expect, it } from 'vitest'
import {
  PILE_COLUMN_GAP,
  computeRowLayout,
  gunLayoutMode,
  pileColumnWidth,
  pileGunClusterWidth,
  splitPilesIntoRowsByWidth,
} from './jx-topology-layout'

describe('jx-topology-layout', () => {
  it('uses grid layout mode only for list view (3+ guns)', () => {
    expect(gunLayoutMode(2)).toBe('row')
    expect(gunLayoutMode(4)).toBe('grid')
  })

  it('computes pile column widths from gun cluster layout', () => {
    expect(pileGunClusterWidth(1)).toBe(100)
    expect(pileGunClusterWidth(2)).toBe(164)
    expect(pileGunClusterWidth(4)).toBe(328)
    expect(pileColumnWidth(2)).toBe(164)
  })

  it('wraps piles into next row when row min width exceeds container', () => {
    const piles = [
      { guns: [{}, {}, {}, {}] },
      { guns: [{}, {}, {}, {}] },
      { guns: [{}] },
    ]
    const narrow = splitPilesIntoRowsByWidth(piles, 400)
    expect(narrow.length).toBeGreaterThan(1)

    const wide = splitPilesIntoRowsByWidth(piles, 1200)
    expect(wide).toHaveLength(1)
    expect(wide[0]).toHaveLength(3)
  })

  it('keeps all piles in one row before container width is measured', () => {
    const piles = [{ guns: [{}, {}] }, { guns: [{}, {}, {}, {}] }]
    expect(splitPilesIntoRowsByWidth(piles, 0)).toEqual([piles])
  })

  it('expands row gap to fill container but not below PILE_COLUMN_GAP', () => {
    const cols = [100, 164]
    const wide = computeRowLayout(cols, 500)
    expect(wide.needsScroll).toBe(false)
    expect(wide.gap).toBe((500 - 264) / 1)

    const narrow = computeRowLayout(cols, 200)
    expect(narrow.needsScroll).toBe(true)
    expect(narrow.gap).toBe(PILE_COLUMN_GAP)
    expect(narrow.minWidth).toBe(264 + PILE_COLUMN_GAP)
  })
})
