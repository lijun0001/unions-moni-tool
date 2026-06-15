import { describe, expect, it } from 'vitest'
import {
  buildVinStart5bPayload,
  decodeCmdPayload,
  getActiveListenFlow,
  isRemoteStartListenFlow,
  isScanQrVinListenFlow,
  parseVinStart59Payload,
  setActiveListenFlow,
} from './protocol-executor'

describe('parseVinStart59Payload / buildVinStart5bPayload', () => {
  it('parses 0x59: time(6)+gun(1)+order(32) = 39 bytes', () => {
    const orderAscii = 'ORD-SCAN-VIN-20260525001'.padEnd(32, '\0')
    let hex = '1905190a0b0c' // time tag
    hex += '00' // gun 0
    hex += [...orderAscii].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    expect(hex.length).toBe(78)
    const parsed = parseVinStart59Payload(hex)
    expect(parsed).not.toBeNull()
    expect(parsed!.gunNo).toBe(0)
    expect(parsed!.orderNo).toBe('ORD-SCAN-VIN-20260525001')
    const d = decodeCmdPayload('0x59', hex) as Record<string, unknown>
    expect(String(d.orderNo ?? '').trim()).toBe('ORD-SCAN-VIN-20260525001')
  })

  it('builds 0x5b: 41 bytes with result and fail reason', () => {
    const hex = buildVinStart5bPayload('00', 'PO-123', 2, 6)
    expect(hex.length).toBe(82)
    const d = decodeCmdPayload('0x5b', hex) as Record<string, unknown>
    expect(d.gunNo).toBe(0)
    expect(String(d.orderNo ?? '').trim()).toBe('PO-123')
    expect(d.result).toBe(2)
    expect(d.failReason).toBe(6)
  })

  it('returns null when 0x59 order no is empty', () => {
    const hex = '1905190a0b0c00' + '0'.repeat(64)
    expect(parseVinStart59Payload(hex)).toBeNull()
  })
})

describe('active listen flow routing', () => {
  it('only scan-qr-vin-start enables 0x59 handler', () => {
    expect(isScanQrVinListenFlow('scan-qr-vin-start')).toBe(true)
    expect(isScanQrVinListenFlow('scan-qr-remote-start')).toBe(false)
    expect(isScanQrVinListenFlow('remote-start')).toBe(false)
    expect(isScanQrVinListenFlow(null)).toBe(false)
  })

  it('remote start flows include scan-qr-remote-start and remote-start', () => {
    expect(isRemoteStartListenFlow('scan-qr-remote-start')).toBe(true)
    expect(isRemoteStartListenFlow('remote-start')).toBe(true)
    expect(isRemoteStartListenFlow('scan-qr-vin-start')).toBe(false)
  })

  it('setActiveListenFlow tracks per pile', () => {
    setActiveListenFlow('P1', 'scan-qr-vin-start')
    expect(getActiveListenFlow('P1')).toBe('scan-qr-vin-start')
    setActiveListenFlow('P1', '')
    expect(getActiveListenFlow('P1')).toBeNull()
  })
})
