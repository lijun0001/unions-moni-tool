import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { JxTopologyPile } from './types'

const STORAGE_KEY = 'jx-topology-piles-v1'

function gunIdByIndex(idx: number): string {
  return String.fromCharCode(65 + Math.max(0, idx))
}

function buildDefaultPile(protocolId: string, seq: number, gunCount = 2): JxTopologyPile {
  const pileId = String(seq).padStart(3, '0')
  return {
    pileId,
    protocolId,
    deviceKind: seq % 2 === 1 ? 'dc' : 'ac',
    tcpHost: '127.0.0.1',
    tcpPort: 9000 + seq,
    onlineState: 'offline',
    status: 'offline',
    heartbeatIntervalSec: 30,
    allowTimeoutCount: 3,
    pilePowerKw: 120,
    tariffModel: undefined,
    guns: Array.from({ length: Math.min(4, Math.max(1, gunCount)) }, (_, idx) => ({
      gunId: gunIdByIndex(idx),
      status: 'idle' as const,
      soc: undefined,
      qrCode: undefined,
    })),
  }
}

function normalizePile(input: JxTopologyPile, fallbackProtocolId: string, idx: number): JxTopologyPile {
  const seq = idx + 1
  return {
    pileId: input.pileId || String(seq).padStart(3, '0'),
    protocolId: input.protocolId || fallbackProtocolId,
    deviceKind: input.deviceKind ?? (seq % 2 === 1 ? 'dc' : 'ac'),
    tcpHost: input.tcpHost ?? '127.0.0.1',
    tcpPort: input.tcpPort ?? 9000 + seq,
    // 仅持久化设备配置；运行态(桩状态/枪状态/枪链接状态)不从缓存恢复
    onlineState: 'offline',
    status: 'offline',
    heartbeatIntervalSec: input.heartbeatIntervalSec ?? 30,
    allowTimeoutCount: input.allowTimeoutCount ?? 3,
    pilePowerKw: typeof input.pilePowerKw === 'number' ? input.pilePowerKw : 120,
    tariffModel:
      input.tariffModel && Array.isArray(input.tariffModel.periods)
        ? {
            version: Number(input.tariffModel.version ?? 0),
            parkingRate: Number(input.tariffModel.parkingRate ?? 0),
            periods: input.tariffModel.periods.map((x, idx) => ({
              index: Number(x.index ?? idx + 1),
              startHour: Number(x.startHour ?? 0),
              startMinute: Number(x.startMinute ?? 0),
              type: Number(x.type ?? 0),
              electricRate: Number(x.electricRate ?? 0),
              serviceRate: Number(x.serviceRate ?? 0),
            })),
            updatedAt: Number(input.tariffModel.updatedAt ?? Date.now()),
          }
        : undefined,
    guns: (input.guns?.length ? input.guns : buildDefaultPile(fallbackProtocolId, seq).guns).map((g, gIdx) => {
      const lastVinRaw = String(g.lastVin ?? '').trim().toUpperCase()
      const lastVin = lastVinRaw.length >= 8 ? lastVinRaw : undefined
      return {
        gunId: (() => {
          const raw = String(g.gunId ?? '').trim()
          if (/^\d+$/.test(raw)) return gunIdByIndex(Math.max(0, Number.parseInt(raw, 10) - 1))
          if (/^[a-z]$/i.test(raw)) return raw.toUpperCase()
          return gunIdByIndex(gIdx)
        })(),
        status: 'idle',
        vin: undefined,
        lastVin,
        soc: undefined,
        qrCode: typeof g.qrCode === 'string' ? g.qrCode : undefined,
      }
    }),
  }
}

