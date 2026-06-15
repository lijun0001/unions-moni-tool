import { afterEach, describe, expect, it } from 'vitest'
import { invalidateInboundAuthToken, invalidateThirdPartyToken, isLikelyTokenBusinessFailure } from './cec-http-server'
import { getCecSnapshot, setCecSnapshot } from './cec-state'
import { defaultCecSettings, type CecSnapshot } from '../../src/shared/cec-types'
import { CEC_DEFAULT_PROTOCOL } from '../../src/shared/cec-default-protocol'

const LINK_UUID = 'link-token-1'

function makeSnapshot(): CecSnapshot {
  return {
    settings: defaultCecSettings(),
    protocols: [CEC_DEFAULT_PROTOCOL],
    links: [],
    stationsByLink: {},
    openStationIds: {},
    connectorMap: {},
    orders: [],
    logs: [],
    thirdPartyTokenByLink: {
      [LINK_UUID]: {
        linkUuid: LINK_UUID,
        accessToken: 'tp-token',
        expiresAtMs: Date.now() + 3600_000,
      },
    },
    inboundAuthTokenByLink: {
      [LINK_UUID]: {
        linkUuid: LINK_UUID,
        accessToken: 'in-token',
        issuedAtMs: Date.now(),
        expiresAtMs: Date.now() + 3600_000,
      },
    },
    equipBusinessPolicyByKey: {},
    stationStatusByKey: {},
  }
}

describe('token cache invalidation', () => {
  const original = getCecSnapshot()

  afterEach(() => {
    setCecSnapshot(original)
  })

  it('clears thirdParty and inbound tokens independently by linkUuid', () => {
    setCecSnapshot(makeSnapshot())
    invalidateThirdPartyToken(LINK_UUID)
    expect(getCecSnapshot().thirdPartyTokenByLink[LINK_UUID]).toBeUndefined()
    expect(getCecSnapshot().inboundAuthTokenByLink[LINK_UUID]?.accessToken).toBe('in-token')

    invalidateInboundAuthToken(LINK_UUID)
    expect(getCecSnapshot().inboundAuthTokenByLink[LINK_UUID]).toBeUndefined()
  })
})

describe('isLikelyTokenBusinessFailure', () => {
  it('treats Ret=4002 as token failure', () => {
    expect(isLikelyTokenBusinessFailure(4002, { Msg: 'token有误，请重新获取' })).toBe(true)
    expect(isLikelyTokenBusinessFailure(4002, {})).toBe(true)
  })
})
