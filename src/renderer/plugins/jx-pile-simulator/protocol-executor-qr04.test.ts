import { describe, expect, it } from 'vitest'
import { parseQrCodesFrom04 } from './protocol-executor'

function asciiToHex(s: string): string {
  return Buffer.from(s, 'ascii').toString('hex')
}

describe('parseQrCodesFrom04', () => {
  it('parses allow layout: timeTag + allowFlag + qrGunCount + qrFixed(100) + gunSeg(20*N)', () => {
    const timeTagHex = asciiToHex('123456').slice(0, 12) // 6 bytes hex placeholder
    // timeTagHex should be 6 bytes => 12 hex chars
    const qr1 = 'A'.repeat(100)
    const qr2 = 'B'.repeat(100)

    const dataHex = `${timeTagHex}01` + // allowFlag=0x01
      `00` + // rejectReason=0x00
      `02` + // qrGunCount=2
      asciiToHex(qr1) +
      asciiToHex(qr2)

    const parsed = parseQrCodesFrom04(dataHex)
    expect(parsed).not.toBeNull()
    expect(parsed?.allowFlag).toBe(1)
    expect(parsed?.rejectReason).toBe(0)
    expect(parsed?.qrGunCodes.length).toBe(2)
    expect(parsed?.qrGunCodes[0]).toBe(qr1)
    expect(parsed?.qrGunCodes[1]).toBe(qr2)
  })
})

