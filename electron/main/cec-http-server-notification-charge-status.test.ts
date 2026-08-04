import { afterEach, describe, expect, it } from 'vitest'
import { dispatchCecRequest } from './cec-http-server'
import { getCecSnapshot, setCecSnapshot } from './cec-state'
import { CEC_DEFAULT_PROTOCOL } from '../../src/shared/cec-default-protocol'
import { defaultCecSettings, type CecOrderRecord, type CecSnapshot } from '../../src/shared/cec-types'
import { decryptDataBase64, encryptDataJson, signEnvelope } from '../../src/shared/cec-crypto'

const LOCAL_SECRETS = {
  operatorId: 'LOCAL_OP',
  requestBaseUrl: 'http://localhost:9790',
  operatorSecret: 'local-operator-secret',
  sigSecret: 'local-sig-secret',
  dataSecret: '1234567890123456',
  dataSecretIV: 'abcdefghijklmnop',
}

const THIRD_SECRETS = {
  operatorId: 'THIRD_OP',
  operatorSecret: 'third-operator-secret',
  sigSecret: 'third-sig-secret',
  dataSecret: '1234567890123456',
  dataSecretIV: 'abcdefghijklmnop',
  interconnectionUrl: 'https://tp.example.com',
}

const LINK_UUID = 'link-uuid-1'
const START_CHARGE_SEQ = '232134123240000000000000001'

function makeOrder(): CecOrderRecord {
  return {
    id: 'order-1',
    linkUuid: LINK_UUID,
    startChargeSeq: START_CHARGE_SEQ,
    connectorId: '1',
    productState: 'charging',
    protocolState: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    samples: [],
    rawEvents: [],
  }
}

function makeBaseSnapshot(orders: CecOrderRecord[] = [makeOrder()]): CecSnapshot {
  return {
    settings: defaultCecSettings(),
    protocols: [CEC_DEFAULT_PROTOCOL],
    links: [
      {
        id: 'link-1',
        name: 'link-1',
        linkUuid: LINK_UUID,
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
    orders,
    logs: [],
    thirdPartyTokenByLink: {},
    inboundAuthTokenByLink: {},
    equipBusinessPolicyByKey: {},
    stationStatusByKey: {},
  }
}

function makeSignedRequestBody(dataObj: Record<string, unknown>): string {
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

describe('dispatchCecRequest notification_equip_charge_status', () => {
  const originalSnapshot = getCecSnapshot()

  afterEach(() => {
    setCecSnapshot(originalSnapshot)
  })

  it('accepts platform push without Bearer token and updates order samples', async () => {
    setCecSnapshot(makeBaseSnapshot())
    const rawBody = makeSignedRequestBody({
      StartChargeSeq: START_CHARGE_SEQ,
      StartChargeSeqStat: 2,
      ConnectorID: '1',
      ConnectorStatus: 3,
      CurrentA: 32,
      VoltageA: 380,
      Soc: 55.5,
      TotalPower: 12.34,
      ElecMoney: 10,
      SeviceMoney: 2,
      TotalMoney: 12,
    })

    const out = await dispatchCecRequest(
      LINK_UUID,
      'notification_equip_charge_status',
      rawBody,
      undefined,
      `/api/${LINK_UUID}/notification_equip_charge_status`,
    )

    expect(out.status).toBe(200)
    expect(out.body.Ret).toBe(0)

    const order = getCecSnapshot().orders.find((o) => o.id === 'order-1')
    expect(order?.samples).toHaveLength(1)
    expect(order?.samples[0]).toMatchObject({
      totalPower: 12.34,
      soc: 55.5,
      currentA: 32,
      voltageA: 380,
    })
    expect(order?.rawEvents.some((e) => e.name === 'notification_equip_charge_status')).toBe(true)
  })

  it('rejects when signature is invalid', async () => {
    setCecSnapshot(makeBaseSnapshot())
    const rawBody = makeSignedRequestBody({
      StartChargeSeq: START_CHARGE_SEQ,
      StartChargeSeqStat: 2,
      ConnectorID: '1',
    }).replace(/"Sig":"[0-9A-F]+"/, '"Sig":"00000000000000000000000000000000"')

    const out = await dispatchCecRequest(
      LINK_UUID,
      'notification_equip_charge_status',
      rawBody,
      undefined,
      `/api/${LINK_UUID}/notification_equip_charge_status`,
    )

    expect(out.status).toBe(403)
  })

  it('returns SuccStat=1 when order not found', async () => {
    setCecSnapshot(makeBaseSnapshot([]))
    const rawBody = makeSignedRequestBody({
      StartChargeSeq: START_CHARGE_SEQ,
      StartChargeSeqStat: 2,
      ConnectorID: '1',
    })

    const out = await dispatchCecRequest(
      LINK_UUID,
      'notification_equip_charge_status',
      rawBody,
      undefined,
      `/api/${LINK_UUID}/notification_equip_charge_status`,
    )

    expect(out.status).toBe(200)
    const enc = out.body.Data
    expect(typeof enc).toBe('string')
    const plain = JSON.parse(
      decryptDataBase64(String(enc), LOCAL_SECRETS.dataSecret, LOCAL_SECRETS.dataSecretIV),
    ) as Record<string, unknown>
    expect(plain.SuccStat).toBe(1)
  })
})
