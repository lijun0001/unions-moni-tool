import { describe, expect, it } from 'vitest'
import { parseTariffModelFrom037 } from './protocol-executor'

describe('parseTariffModelFrom037', () => {
  it('parses tariff model and periods from 0x37 payload', () => {
    const dataHex = [
      '1a041d0e1020',
      '02000000',
      '88130000',
      '02',
      '08',
      '00',
      '02',
      '10270000',
      'e8030000',
      '20',
      '00',
      '04',
      '88130000',
      'f4010000',
    ].join('')

    const model = parseTariffModelFrom037(dataHex)
    expect(model).not.toBeNull()
    expect(model?.version).toBe(2)
    expect(model?.parkingRate).toBe(0.5)
    expect(model?.periods.length).toBe(2)
    expect(model?.periods[0]).toMatchObject({
      startHour: 8,
      startMinute: 0,
      type: 2,
      electricRate: 1,
      serviceRate: 0.1,
    })
  })
})
