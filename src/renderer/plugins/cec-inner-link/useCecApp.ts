import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import localforage from 'localforage'
import { CEC_DEFAULT_PROTOCOL } from '@shared/cec-default-protocol'
import {
  defaultCecSettings,
  normalizeCecLink,
  type CecLinkConfig,
  type CecSnapshot,
  type CecThirdPartyTokenEntry,
} from '@shared/cec-types'

/** 持久化旧数据无 linkUuid 时，用 Record 键（对接码）补齐 */
function normalizeThirdPartyTokenByLink(
  raw: Record<string, CecThirdPartyTokenEntry> | undefined,
): Record<string, CecThirdPartyTokenEntry> {
  if (!raw) return {}
  const out: Record<string, CecThirdPartyTokenEntry> = {}
  for (const [k, v] of Object.entries(raw)) {
    out[k] = {
      linkUuid: v.linkUuid ?? k,
      accessToken: v.accessToken,
      expiresAtMs: v.expiresAtMs,
    }
  }
  return out
}

/**
 * v5：当前正式键。自 v4 及更早键迁移时同样清空站点/枪映射/开放列表/费率缓存，
 * 确保已写入 v4 的用户在本版也会一次性丢弃旧站点数据。
 */
const LF_KEY = 'cec_snapshot_v5'

const store = localforage.createInstance({
  name: 'unions-moni-tool',
  storeName: 'cec_inner_link',
})

type CecInvokeAction = Parameters<typeof window.unions.cecInvoke>[0]

