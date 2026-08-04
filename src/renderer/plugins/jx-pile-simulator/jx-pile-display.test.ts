import { describe, expect, it } from 'vitest'
import {
  JX_PILE_NAME_MAX_LEN,
  PILE_DEFAULT_DISPLAY_NAME,
  normalizePileName,
  pileDisplayLabel,
  pileDisplayName,
  validatePileName,
} from './jx-pile-display'

describe('jx-pile-display', () => {
  it('normalizePileName trims and caps length', () => {
    expect(normalizePileName('  测试桩  ')).toBe('测试桩')
    expect(normalizePileName('')).toBeUndefined()
    expect(normalizePileName('a'.repeat(25))?.length).toBe(JX_PILE_NAME_MAX_LEN)
  })

  it('validatePileName accepts empty and rejects too long', () => {
    expect(validatePileName('')).toBeNull()
    expect(validatePileName('  ')).toBeNull()
    expect(validatePileName('a'.repeat(20))).toBeNull()
    expect(validatePileName('a'.repeat(21))).toMatch(/20/)
  })

  it('pileDisplayLabel uses -- when name empty', () => {
    expect(pileDisplayLabel({ name: 'A区1号' })).toBe('A区1号')
    expect(pileDisplayLabel({})).toBe(PILE_DEFAULT_DISPLAY_NAME)
    expect(pileDisplayName({ pileId: '001' })).toBe(PILE_DEFAULT_DISPLAY_NAME)
  })
})
