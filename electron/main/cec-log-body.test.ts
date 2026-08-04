import { describe, expect, it } from 'vitest'
import { serializeCecLogBody } from './cec-http-server'

function makeLargeStationInfos(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    StationID: `ST${i}`,
    StationName: `站点-${i}-`.repeat(40),
    EquipmentInfos: Array.from({ length: 5 }, (_, j) => ({
      EquipmentID: `EQ${i}-${j}`,
      ConnectorInfos: Array.from({ length: 4 }, (_, k) => ({
        ConnectorID: `${i}-${j}-${k}`,
        ConnectorName: `枪-${i}-${j}-${k}-`.repeat(20),
      })),
    })),
  }))
}

describe('serializeCecLogBody', () => {
  it('keeps valid JSON for large query_stations_info inbound log', () => {
    const body = serializeCecLogBody({
      kind: 'cec_inbound_http',
      linkUuid: 'link-1',
      action: 'query_stations_info',
      requestUrl: '/api/link-1/query_stations_info',
      paramsPlain: { PageNo: 1, PageSize: 10 },
      requestEnvelopeCipher: '{"OperatorID":"OP","Data":"cipher"}',
      responsePlain: {
        PageNo: 1,
        PageCount: 10,
        ItemSize: 100,
        StationInfos: makeLargeStationInfos(50),
      },
      responseCipher: {
        Ret: 0,
        Data: 'x'.repeat(12000),
        Sig: 'ABCDEF0123456789ABCDEF0123456789',
      },
    })

    expect(body.length).toBeLessThanOrEqual(16_000)
    const parsed = JSON.parse(body) as Record<string, unknown>
    expect(parsed.kind).toBe('cec_inbound_http')
    expect(parsed.requestEnvelopeCipher).toBeTruthy()
    expect(parsed.responseCipher).toBeTruthy()
  })

  it('keeps valid JSON for large query_stations_info outbound log', () => {
    const body = serializeCecLogBody({
      kind: 'cec_outbound_http',
      name: 'query_stations_info',
      requestUrl: 'http://127.0.0.1:8080/query_stations_info',
      requestPlain: { PageNo: 1, PageSize: 10 },
      requestCipher: { OperatorID: 'OP', Data: 'cipher', Sig: 'SIG' },
      responsePlain: {
        PageNo: 1,
        StationInfos: makeLargeStationInfos(40),
      },
      responseCipher: 'y'.repeat(15000),
    })

    expect(body.length).toBeLessThanOrEqual(16_000)
    const parsed = JSON.parse(body) as Record<string, unknown>
    expect(parsed.kind).toBe('cec_outbound_http')
    expect(parsed.requestCipher).toBeTruthy()
    expect(parsed.responseCipher).toBeTruthy()
  })
})