export const useJxTopologyStore = defineStore('jx-topology', () => {
  const piles = ref<JxTopologyPile[]>([])
  const activePileId = ref<string | null>(null)
  const keyword = ref('')

  function syncActivePileSelection() {
    if (!activePileId.value) return
    if (!piles.value.some((x) => x.pileId === activePileId.value)) {
      activePileId.value = null
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(piles.value))
    } catch {
      // ignore persistence failure
    }
  }

  function hydrate(defaultProtocolId: string) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) {
        piles.value = [buildDefaultPile(defaultProtocolId, 1)]
        activePileId.value = null
        persist()
        return
      }
      const parsed = JSON.parse(raw) as JxTopologyPile[]
      if (!Array.isArray(parsed) || parsed.length === 0) {
        piles.value = [buildDefaultPile(defaultProtocolId, 1)]
      } else {
        piles.value = parsed.map((x, idx) => normalizePile(x, defaultProtocolId, idx))
      }
      syncActivePileSelection()
    } catch {
      piles.value = [buildDefaultPile(defaultProtocolId, 1)]
      activePileId.value = null
      persist()
    }
  }

  function resetToInitial(defaultProtocolId: string) {
    hydrate(defaultProtocolId)
  }

  const filteredPiles = computed(() => {
    const q = keyword.value.trim().toLowerCase()
    if (!q) return piles.value
    return piles.value.filter((p) =>
      [p.pileId, ...p.guns.map((g) => g.gunId), ...p.guns.map((g) => g.vin ?? ''), ...p.guns.map((g) => g.lastVin ?? '')]
        .join('|')
        .toLowerCase()
        .includes(q),
    )
  })

  const activePile = computed(() => piles.value.find((x) => x.pileId === activePileId.value) ?? null)

  function addPile(payload: {
    protocolId: string
    pileId: string
    tcpHost: string
    tcpPort: number
    gunCount: number
    pilePowerKw?: number
  }) {
    const exists = piles.value.some((x) => x.pileId === payload.pileId)
    if (exists) throw new Error('桩号已存在')
    const next = buildDefaultPile(payload.protocolId, piles.value.length + 1, payload.gunCount)
    next.pileId = payload.pileId
    next.tcpHost = payload.tcpHost
    next.tcpPort = payload.tcpPort
    next.onlineState = 'offline'
    next.status = 'offline'
    next.pilePowerKw = typeof payload.pilePowerKw === 'number' ? payload.pilePowerKw : 120
    piles.value.push(next)
    activePileId.value = next.pileId
    persist()
  }

  function setActivePile(id: string) {
    activePileId.value = id
  }

  function removePile(pileId: string) {
    const idx = piles.value.findIndex((x) => x.pileId === pileId)
    if (idx < 0) return
    piles.value.splice(idx, 1)
    if (!piles.value.length) {
      activePileId.value = null
    } else if (activePileId.value === pileId) {
      activePileId.value = null
    }
    persist()
  }

  function updatePileBasic(
    pileId: string,
    patch: Partial<Pick<JxTopologyPile, 'pileId' | 'protocolId' | 'tcpHost' | 'tcpPort' | 'pilePowerKw'>>,
  ) {
    const pile = piles.value.find((x) => x.pileId === pileId)
    if (!pile) throw new Error('未找到桩')

    const nextPileId = patch.pileId?.trim()
    if (nextPileId && nextPileId !== pileId) {
      const exists = piles.value.some((x) => x.pileId === nextPileId)
      if (exists) throw new Error('桩号已存在')
      pile.pileId = nextPileId
      if (activePileId.value === pileId) activePileId.value = nextPileId
    }

    if (typeof patch.protocolId === 'string' && patch.protocolId.trim()) {
      pile.protocolId = patch.protocolId.trim()
    }
    if (typeof patch.tcpHost === 'string' && patch.tcpHost.trim()) {
      pile.tcpHost = patch.tcpHost.trim()
    }
    if (typeof patch.tcpPort === 'number') {
      pile.tcpPort = patch.tcpPort
    }
    if (typeof patch.pilePowerKw === 'number') {
      pile.pilePowerKw = patch.pilePowerKw
    }
    persist()
  }

  /** TCP 断开或主动断链后：桩离线，枪回到空闲，清除车端关联（VIN/SOC），模拟重新进入前的拓扑运行态 */
  function resetRuntimeAfterDisconnect(pileId: string) {
    const pile = piles.value.find((x) => x.pileId === pileId)
    if (!pile) return
    pile.status = 'offline'
    pile.onlineState = 'offline'
    for (const g of pile.guns) {
      g.status = 'idle'
      g.vin = undefined
      g.soc = undefined
    }
    persist()
  }

  function applyStatePatch(
    pileId: string,
    patch: Partial<Pick<JxTopologyPile, 'status' | 'onlineState' | 'allowTimeoutCount' | 'heartbeatIntervalSec' | 'tariffModel'>> & {
      gunPatch?: Partial<JxTopologyPile['guns'][number]> & { gunId?: string }
    },
  ) {
    const pile = piles.value.find((x) => x.pileId === pileId)
    if (!pile) return
    const wasPileCharging = pile.status === 'charging'
    if (patch.status) pile.status = patch.status
    if (patch.onlineState) pile.onlineState = patch.onlineState
    if (typeof patch.allowTimeoutCount === 'number') pile.allowTimeoutCount = patch.allowTimeoutCount
    if (typeof patch.heartbeatIntervalSec === 'number') pile.heartbeatIntervalSec = patch.heartbeatIntervalSec
    if (patch.tariffModel !== undefined) pile.tariffModel = patch.tariffModel
    if (patch.status && wasPileCharging && patch.status !== 'charging') {
      for (const g of pile.guns) {
        g.soc = undefined
      }
    }
    if (patch.gunPatch?.gunId) {
      const gun = pile.guns.find((g) => g.gunId === patch.gunPatch?.gunId)
      if (gun) {
        const wasGunCharging = gun.status === 'charging'
        Object.assign(gun, patch.gunPatch)
        if (wasGunCharging && gun.status !== 'charging' && patch.gunPatch.soc === undefined) {
          gun.soc = undefined
        }
      }
    }
    persist()
  }

  hydrate('jx-v2.24-core')

  return {
    piles,
    activePileId,
    activePile,
    keyword,
    filteredPiles,
    addPile,
    removePile,
    updatePileBasic,
    setActivePile,
    applyStatePatch,
    persist,
    resetToInitial,
    resetRuntimeAfterDisconnect,
  }
})

