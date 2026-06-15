import { afterEach, describe, expect, it } from 'vitest'
import { dispatchCecRequest, matchInboundQueryTokenCredentials } from './cec-http-server'
import { getCecSnapshot, setCecSnapshot } from './cec-state'
import { CEC_DEFAULT_PROTOCOL } from '../../src/shared/cec-default-protocol'
import { defaultCecSettings, type CecLinkConfig, type CecSnapshot } from '../../src/shared/cec-types'
import { decryptDataBase64, encryptDataJson, signEnvelope } from '../../src/shared/cec-crypto'

const LOCAL_SECRETS = {
  operatorId: 'MAETDLTA3',
  requestBaseUrl: 'http://localhost:9790',
  operatorSecret: 'local-operator-secret',
  sigSecret: 'local-sig-secret',
  dataSecret: '1234567890123456',
  dataSecretIV: 'abcdefghijklmnop',
}

const THIRD_SECRETS = {
  operatorId: 'THIRD_OP',
  operatorSecret: 'tCgz4NyUPowd7NCo',
  sigSecret: 'third-sig-secret',
  dataSecret: '1234567890123456',
  dataSecretIV: 'abcdefghijklmnop',
  interconnectionUrl: 'https://tp.example.com',
}

function makeBaseSnapshot(): CecSnapshot {
  return {
    settings: defaultCecSettings(),
    protocols: [CEC_DEFAULT_PROTOCOL],
    links: [
      {
        id: 'link-1',
        name: 'link-1',
        linkUuid: 'link-uuid-1',
        protocolId: CEC_DEFAULT_PROTOCOL.protocolId,
        local: LOCAL_SECRETS,
        thirdParty: THIRD_SECRETS,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    stationsByLink: {},
    openStationIds: {},
    connectorMap: {},
    orders: [],
    logs: [],
    thirdPartyTokenByLink: {},
    inboundAuthTokenByLink: {},
    equipBusinessPolicyByKey: {},
    stationStatusByKey: {},
  }
}

function makeSignedQueryTokenBody(dataObj: Record<string, unknown>): string {
  const timeStamp = '20260422120000'
  const seq = '0001'
  const dataRaw = encryptDataJson(
    JSON.stringify(dataObj),
    LOCAL_SECRETS.dataSecret,
    LOCAL_SECRETS.dataSecretIV,
  )
  const sig = signEnvelope(
    LOCAL_SECRETS.operatorId,
    dataRaw,
    timeStamp,
    seq,
    LOCAL_SECRETS.sigSecret,
  )
  return JSON.stringify({
    OperatorID: LOCAL_SECRETS.operatorId,
    TimeStamp: timeStamp,
    Seq: seq,
    Sig: sig,
    Data: dataRaw,
  })
}

describe('matchInboundQueryTokenCredentials', () => {
  const link = makeBaseSnapshot().links[0] as CecLinkConfig

  it('accepts only thirdParty OperatorID + local OperatorSecret', () => {
    expect(
      matchInboundQueryTokenCredentials(link, THIRD_SECRETS.operatorId, LOCAL_SECRETS.operatorSecret),
    ).toBe(true)
    expect(
      matchInboundQueryTokenCredentials(link, THIRD_SECRETS.operatorId, THIRD_SECRETS.operatorSecret),
    ).toBe(false)
    expect(
      matchInboundQueryTokenCredentials(link, LOCAL_SECRETS.operatorId, LOCAL_SECRETS.operatorSecret),
    ).toBe(false)
  })
})

describe('dispatchCecRequest query_token', () => {
  const originalSnapshot = getCecSnapshot()

  afterEach(() => {
    setCecSnapshot(originalSnapshot)
  })

  it('issues inbound token for thirdParty OperatorID + local OperatorSecret', async () => {
    setCecSnapshot(makeBaseSnapshot())
    const rawBody = makeSignedQueryTokenBody({
      OperatorID: THIRD_SECRETS.operatorId,
      OperatorSecret: LOCAL_SECRETS.operatorSecret,
    })

    const out = await dispatchCecRequest(
      'link-uuid-1',
      'query_token',
      rawBody,
      undefined,
      '/api/link-uuid-1/query_token',
    )

    expect(out.status).toBe(200)
    expect(out.body.Ret).toBe(0)
    const plain = decryptDataBase64(
      String(out.body.Data ?? ''),
      LOCAL_SECRETS.dataSecret,
      LOCAL_SECRETS.dataSecretIV,
    )
    const data = JSON.parse(plain) as Record<string, unknown>
    expect(data.SuccStat).toBe(0)
    expect(data.OperatorID).toBe(THIRD_SECRETS.operatorId)
    expect(String(data.AccessToken ?? '')).toMatch(/^local-link-uuid-1-/)
    expect(Number(data.TokenAvailableTime ?? 0)).toBeGreaterThan(0)

    const cached = getCecSnapshot().inboundAuthTokenByLink['link-uuid-1']
    expect(cached?.accessToken).toBe(String(data.AccessToken))
  })

  it('returns Ret=4003 when FailReason is 1 (unknown operator)', async () => {
    setCecSnapshot(makeBaseSnapshot())
    const rawBody = makeSignedQueryTokenBody({
      OperatorID: 'UNKNOWN_OP',
      OperatorSecret: 'wrong-secret',
    })

    const out = await dispatchCecRequest(
      'link-uuid-1',
      'query_token',
      rawBody,
      undefined,
      '/api/link-uuid-1/query_token',
    )

    expect(out.status).toBe(200)
    expect(out.body.Ret).toBe(4003)
    const plain = decryptDataBase64(
      String(out.body.Data ?? ''),
      LOCAL_SECRETS.dataSecret,
      LOCAL_SECRETS.dataSecretIV,
    )
    const data = JSON.parse(plain) as Record<string, unknown>
    expect(data.FailReason).toBe(1)
    expect(data.SuccStat).toBe(1)
  })

  it('returns Ret=4003 when FailReason is 2 (wrong secret)', async () => {
    setCecSnapshot(makeBaseSnapshot())
    const rawBody = makeSignedQueryTokenBody({
      OperatorID: THIRD_SECRETS.operatorId,
      OperatorSecret: 'wrong-secret',
    })

    const out = await dispatchCecRequest(
      'link-uuid-1',
      'query_token',
      rawBody,
      undefined,
      '/api/link-uuid-1/query_token',
    )

    expect(out.status).toBe(200)
    expect(out.body.Ret).toBe(4003)
    const plain = decryptDataBase64(
      String(out.body.Data ?? ''),
      LOCAL_SECRETS.dataSecret,
      LOCAL_SECRETS.dataSecretIV,
    )
    const data = JSON.parse(plain) as Record<string, unknown>
    expect(data.FailReason).toBe(2)
    expect(data.SuccStat).toBe(1)
  })
})