function defaultSnapshot(): CecSnapshot {
  return {
    settings: defaultCecSettings(),
    protocols: [CEC_DEFAULT_PROTOCOL],
    links: [],
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

/** 去掉 Vue Proxy，供 IndexedDB / Electron IPC 结构化克隆 */
function toPlainSnapshot(s: CecSnapshot): CecSnapshot {
  return JSON.parse(JSON.stringify(s)) as CecSnapshot
}

export function useCecApp() {
  const snapshot = ref<CecSnapshot>(defaultSnapshot())
  const httpRunning = ref(false)
  const pullTimer = ref<ReturnType<typeof setInterval> | null>(null)

  function invokeCec<T>(action: CecInvokeAction, data?: unknown): Promise<T> {
    return window.unions.cecInvoke(action, data) as Promise<T>
  }

  async function loadLocal() {
    let data = await store.getItem<CecSnapshot>(LF_KEY)
    let migratedFromOlder = false
    if (!data) {
      const v4 = await store.getItem<CecSnapshot>('cec_snapshot_v4')
      const v3 = await store.getItem<CecSnapshot>('cec_snapshot_v3')
      const v2 = await store.getItem<CecSnapshot>('cec_snapshot_v2')
      const v1 = await store.getItem<CecSnapshot>('cec_snapshot_v1')
      data = v4 ?? v3 ?? v2 ?? v1
      if (data) migratedFromOlder = true
    }
    if (data) {
      if (migratedFromOlder) {
        data = {
          ...data,
          stationsByLink: {},
          connectorMap: {},
          openStationIds: {},
          equipBusinessPolicyByKey: {},
          stationStatusByKey: {},
        }
      }
      if (!data.protocols?.length) data.protocols = [CEC_DEFAULT_PROTOCOL]
      const maxLog = data.settings?.logMaxEntries ?? defaultCecSettings().logMaxEntries
      const logs = (data.logs ?? []).slice(-maxLog)
      snapshot.value = {
        ...defaultSnapshot(),
        ...data,
        protocols: data.protocols,
        orders: data.orders ?? [],
        logs,
        stationsByLink: data.stationsByLink ?? {},
        openStationIds: data.openStationIds ?? {},
        connectorMap: data.connectorMap ?? {},
        thirdPartyTokenByLink: normalizeThirdPartyTokenByLink(data.thirdPartyTokenByLink),
        inboundAuthTokenByLink: data.inboundAuthTokenByLink ?? {},
        equipBusinessPolicyByKey: data.equipBusinessPolicyByKey ?? {},
        stationStatusByKey: data.stationStatusByKey ?? {},
        links: (data.links ?? []).map((l) => normalizeCecLink(l)),
      }
    }
  }

  async function persist() {
    const maxLog = snapshot.value.settings.logMaxEntries ?? defaultCecSettings().logMaxEntries
    const plain = toPlainSnapshot({
      ...snapshot.value,
      logs: snapshot.value.logs.slice(-maxLog),
    })
    await store.setItem(LF_KEY, plain)
  }

  let pushTimer: ReturnType<typeof setTimeout> | null = null
  function schedulePushMain() {
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = setTimeout(async () => {
      pushTimer = null
      await invokeCec<{ ok: boolean }>('pushSnapshot', toPlainSnapshot(snapshot.value))
    }, 120)
  }

  watch(
    snapshot,
    () => {
      void persist()
      schedulePushMain()
    },
    { deep: true },
  )

  async function refreshHttpStatus() {
    const s = await invokeCec<{ running: boolean }>('httpStatus')
    httpRunning.value = s.running
  }

  async function startHttp() {
    const port = snapshot.value.settings.httpPort
    const host = snapshot.value.settings.bindHost
    const res = await invokeCec<{ ok: true; port: number } | { ok: false; error: string }>('httpStart', {
      port,
      host,
    })
    if (res.ok) httpRunning.value = true
    return res
  }

  async function stopHttp() {
    await invokeCec<{ ok: boolean }>('httpStop')
    httpRunning.value = false
  }

  async function clearLogsEverywhere() {
    const r = await invokeCec<{ ok: boolean; error?: string }>('clearLogs')
    if (!r.ok) throw new Error(r.error || '清空日志失败')
    snapshot.value.logs = []
  }

  async function deleteOrderEverywhere(orderId: string) {
    const r = await invokeCec<{ ok: boolean; error?: string }>('deleteOrder', { orderId })
    if (!r.ok) throw new Error(r.error || '删除订单失败')
    snapshot.value.orders = snapshot.value.orders.filter((o) => o.id !== orderId)
  }

  /** 与主进程对齐订单与日志 */
  async function pullMainMerge() {
    const main = await invokeCec<CecSnapshot>('getSnapshot')
    snapshot.value.orders = main.orders
    snapshot.value.logs = main.logs
    snapshot.value.stationsByLink = { ...main.stationsByLink }
    snapshot.value.connectorMap = { ...main.connectorMap }
    snapshot.value.thirdPartyTokenByLink = normalizeThirdPartyTokenByLink(main.thirdPartyTokenByLink)
    snapshot.value.inboundAuthTokenByLink = { ...(main.inboundAuthTokenByLink ?? {}) }
    snapshot.value.equipBusinessPolicyByKey = { ...(main.equipBusinessPolicyByKey ?? {}) }
    snapshot.value.stationStatusByKey = { ...(main.stationStatusByKey ?? {}) }
  }

  let offLog: (() => void) | null = null

  onMounted(async () => {
    await loadLocal()
    await invokeCec<{ ok: boolean }>('pushSnapshot', toPlainSnapshot(snapshot.value))
    await refreshHttpStatus()
    pullTimer.value = setInterval(() => {
      void pullMainMerge()
    }, 2000)
    offLog = window.unions.onCecLog(() => {
      void pullMainMerge()
    })
  })

  onUnmounted(() => {
    if (pullTimer.value) clearInterval(pullTimer.value)
    if (pushTimer) clearTimeout(pushTimer)
    offLog?.()
  })

  function importProtocolJson(text: string) {
    const obj = JSON.parse(text) as CecSnapshot['protocols'][0]
    if (!obj.protocolId) throw new Error('invalid protocol')
    const normalized = {
      ...obj,
      importedAt: Date.now(),
    }
    const next = snapshot.value.protocols.filter((p) => p.protocolId !== obj.protocolId)
    next.push(normalized)
    snapshot.value.protocols = next
  }

  function removeProtocolById(protocolId: string) {
    snapshot.value.protocols = snapshot.value.protocols.filter((p) => p.protocolId !== protocolId)
  }

  /** 16 位无分隔符随机串（与对接码同规则），用于秘钥类字段默认值 */
  function genSecret16(): string {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  }

  function genLinkUuid(): string {
    return genSecret16()
  }

  function defaultRequestBase(link: CecLinkConfig): string {
    const port = snapshot.value.settings.httpPort
    return `http://127.0.0.1:${port}/api/${link.linkUuid}`
  }

  function upsertLink(link: CecLinkConfig) {
    const idx = snapshot.value.links.findIndex((l) => l.id === link.id)
    if (idx >= 0) snapshot.value.links.splice(idx, 1, link)
    else snapshot.value.links.push(link)
  }

  function removeLink(id: string) {
    snapshot.value.links = snapshot.value.links.filter((l) => l.id !== id)
  }

  const openStationsFlat = computed(() => {
    const out: { linkUuid: string; station: CecSnapshot['stationsByLink'][string][0] }[] = []
    for (const link of snapshot.value.links) {
      const stations = snapshot.value.stationsByLink[link.linkUuid] ?? []
      const open = new Set(snapshot.value.openStationIds[link.linkUuid] ?? [])
      for (const st of stations) {
        if (open.has(String(st.StationID ?? ''))) out.push({ linkUuid: link.linkUuid, station: st })
      }
    }
    return out
  })

  return {
    snapshot,
    httpRunning,
    loadLocal,
    persist,
    startHttp,
    stopHttp,
    clearLogsEverywhere,
    deleteOrderEverywhere,
    refreshHttpStatus,
    pullMainMerge,
    importProtocolJson,
    removeProtocolById,
    genLinkUuid,
    genSecret16,
    defaultRequestBase,
    upsertLink,
    removeLink,
    openStationsFlat,
    invokeCec,
  }
}
