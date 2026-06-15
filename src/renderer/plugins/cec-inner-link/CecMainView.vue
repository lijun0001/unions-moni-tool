<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { TableInstance } from 'element-plus'
import {
  ArrowLeft,
  CircleCheck,
  CircleClose,
  Coin,
  Document,
  DocumentCopy,
  Lightning,
  Setting,
  VideoPause,
  VideoPlay,
} from '@element-plus/icons-vue'
import * as echarts from 'echarts'
import {
  findConflictingInterconnectionLink,
  normalizeCecLink,
  type CecConnectorStatusInfo,
  type CecLinkConfig,
  type CecLogEntry,
  type CecOrderRecord,
  type CecProtocolMapping,
  type CecStationRecord,
  type CecInboundAuthTokenEntry,
  type CecThirdPartyTokenEntry,
  type CecThirdPartySecrets,
} from '@shared/cec-types'
import { policySevicePrice, resolveCurrentPolicyPeriod } from '@shared/cec-policy-utils'
import { useCecApp } from './useCecApp'

const CEC_DEFAULT_ID = 'cec-union-v1'

const {
  snapshot,
  httpRunning,
  startHttp,
  stopHttp,
  clearLogsEverywhere,
  deleteOrderEverywhere,
  refreshHttpStatus,
  importProtocolJson,
  removeProtocolById,
  genLinkUuid,
  genSecret16,
  defaultRequestBase,
  upsertLink,
  removeLink,
  openStationsFlat,
  invokeCec,
  pullMainMerge,
} = useCecApp()

/** 中区：业务展示 */
const bizPanel = ref<'stations' | 'orders'>('stations')
/** 右侧极简菜单展开态 */
const rightPanel = ref<'none' | 'links' | 'logs'>('none')

const pullDialogOpen = ref(false)
const pullLinkUuid = ref('')
/** 拉取站点全屏遮罩是否显示（含结束动画阶段） */
const pullOverlayActive = ref(false)
/** fetching：分页进行中；result：仅在原百分比数字位置显示打勾/打叉（其余 UI 不变） */
const pullUiPhase = ref<'fetching' | 'result'>('fetching')
const PULL_RESULT_HOLD_MS = 1000
/** 进度条展示值（平滑插值）；IPC 更新的是 pullFillPercentTarget */
const pullFillPercent = ref(0)
const pullFillPercentTarget = ref(0)
let pullSmoothRafId: number | null = null
let pullSmoothLastTs = 0

function stopPullPercentSmoothing() {
  if (pullSmoothRafId !== null) {
    cancelAnimationFrame(pullSmoothRafId)
    pullSmoothRafId = null
  }
  pullSmoothLastTs = 0
}

function pullPercentSmoothingFrame(ts: number) {
  if (pullSmoothLastTs === 0) {
    pullSmoothLastTs = ts
    pullSmoothRafId = requestAnimationFrame(pullPercentSmoothingFrame)
    return
  }
  const dt = Math.min(0.08, (ts - pullSmoothLastTs) / 1000)
  pullSmoothLastTs = ts

  const target = pullFillPercentTarget.value
  const cur = pullFillPercent.value
  const diff = target - cur
  if (Math.abs(diff) < 0.04) {
    pullFillPercent.value = target
    pullSmoothRafId = null
    pullSmoothLastTs = 0
    return
  }
  const lambda = 14
  pullFillPercent.value = cur + diff * (1 - Math.exp(-lambda * dt))
  pullSmoothRafId = requestAnimationFrame(pullPercentSmoothingFrame)
}

function ensurePullPercentSmoothing() {
  if (pullSmoothRafId !== null) return
  pullSmoothLastTs = 0
  pullSmoothRafId = requestAnimationFrame(pullPercentSmoothingFrame)
}

async function waitPullPercentSettled(maxMs = 15000) {
  ensurePullPercentSmoothing()
  const t0 = performance.now()
  while (performance.now() - t0 < maxMs) {
    if (Math.abs(pullFillPercent.value - pullFillPercentTarget.value) < 0.06) {
      pullFillPercent.value = pullFillPercentTarget.value
      stopPullPercentSmoothing()
      return
    }
    await delay(16)
  }
  pullFillPercent.value = pullFillPercentTarget.value
  stopPullPercentSmoothing()
}

const pullOutcomeOk = ref(true)
const pullPageSize = ref(200)
const pullAwaitingFirstPage = ref(true)
const pullProgressHint = ref('')

/** 站点详情：详情按钮 / 双击站点行打开 */
const stationDetailOpen = ref(false)
const stationDetailCtx = ref<{ linkName: string; linkUuid: string; station: CecStationRecord } | null>(null)
const stationDetailTab = ref<'station' | 'pile' | 'policy'>('station')
const stationDetailFilter = ref('')
const policyFilter = ref('')
const policyTimeTick = ref(0)
const policySyncingConnector = ref<string | null>(null)
const policySyncAllLoading = ref(false)
const equipmentTableRef = ref<TableInstance | null>(null)
const stationTableRef = ref<TableInstance | null>(null)

type StationRowVM = { linkName: string; linkUuid: string; station: CecStationRecord }
const stationSelection = ref<StationRowVM[]>([])

type CecConnectorRow = {
  ConnectorID: string
  ConnectorName?: string
  ConnectorType?: number
  VoltageUpperLimits?: number
  VoltageLowerLimits?: number
  Current?: number
  Power?: number
  ParkNo?: string
  NationalStandard?: number
}

type CecEquipmentTableRow = {
  rowKey: string
  EquipmentID: string
  EquipmentName?: string
  EquipmentModel?: string
  ManufacturerName?: string
  EquipmentType?: number
  Power?: number
  ConnectorInfos: CecConnectorRow[]
}

/** 站点查看：筛选与分页 */
const stationKeyword = ref('')
const stationLinkFilter = ref('')
const stationPage = ref(1)
const stationPageSize = ref(10)

/** 站点列表列头排序（点击表头切换正/倒序，小三角指示当前方向） */
type StationSortColumn = 'link' | 'id' | 'name' | 'area' | 'st' | 'open' | 'dev'
const stationSortKey = ref<StationSortColumn | null>(null)
const stationSortOrder = ref<'asc' | 'desc'>('asc')

function toggleStationSort(key: StationSortColumn) {
  if (stationSortKey.value === key) {
    stationSortOrder.value = stationSortOrder.value === 'asc' ? 'desc' : 'asc'
  } else {
    stationSortKey.value = key
    stationSortOrder.value = 'asc'
  }
  stationPage.value = 1
}

function compareStationCellStr(a: string, b: string): number {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' })
}

/** 互联互通配置列表：筛选与分页（与站点列表一致） */
const linkKeyword = ref('')
const linkPage = ref(1)
const linkPageSize = ref(10)

const filteredLinks = computed(() => {
  const kw = linkKeyword.value.trim().toLowerCase()
  const list = snapshot.value.links
  if (!kw) return list
  return list.filter((l) => {
    const hay = [l.name, l.linkUuid].join(' ').toLowerCase()
    return hay.includes(kw)
  })
})

const pagedLinks = computed(() => {
  const start = (linkPage.value - 1) * linkPageSize.value
  return filteredLinks.value.slice(start, start + linkPageSize.value)
})

watch(linkKeyword, () => {
  linkPage.value = 1
})

watch([filteredLinks, linkPageSize], () => {
  const maxPage = Math.max(1, Math.ceil(filteredLinks.value.length / linkPageSize.value) || 1)
  if (linkPage.value > maxPage) linkPage.value = maxPage
})

/** 订单查看：筛选与分页 */
const orderSeqFilter = ref('')
const orderPage = ref(1)
const orderPageSize = ref(10)
const syncingOrderId = ref<string | null>(null)
const cfgOpen = ref(false)
const cfgSection = ref<'http' | 'logs' | 'import'>('http')

const linkDialog = ref(false)
const editingLink = ref<CecLinkConfig | null>(null)
const linkImportInputRef = ref<HTMLInputElement | null>(null)

const tokenDialogOpen = ref(false)
const tokenDialogLink = ref<CecLinkConfig | null>(null)

const tokenDialogInbound = computed((): CecInboundAuthTokenEntry | null => {
  const uuid = tokenDialogLink.value?.linkUuid
  if (!uuid) return null
  return snapshot.value.inboundAuthTokenByLink?.[uuid] ?? null
})

const tokenDialogThirdParty = computed((): CecThirdPartyTokenEntry | null => {
  const uuid = tokenDialogLink.value?.linkUuid
  if (!uuid) return null
  return snapshot.value.thirdPartyTokenByLink?.[uuid] ?? null
})

type TokenPresence = 'none' | 'valid' | 'expired'

function tokenEntryPresence(
  entry: CecInboundAuthTokenEntry | CecThirdPartyTokenEntry | null | undefined,
): TokenPresence {
  if (!entry?.accessToken) return 'none'
  return entry.expiresAtMs > Date.now() ? 'valid' : 'expired'
}

function tokenPresenceLabel(presence: TokenPresence): string {
  if (presence === 'valid') return '有效'
  if (presence === 'expired') return '已过期'
  return '未生成'
}

function formatTokenExpiresAt(ms: number): string {
  return new Date(ms).toLocaleString()
}

function openTokenDialog(row: CecLinkConfig) {
  tokenDialogLink.value = row
  tokenDialogOpen.value = true
  void pullMainMerge()
}

async function clearInboundTokenInDialog() {
  const link = tokenDialogLink.value
  if (!link) return
  const entry = tokenDialogInbound.value
  if (!entry?.accessToken) {
    ElMessage.info('暂无内部 token')
    return
  }
  try {
    await ElMessageBox.confirm('确认使内部 token 立即失效并清除？', '清除内部 Token', {
      type: 'warning',
      confirmButtonText: '清除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    const r = await invokeCec<{ ok: boolean; error?: string }>('clearInboundToken', { linkUuid: link.linkUuid })
    if (!r.ok) throw new Error(r.error || '清除失败')
    await pullMainMerge()
    ElMessage.success('内部 token 已清除')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
  }
}

async function clearThirdPartyTokenInDialog() {
  const link = tokenDialogLink.value
  if (!link) return
  const entry = tokenDialogThirdParty.value
  if (!entry?.accessToken) {
    ElMessage.info('暂无三方 token')
    return
  }
  try {
    await ElMessageBox.confirm('确认使三方 token 立即失效并清除？', '清除三方 Token', {
      type: 'warning',
      confirmButtonText: '清除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    const r = await invokeCec<{ ok: boolean; error?: string }>('clearThirdPartyToken', { linkUuid: link.linkUuid })
    if (!r.ok) throw new Error(r.error || '清除失败')
    await pullMainMerge()
    ElMessage.success('三方 token 已清除')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
  }
}

/** 手机模拟：启动充电全屏页与确认弹窗 */
const phoneStartMode = ref<'scan' | 'device'>('scan')
const startMoneyScanStr = ref('')
const startMoneyDeviceStr = ref('')
const startDeviceIdInput = ref('')
const pendingQrText = ref('')
const scanConnectorId = ref('')
const qrResolving = ref(false)
const startConfirmDialogOpen = ref(false)
const fileInputStartRef = ref<HTMLInputElement | null>(null)
/** 进入「启动充电」页面前的 Tab（充电 / 订单），用于返回 */
const phoneNavBeforeStart = ref<'charge' | 'orders'>('charge')
/** 进入「实时充电」页面前的 Tab（充电 / 订单），用于返回 */
const phoneNavBeforeLive = ref<'charge' | 'orders'>('charge')

/** 本地 HTTP 未启动时，由引导精灵提示用户先点顶部启动按钮 */
const httpGuideVisible = ref(false)
const httpGuideAction = ref<'start' | 'stop' | null>(null)
const pendingStopOrderId = ref<string | null>(null)

function enterPhoneStartChargeScreen() {
  if (phoneNav.value === 'charge' || phoneNav.value === 'orders') {
    phoneNavBeforeStart.value = phoneNav.value
  }
  phoneNav.value = 'startCharge'
}

function enterLiveChargeScreen(targetOrder?: CecOrderRecord) {
  if (phoneNav.value === 'charge' || phoneNav.value === 'orders') {
    phoneNavBeforeLive.value = phoneNav.value
  }
  if (targetOrder) liveOrder.value = targetOrder
  phoneNav.value = 'liveCharge'
}

function dismissHttpGuide() {
  httpGuideVisible.value = false
  httpGuideAction.value = null
  pendingStopOrderId.value = null
}

async function openPhoneStartChargeDrawer() {
  await refreshHttpStatus()
  if (!httpRunning.value) {
    httpGuideAction.value = 'start'
    httpGuideVisible.value = true
    return
  }
  enterPhoneStartChargeScreen()
}

watch(httpRunning, (on) => {
  if (on && httpGuideVisible.value) {
    httpGuideVisible.value = false
    if (httpGuideAction.value === 'stop') {
      const targetId = pendingStopOrderId.value
      httpGuideAction.value = null
      pendingStopOrderId.value = null
      if (targetId && liveOrder.value?.id === targetId) {
        void stopLiveOrder()
      }
      return
    }
    httpGuideAction.value = null
    enterPhoneStartChargeScreen()
  }
})

function closePhoneStartChargeScreen() {
  phoneNav.value = phoneNavBeforeStart.value
}

function closePhoneLiveChargeScreen() {
  phoneNav.value = phoneNavBeforeLive.value
}

const liveOrder = ref<CecOrderRecord | null>(null)
const stopSubmittingOrderId = ref<string | null>(null)
const stopWaitOrderId = ref<string | null>(null)
const stopWaitStartedAt = ref(0)
let stopWaitTimer: ReturnType<typeof setTimeout> | null = null
const chartRef = ref<HTMLDivElement | null>(null)
const chartPowerRef = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null
let chartPower: echarts.ECharts | null = null

const logFilter = ref('')
const expandedLogs = ref<Record<string, boolean>>({})
/** 每条日志独立：false=明文（加密前请求 / 解密后响应），true=密文（HTTP 原文与信封） */
const logCipherViewById = ref<Record<string, boolean>>({})

function setLogCipherView(id: string, cipher: boolean) {
  logCipherViewById.value = { ...logCipherViewById.value, [id]: cipher }
}

function isLogCipherMode(logId: string): boolean {
  return logCipherViewById.value[logId] === true
}

function logShowsPlainCipherToggle(log: CecLogEntry): boolean {
  try {
    const o = JSON.parse(log.body) as Record<string, unknown>
    if (o.kind === 'cec_inbound_http' || o.kind === 'cec_outbound_http') return true
    if (o.params != null && typeof o.raw === 'string') return true
  } catch {
    return false
  }
  return false
}

function prettyLogJson(v: unknown): string {
  if (v === undefined || v === null) return '(空)'
  if (typeof v === 'string') {
    const t = v.trim()
    if (
      (t.startsWith('{') && t.endsWith('}')) ||
      (t.startsWith('[') && t.endsWith(']'))
    ) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2)
      } catch {
        return v
      }
    }
    return v
  }
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

const orderDetail = ref<CecOrderRecord | null>(null)
const detailVisible = ref(false)
const orderDetailTab = ref<'info' | 'process'>('info')

type ProcessNotifyRow = {
  idx: number
  t: number
  powerKw: number
  totalPower: number
  soc: number
  chargeDetails: unknown[]
  payload: Record<string, unknown>
}

function parseProcessNotifyRow(ev: CecOrderRecord['rawEvents'][number], idx: number): ProcessNotifyRow | null {
  if (ev.name !== 'notification_equip_charge_status') return null
  try {
    const o = JSON.parse(ev.payload) as Record<string, unknown>
    const voltage = Number(o.VoltageA ?? 0)
    const current = Number(o.CurrentA ?? 0)
    const powerKw = (voltage * current) / 1000
    return {
      idx,
      t: ev.t,
      powerKw: Number.isFinite(powerKw) ? powerKw : 0,
      totalPower: Number(o.TotalPower ?? 0),
      soc: Number(o.SOC ?? o.Soc ?? 0),
      chargeDetails: Array.isArray(o.ChargeDetails) ? (o.ChargeDetails as unknown[]) : [],
      payload: o,
    }
  } catch {
    return {
      idx,
      t: ev.t,
      powerKw: 0,
      totalPower: 0,
      soc: 0,
      chargeDetails: [],
      payload: { raw: ev.payload },
    }
  }
}

const processNotifyRows = computed(() => {
  const po = orderDetail.value
  if (!po) return [] as ProcessNotifyRow[]
  const out: ProcessNotifyRow[] = []
  for (const ev of po.rawEvents) {
    const row = parseProcessNotifyRow(ev, out.length + 1)
    if (row) out.push(row)
  }
  return out
})

function chargeDetailObj(d: unknown): Record<string, unknown> {
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : {}
}

/** 新增配置时：四个秘钥默认 16 位无分隔符随机串 */
function defaultSecretsForNewLink(): CecLinkConfig['local'] {
  return {
    operatorId: '',
    requestBaseUrl: '',
    operatorSecret: genSecret16(),
    sigSecret: genSecret16(),
    dataSecret: genSecret16(),
    dataSecretIV: genSecret16(),
  }
}

function defaultThirdPartyForNewLink(): CecThirdPartySecrets {
  const tpDefault = 'http://127.0.0.1:8080'
  return {
    operatorId: '',
    operatorSecret: genSecret16(),
    sigSecret: genSecret16(),
    dataSecret: genSecret16(),
    dataSecretIV: genSecret16(),
    interconnectionUrl: tpDefault,
  }
}

function newLink(): CecLinkConfig {
  const id = crypto.randomUUID()
  const linkUuid = genLinkUuid()
  const base = {
    id,
    name: '新配置',
    linkUuid,
    protocolId: snapshot.value.protocols[0]?.protocolId ?? CEC_DEFAULT_ID,
    local: defaultSecretsForNewLink(),
    thirdParty: defaultThirdPartyForNewLink(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  base.local.requestBaseUrl = `http://127.0.0.1:${snapshot.value.settings.httpPort}/api/${linkUuid}`
  return base
}

async function toggleHttp() {
  if (httpRunning.value) {
    await stopHttp()
    ElMessage.success('已停止 HTTP')
  } else {
    const r = await startHttp()
    if (r.ok) ElMessage.success(`已启动 :${r.port}`)
    else ElMessage.error(r.error)
  }
}

function openCfg() {
  cfgSection.value = 'http'
  cfgOpen.value = true
}

function onImportProtocol(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  if (!f) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      importProtocolJson(String(reader.result))
      ElMessage.success('协议已导入')
    } catch (err) {
      ElMessage.error((err as Error).message)
    }
  }
  reader.readAsText(f)
  input.value = ''
}

function formatProtocolImportedAt(v?: number): string {
  if (!v || !Number.isFinite(v)) return '内置'
  return new Date(v).toLocaleString()
}

async function exportProtocolMappingJson(protocol: CecProtocolMapping) {
  try {
    const text = JSON.stringify(protocol, null, 2)
    const filename = `cec-protocol-${safeFileSegment(String(protocol.protocolName ?? protocol.protocolId ?? 'protocol'))}.json`
    if (typeof window.unions?.saveTextFile === 'function') {
      const r = await window.unions.saveTextFile({ defaultFilename: filename, content: text })
      if (r.ok) {
        ElMessage.success('已导出协议 JSON')
        return
      }
      if (r.error === 'cancelled') return
      ElMessage.error(r.error)
      return
    }
    downloadTextFileInBrowser(filename, text)
    ElMessage.success('已导出协议 JSON')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function removeProtocolRow(protocol: CecProtocolMapping) {
  if (snapshot.value.protocols.length <= 1) {
    ElMessage.warning('至少保留一个协议，无法删除。')
    return
  }
  const usedBy = snapshot.value.links.find((l) => l.protocolId === protocol.protocolId)
  if (usedBy) {
    ElMessage.warning(`协议正被配置「${usedBy.name}」使用，无法删除。`)
    return
  }
  try {
    await ElMessageBox.confirm(
      `确认删除协议「${protocol.protocolName || protocol.protocolId}」？`,
      '删除协议',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  removeProtocolById(protocol.protocolId)
  ElMessage.success('协议已删除')
}

function safeFileSegment(s: string): string {
  const t = s.replace(/[/\\:*?"<>|]/g, '_').trim()
  return t.slice(0, 48) || 'link'
}

function cloneLinkForExport(link: CecLinkConfig): CecLinkConfig {
  try {
    return structuredClone(link)
  } catch {
    return JSON.parse(JSON.stringify(link)) as CecLinkConfig
  }
}

/** 浏览器环境：将下载锚点挂到 DOM 再触发，否则部分 Electron/WebKit 下无反应 */
function downloadTextFileInBrowser(filename: string, content: string) {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** 导出为 JSON，内含本地/三方全部字段，密钥为明文 */
async function exportLinkConfigJson(link: CecLinkConfig) {
  try {
    const payload = {
      format: 'cec-interconnection-link' as const,
      version: 1,
      exportedAt: new Date().toISOString(),
      config: cloneLinkForExport(link),
    }
    const text = JSON.stringify(payload, null, 2)
    const filename = `cec-interconnection-${safeFileSegment(link.name)}-${link.linkUuid}.json`

    if (typeof window.unions?.saveTextFile === 'function') {
      const r = await window.unions.saveTextFile({ defaultFilename: filename, content: text })
      if (r.ok) {
        ElMessage.success('已保存 JSON（含明文密钥）')
        return
      }
      if (r.error === 'cancelled') return
      ElMessage.error(r.error)
      return
    }

    downloadTextFileInBrowser(filename, text)
    ElMessage.success('已导出 JSON（含明文密钥）')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

type CecLinkExportEnvelope = {
  format?: string
  version?: number
  exportedAt?: string
  config?: CecLinkConfig
}

function parseLinkConfigJsonText(text: string): CecLinkConfig {
  const raw = JSON.parse(text) as unknown
  let cfg: unknown
  if (
    raw &&
    typeof raw === 'object' &&
    (raw as CecLinkExportEnvelope).format === 'cec-interconnection-link'
  ) {
    const env = raw as CecLinkExportEnvelope
    if (!env.config || typeof env.config !== 'object') throw new Error('导出文件中缺少 config')
    cfg = env.config
  } else {
    cfg = raw
  }
  if (!cfg || typeof cfg !== 'object') throw new Error('无效的 JSON')
  const c = cfg as Partial<CecLinkConfig>
  if (!String(c.name ?? '').trim()) throw new Error('缺少对接名称')
  if (!String(c.linkUuid ?? '').trim()) throw new Error('缺少对接唯一码')
  if (!c.local || typeof c.local !== 'object') throw new Error('缺少本地配置')
  if (!c.thirdParty || typeof c.thirdParty !== 'object') throw new Error('缺少三方配置')
  return cloneLinkForExport(c as CecLinkConfig)
}

/** 导入为一条新配置：新 id；对接码与已有冲突时重新生成并同步本地请求地址 */
function prepareImportedLink(parsed: CecLinkConfig): CecLinkConfig {
  const existingUuids = new Set(snapshot.value.links.map((l) => l.linkUuid))
  let linkUuid = String(parsed.linkUuid).trim()
  const originalUuid = linkUuid
  while (existingUuids.has(linkUuid)) {
    linkUuid = genLinkUuid()
  }
  const id = crypto.randomUUID()
  const now = Date.now()
  let protocolId = parsed.protocolId || CEC_DEFAULT_ID
  if (!snapshot.value.protocols.some((p) => p.protocolId === protocolId)) {
    protocolId = snapshot.value.protocols[0]?.protocolId ?? CEC_DEFAULT_ID
  }
  const merged: CecLinkConfig = {
    ...parsed,
    id,
    linkUuid,
    protocolId,
    createdAt: now,
    updatedAt: now,
  }
  merged.local = { ...merged.local }
  merged.thirdParty = { ...merged.thirdParty }
  merged.local.requestBaseUrl =
    linkUuid !== originalUuid ? defaultRequestBase(merged) : merged.local.requestBaseUrl || defaultRequestBase(merged)
  return normalizeCecLink(merged)
}

function triggerLinkImport() {
  linkImportInputRef.value?.click()
}

function onImportLinkConfig(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  if (!f) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const parsed = parseLinkConfigJsonText(String(reader.result))
      const candidate = prepareImportedLink(parsed)
      const conflict = findConflictingInterconnectionLink(snapshot.value.links, candidate)
      if (conflict) {
        ElMessage.error(
          `与已有配置「${conflict.name}」冲突：本地平台编码、三方平台编码与互联互通根地址的组合须唯一`,
        )
        return
      }
      upsertLink(candidate)
      void pullMainMerge()
      ElMessage.success('已导入互联互通配置')
    } catch (err) {
      ElMessage.error((err as Error).message)
    }
  }
  reader.readAsText(f)
  input.value = ''
}

async function copyLogEntry(log: CecLogEntry) {
  const dir = log.direction === 'inbound' ? '接收' : '向外'
  const text = `${new Date(log.t).toLocaleString()}\t${dir}\t${log.name}\t${log.summary}\t${formatLogBodySingleLine(log)}`
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.error('复制失败')
  }
}

function toSingleLineText(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

function formatLogBodySingleLine(log: CecLogEntry): string {
  const cipher = isLogCipherMode(log.id)
  try {
    const o = JSON.parse(log.body) as Record<string, unknown>
    if (o.kind === 'cec_inbound_http') {
      const url = String(o.requestUrl ?? '')
      const req = cipher
        ? toSingleLineText(String(o.requestEnvelopeCipher ?? ''))
        : toSingleLineText(JSON.stringify(o.paramsPlain ?? {}))
      const resp = cipher
        ? toSingleLineText(JSON.stringify(o.responseCipher ?? {}))
        : toSingleLineText(JSON.stringify(o.responsePlain ?? {}))
      return toSingleLineText(`url=${url} params=${req} resp=${resp}`)
    }
    if (o.kind === 'cec_outbound_http') {
      const url = String(o.requestUrl ?? '')
      const req = cipher
        ? toSingleLineText(JSON.stringify(o.requestCipher ?? {}))
        : toSingleLineText(JSON.stringify(o.requestPlain ?? {}))
      const resp = cipher
        ? toSingleLineText(
            o.responseCipher != null ? String(o.responseCipher) : String(o.error ?? ''),
          )
        : o.error
          ? toSingleLineText(String(o.error))
          : toSingleLineText(JSON.stringify(o.responsePlain ?? {}))
      return toSingleLineText(`url=${url} params=${req} resp=${resp}`)
    }
    if (o.params != null && typeof o.raw === 'string') {
      const url = String(o.requestUrl ?? '')
      const req = cipher ? toSingleLineText(o.raw) : toSingleLineText(JSON.stringify(o.params))
      const resp = toSingleLineText(JSON.stringify(o.response ?? {}))
      return toSingleLineText(`url=${url} params=${req} resp=${resp}`)
    }
    if (o.requestUrl || o.params || o.response) {
      const url = String(o.requestUrl ?? '')
      const params = o.params != null ? JSON.stringify(o.params) : ''
      const resp = o.response != null ? JSON.stringify(o.response) : ''
      return toSingleLineText(`url=${url} params=${params} resp=${resp}`)
    }
  } catch {
    // ignore
  }
  return toSingleLineText(log.body)
}

function formatLogLine(log: CecLogEntry): string {
  const ts = new Date(log.t).toLocaleString()
  const dir = log.direction === 'inbound' ? '接收' : '向外'
  return `${ts} | ${dir} | ${log.name} | ${log.summary} | ${formatLogBodySingleLine(log)}`
}

function formatLogExpanded(log: CecLogEntry): string {
  const ts = new Date(log.t).toLocaleString()
  const cipher = isLogCipherMode(log.id)
  let o: Record<string, unknown>
  try {
    o = JSON.parse(log.body) as Record<string, unknown>
  } catch {
    return `时间：${ts}\n请求url：(无法解析)\n请求参数：\n${log.body}\n返回值：\n(无)`
  }

  if (o.kind === 'cec_inbound_http') {
    const requestUrl = String(o.requestUrl ?? '')
    const modeLine = `展示：${cipher ? '密文（HTTP 原文 / 响应信封）' : '明文（加密前请求体 / 解密后响应体）'}`
    const req = cipher
      ? prettyLogJson(o.requestEnvelopeCipher ?? '')
      : prettyLogJson(o.paramsPlain ?? o.params)
    const resp = cipher
      ? prettyLogJson(o.responseCipher ?? '')
      : prettyLogJson(o.responsePlain ?? o.response)
    return `时间：${ts}\n${modeLine}\n请求url：${requestUrl || '(空)'}\n请求参数：\n${req}\n返回值：\n${resp}`
  }

  if (o.kind === 'cec_outbound_http') {
    const url = String(o.requestUrl ?? '')
    const prefix = String(o.prefix ?? '')
    const head = prefix ? `${prefix}\n` : ''
    const modeLine = `展示：${cipher ? '密文（签名请求体 / 原始响应）' : '明文（加密前请求体 / 解密后响应体）'}`
    let req: string
    let resp: string
    if (cipher) {
      req = prettyLogJson(o.requestCipher)
      resp =
        o.responseCipher != null
          ? prettyLogJson(String(o.responseCipher))
          : o.error
            ? String(o.error)
            : '(空)'
    } else {
      req = prettyLogJson(o.requestPlain)
      resp = o.error
        ? `（失败）${String(o.error)}`
        : prettyLogJson(o.responsePlain)
    }
    return `时间：${ts}\n${head}${modeLine}\n请求url：${url || '(空)'}\n请求参数：\n${req}\n返回值：\n${resp}`
  }

  if (o.params != null && typeof o.raw === 'string') {
    const requestUrl = String(o.requestUrl ?? '')
    const modeLine = `展示：${cipher ? '密文（请求 HTTP 原文）' : '明文（解密后请求体；响应见历史格式）'}`
    const req = cipher ? prettyLogJson(o.raw) : prettyLogJson(o.params)
    const resp = prettyLogJson(o.response)
    return `时间：${ts}\n${modeLine}\n请求url：${requestUrl || '(空)'}\n请求参数：\n${req}\n返回值：\n${resp}`
  }

  if (o.requestUrl || o.params || o.response) {
    const requestUrl = String(o.requestUrl ?? '')
    const params = o.params != null ? prettyLogJson(o.params) : '(空)'
    const response = o.response != null ? prettyLogJson(o.response) : '(空)'
    return `时间：${ts}\n请求url：${requestUrl || '(空)'}\n请求参数：\n${params}\n返回值：\n${response}`
  }

  return `时间：${ts}\n请求url：(非结构化)\n请求参数：\n${log.body}\n返回值：\n(无)`
}

async function clearAllLogs() {
  try {
    await ElMessageBox.confirm('确认清空当前所有日志吗？该操作不可恢复。', '清空日志确认', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await clearLogsEverywhere()
  expandedLogs.value = {}
  logCipherViewById.value = {}
  ElMessage.success('日志已清空')
}

function openLinkDialog(row?: CecLinkConfig) {
  if (row) {
    const n = normalizeCecLink(row)
    editingLink.value = {
      ...n,
      local: { ...n.local },
      thirdParty: { ...n.thirdParty },
    }
  } else {
    editingLink.value = newLink()
  }
  if (!editingLink.value.protocolId) editingLink.value.protocolId = CEC_DEFAULT_ID
  linkDialog.value = true
}

function saveLink() {
  const l = editingLink.value
  if (!l) return
  if (!l.name.trim()) {
    ElMessage.warning('请填写对接名称')
    return
  }
  l.updatedAt = Date.now()
  l.local.requestBaseUrl = l.local.requestBaseUrl || defaultRequestBase(l)
  const normalized = normalizeCecLink(l)
  const conflict = findConflictingInterconnectionLink(snapshot.value.links, normalized)
  if (conflict) {
    ElMessage.error(
      `与已有配置「${conflict.name}」冲突：本地平台编码、三方平台编码与互联互通根地址的组合须唯一`,
    )
    return
  }
  upsertLink(normalized)
  linkDialog.value = false
  void pullMainMerge()
}

function toggleRightPanel(panel: 'links' | 'logs') {
  rightPanel.value = rightPanel.value === panel ? 'none' : panel
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

async function runPullStations() {
  if (!pullLinkUuid.value) {
    ElMessage.warning('请选择第三方配置')
    return
  }
  pullDialogOpen.value = false
  pullOverlayActive.value = true
  pullUiPhase.value = 'fetching'
  stopPullPercentSmoothing()
  pullFillPercent.value = 0
  pullFillPercentTarget.value = 0
  pullAwaitingFirstPage.value = true
  pullProgressHint.value = '正在发起分页请求…'

  let ok = false
  let count = 0
  let pages = 0
  let errMsg = ''

  const offProgress = window.unions.onCecPullStationsProgress((p) => {
    pullAwaitingFirstPage.value = false
    if (p.totalPages > 0) {
      pullFillPercentTarget.value = Math.min(100, Math.round((p.pageNo / p.totalPages) * 100))
      pullProgressHint.value = `第 ${p.pageNo} / ${p.totalPages} 页`
    } else {
      pullFillPercentTarget.value = Math.min(95, Math.max(1, p.pagesFetched * 8))
      pullProgressHint.value = `已请求 ${p.pagesFetched} 页（对端未返回总页数）`
    }
    ensurePullPercentSmoothing()
  })

  try {
    const r = await invokeCec<
      { ok: true; count: number; pages: number } | { ok: false; error: string }
    >('pullStations', {
      linkUuid: pullLinkUuid.value,
      pageSize: pullPageSize.value,
    })
    ok = r.ok
    if (r.ok) {
      count = r.count
      pages = r.pages
    } else {
      errMsg = r.error
    }
  } catch (e) {
    ok = false
    errMsg = e instanceof Error ? e.message : String(e)
  } finally {
    offProgress()
  }

  if (!ok) {
    stopPullPercentSmoothing()
    pullFillPercent.value = pullFillPercentTarget.value
  }

  if (ok) {
    pullAwaitingFirstPage.value = false
    pullFillPercentTarget.value = 100
    ensurePullPercentSmoothing()
    await waitPullPercentSettled()
    pullProgressHint.value = '全部页已拉取'
    await delay(PULL_RESULT_HOLD_MS)
  }

  pullOutcomeOk.value = ok
  pullUiPhase.value = 'result'

  await delay(PULL_RESULT_HOLD_MS)

  pullOverlayActive.value = false
  pullUiPhase.value = 'fetching'

  if (ok) {
    ElMessage.success(`拉取完成：共 ${count} 个站点（${pages} 次分页请求）`)
    await pullMainMerge()
  } else {
    ElMessage.error(errMsg || '拉取失败')
  }
}

/** 接口侧 StationID 可能为数字，与 Set 内字符串混用会导致「开放」开关无效 */
function stationIdNormalized(station: CecStationRecord): string {
  return String(station.StationID ?? '')
}

function isStationRowOpen(row: { linkUuid: string; station: CecStationRecord }): boolean {
  const sid = stationIdNormalized(row.station)
  const cur = snapshot.value.openStationIds[row.linkUuid] ?? []
  return cur.map(String).includes(sid)
}

function toggleOpen(linkUuid: string, station: CecStationRecord, on: boolean) {
  const sid = stationIdNormalized(station)
  const cur = [...(snapshot.value.openStationIds[linkUuid] ?? [])].map(String)
  const set = new Set(cur)
  if (on) set.add(sid)
  else set.delete(sid)
  snapshot.value.openStationIds = {
    ...snapshot.value.openStationIds,
    [linkUuid]: [...set],
  }
}

function stationRowKey(row: StationRowVM) {
  return `${row.linkUuid}::${stationIdNormalized(row.station)}`
}

const stationStatusPullingKey = ref<string | null>(null)

function stationStatusCacheKey(linkUuid: string, stationId: string) {
  return `${linkUuid}::${String(stationId).trim()}`
}

function summarizeConnectorStatuses(infos: CecConnectorStatusInfo[]) {
  let online = 0
  let idle = 0
  let charging = 0
  let occupied = 0
  let fault = 0
  const total = infos.length
  for (const c of infos) {
    const s = Number(c.Status)
    if (s !== 0) online += 1
    if (s === 1) idle += 1
    else if (s === 3) charging += 1
    else if (s === 2 || s === 4) occupied += 1
    else if (s === 255) fault += 1
  }
  return { total, online, idle, charging, occupied, fault }
}

function stationStatusEntryForRow(row: StationRowVM) {
  return snapshot.value.stationStatusByKey?.[
    stationStatusCacheKey(row.linkUuid, String(row.station.StationID ?? ''))
  ]
}

function stationDeviceStatusButtonText(row: StationRowVM): string {
  const ent = stationStatusEntryForRow(row)
  if (!ent?.ConnectorStatusInfos?.length) return '—'
  const s = summarizeConnectorStatuses(ent.ConnectorStatusInfos)
  return `${s.online}/${s.total} 在线`
}

function stationDeviceStatusPopover(row: StationRowVM) {
  const ent = stationStatusEntryForRow(row)
  if (!ent?.ConnectorStatusInfos?.length) return null
  return summarizeConnectorStatuses(ent.ConnectorStatusInfos)
}

async function pullStationStatusRow(row: StationRowVM) {
  const sid = String(row.station.StationID ?? '').trim()
  if (!sid) {
    ElMessage.warning('站点 ID 为空')
    return
  }
  const key = stationRowKey(row)
  stationStatusPullingKey.value = key
  try {
    const r = await invokeCec<{ ok: true } | { ok: false; error: string }>('queryStationStatus', {
      linkUuid: row.linkUuid,
      stationIds: [sid],
    })
    if (r.ok) {
      ElMessage.success('已更新枪状态')
      await pullMainMerge()
    } else {
      ElMessage.error(r.error)
    }
  } finally {
    stationStatusPullingKey.value = null
  }
}

function connectorStatusLabelByCode(status: number): string {
  const m: Record<number, string> = {
    0: '离网',
    1: '空闲',
    2: '占用(未充)',
    3: '充电中',
    4: '预约锁定',
    255: '故障',
  }
  return m[status] ?? `状态${status}`
}

function connectorStatusForGun(connectorId: string): string {
  const ctx = stationDetailCtx.value
  if (!ctx) return '—'
  const ent =
    snapshot.value.stationStatusByKey?.[
      stationStatusCacheKey(ctx.linkUuid, String(ctx.station.StationID ?? ''))
    ]
  if (!ent?.ConnectorStatusInfos?.length) return '—'
  const hit = ent.ConnectorStatusInfos.find((c) => c.ConnectorID === connectorId)
  if (!hit) return '—'
  return connectorStatusLabelByCode(Number(hit.Status))
}

function phoneStationIdleStats(it: { linkUuid: string; station: CecStationRecord }) {
  const ent =
    snapshot.value.stationStatusByKey?.[
      stationStatusCacheKey(it.linkUuid, String(it.station.StationID ?? ''))
    ]
  if (!ent?.ConnectorStatusInfos?.length) return { idle: 0, total: 0, show: false }
  const s = summarizeConnectorStatuses(ent.ConnectorStatusInfos)
  return { idle: s.idle, total: s.total, show: true }
}

const stationDetailConnectorStats = computed(() => {
  const ctx = stationDetailCtx.value
  if (!ctx) return null
  const ent =
    snapshot.value.stationStatusByKey?.[
      stationStatusCacheKey(ctx.linkUuid, String(ctx.station.StationID ?? ''))
    ]
  if (!ent?.ConnectorStatusInfos?.length) return null
  return summarizeConnectorStatuses(ent.ConnectorStatusInfos)
})

function onStationSelectionChange(val: StationRowVM[]) {
  stationSelection.value = val
}

function removePolicyAndConnectorsForIds(linkUuid: string, connectorIds: string[]) {
  const nextMap = { ...snapshot.value.connectorMap }
  const nextPolicy = { ...snapshot.value.equipBusinessPolicyByKey }
  for (const cid of connectorIds) {
    if (!cid) continue
    delete nextMap[cid]
    delete nextPolicy[policyKey(linkUuid, cid)]
  }
  snapshot.value.connectorMap = nextMap
  snapshot.value.equipBusinessPolicyByKey = nextPolicy
}

function removeConnectorStatusesForIds(linkUuid: string, stationId: string, connectorIds: string[]) {
  if (connectorIds.length === 0) return
  const key = stationStatusCacheKey(linkUuid, stationId)
  const prev = snapshot.value.stationStatusByKey?.[key]
  if (!prev?.ConnectorStatusInfos?.length) return
  const removeSet = new Set(connectorIds.filter(Boolean))
  const nextInfos = prev.ConnectorStatusInfos.filter((x) => !removeSet.has(String(x.ConnectorID ?? '')))
  const nextStatusMap = { ...(snapshot.value.stationStatusByKey ?? {}) }
  if (nextInfos.length === 0) {
    delete nextStatusMap[key]
  } else {
    nextStatusMap[key] = {
      ...prev,
      ConnectorStatusInfos: nextInfos,
      fetchedAt: Date.now(),
    }
  }
  snapshot.value.stationStatusByKey = nextStatusMap
}

function connectorIdsForStation(station: CecStationRecord): string[] {
  const ids = new Set<string>()
  for (const r of flattenStationConnectors(station)) {
    if (r.connectorId) ids.add(r.connectorId)
  }
  return [...ids]
}

/** 从快照中删除一个站点行（设备、枪映射、费率缓存一并清理） */
function deleteStationSnapshotRow(row: StationRowVM) {
  const { linkUuid, station } = row
  const sid = stationIdNormalized(station)
  const cids = connectorIdsForStation(station)
  const list = snapshot.value.stationsByLink[linkUuid] ?? []
  const nextList = list.filter((s) => stationIdNormalized(s) !== sid)
  snapshot.value.stationsByLink = { ...snapshot.value.stationsByLink, [linkUuid]: nextList }
  const open = [...(snapshot.value.openStationIds[linkUuid] ?? [])].map(String)
  const oset = new Set(open)
  oset.delete(sid)
  snapshot.value.openStationIds = { ...snapshot.value.openStationIds, [linkUuid]: [...oset] }
  removePolicyAndConnectorsForIds(linkUuid, cids)
  removeConnectorStatusesForIds(linkUuid, sid, cids)
  const sk = stationStatusCacheKey(linkUuid, sid)
  if (snapshot.value.stationStatusByKey?.[sk]) {
    const nextSt = { ...snapshot.value.stationStatusByKey }
    delete nextSt[sk]
    snapshot.value.stationStatusByKey = nextSt
  }
}

async function deleteSelectedStations() {
  const rows = stationSelection.value
  if (rows.length === 0) return
  try {
    await ElMessageBox.confirm(
      `确定删除选中的 ${rows.length} 个站点？站内设备、枪号映射及已缓存费率将一并删除。`,
      '删除站点',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  for (const row of rows) {
    deleteStationSnapshotRow(row)
  }
  stationTableRef.value?.clearSelection()
  stationSelection.value = []
  if (stationDetailCtx.value) {
    const d = stationDetailCtx.value
    const exists = snapshot.value.stationsByLink[d.linkUuid]?.some(
      (s) => stationIdNormalized(s) === stationIdNormalized(d.station),
    )
    if (!exists) {
      stationDetailOpen.value = false
      stationDetailCtx.value = null
    }
  }
  ElMessage.success('已删除')
}

async function deleteEquipmentRow(eqRow: CecEquipmentTableRow) {
  const ctx = stationDetailCtx.value
  if (!ctx) return
  try {
    await ElMessageBox.confirm(
      `确定删除设备「${eqRow.EquipmentID}」？其下 ${eqRow.ConnectorInfos.length} 把枪的映射与费率缓存将一并删除。`,
      '删除设备',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const linkUuid = ctx.linkUuid
  const sid = stationIdNormalized(ctx.station)
  const list = snapshot.value.stationsByLink[linkUuid] ?? []
  const idx = list.findIndex((s) => stationIdNormalized(s) === sid)
  if (idx < 0) return
  const st = list[idx]
  const rawEqs = Array.isArray(st.EquipmentInfos) ? st.EquipmentInfos : []
  const parsed = parseEquipmentInfos(st)
  const eqIdx = parsed.findIndex((r) => r.rowKey === eqRow.rowKey)
  if (eqIdx < 0) return
  const newEqs = rawEqs.filter((_, i) => i !== eqIdx)
  const newStation: CecStationRecord = { ...st, EquipmentInfos: newEqs }
  const newList = [...list]
  newList[idx] = newStation
  snapshot.value.stationsByLink = { ...snapshot.value.stationsByLink, [linkUuid]: newList }
  const cids = eqRow.ConnectorInfos.map((c) => c.ConnectorID).filter(Boolean)
  removePolicyAndConnectorsForIds(linkUuid, cids)
  removeConnectorStatusesForIds(linkUuid, sid, cids)
  stationDetailCtx.value = { ...ctx, station: newStation }
  ElMessage.success('已删除设备')
}

function openStationDetailDialog(row: { linkName: string; linkUuid: string; station: CecStationRecord }) {
  stationDetailCtx.value = row
  stationDetailFilter.value = ''
  policyFilter.value = ''
  stationDetailTab.value = 'station'
  stationDetailOpen.value = true
}

function parseEquipmentInfos(st: CecStationRecord): CecEquipmentTableRow[] {
  const raw = st.EquipmentInfos
  if (!Array.isArray(raw)) return []
  return raw.map((eq, i) => {
    const e = eq as Record<string, unknown>
    const id = String(e.EquipmentID ?? `eq-${i}`)
    const cis = Array.isArray(e.ConnectorInfos) ? e.ConnectorInfos : []
    const connectors: CecConnectorRow[] = cis.map((c) => {
      const x = c as Record<string, unknown>
      return {
        ConnectorID: String(x.ConnectorID ?? ''),
        ConnectorName: x.ConnectorName != null ? String(x.ConnectorName) : undefined,
        ConnectorType: typeof x.ConnectorType === 'number' ? x.ConnectorType : Number(x.ConnectorType),
        VoltageUpperLimits:
          typeof x.VoltageUpperLimits === 'number' ? x.VoltageUpperLimits : Number(x.VoltageUpperLimits),
        VoltageLowerLimits:
          typeof x.VoltageLowerLimits === 'number' ? x.VoltageLowerLimits : Number(x.VoltageLowerLimits),
        Current: typeof x.Current === 'number' ? x.Current : Number(x.Current),
        Power: typeof x.Power === 'number' ? x.Power : Number(x.Power),
        ParkNo: x.ParkNo != null ? String(x.ParkNo) : undefined,
        NationalStandard:
          typeof x.NationalStandard === 'number' ? x.NationalStandard : Number(x.NationalStandard),
      }
    })
    return {
      rowKey: `${id}-${i}`,
      EquipmentID: id,
      EquipmentName: e.EquipmentName != null ? String(e.EquipmentName) : undefined,
      EquipmentModel: e.EquipmentModel != null ? String(e.EquipmentModel) : undefined,
      ManufacturerName: e.ManufacturerName != null ? String(e.ManufacturerName) : undefined,
      EquipmentType: typeof e.EquipmentType === 'number' ? e.EquipmentType : Number(e.EquipmentType),
      Power: typeof e.Power === 'number' ? e.Power : Number(e.Power),
      ConnectorInfos: connectors,
    }
  })
}

function equipmentTypeLabel(t: number | undefined): string {
  const m: Record<number, string> = {
    1: '直流',
    2: '交流',
    3: '交流一体',
    4: '无线',
    5: '其他',
  }
  if (t == null || Number.isNaN(t)) return '—'
  return m[t] ?? String(t)
}

function connectorTypeLabel(t: number | undefined): string {
  const m: Record<number, string> = {
    1: '家用插座（模式2）',
    2: '交流插座（模式3-B）',
    3: '交流插头（模式3-C）',
    4: '直流枪头（模式4）',
    5: '无线充电座',
    6: '其他',
  }
  if (t == null || Number.isNaN(t)) return '—'
  return m[t] ?? String(t)
}

function stationInfoText(v: unknown): string {
  if (v === undefined || v === null) return '—'
  if (typeof v === 'string' && !v.trim()) return '—'
  return String(v)
}

function stationTypeLabelCec(n: number | undefined): string {
  const m: Record<number, string> = {
    1: '公共',
    50: '个人',
    100: '公交（专用）',
    101: '环卫（专用）',
    102: '物流（专用）',
    103: '出租车（专用）',
    255: '其他',
  }
  if (n == null || Number.isNaN(n)) return '—'
  return m[n] ?? String(n)
}

function stationStatusLabelCec(n: number | undefined): string {
  const m: Record<number, string> = {
    0: '未知',
    1: '建设中',
    5: '关闭下线',
    6: '维护中',
    50: '正常使用',
  }
  if (n == null || Number.isNaN(n)) return '—'
  return m[n] ?? String(n)
}

function constructionLabelCec(n: number | undefined): string {
  const m: Record<number, string> = {
    1: '居民区',
    2: '公共机构',
    3: '企业单位',
    4: '写字楼',
    5: '工业园区',
    6: '交通枢纽',
    7: '大型文体设施',
    8: '城市绿地',
    9: '大型建筑配套停车场',
    10: '路边停车位',
    11: '城际高速服务区',
    255: '其他',
  }
  if (n == null || Number.isNaN(n)) return '—'
  return m[n] ?? String(n)
}

function stationPicturesText(pics: unknown): string {
  if (!Array.isArray(pics) || pics.length === 0) return '—'
  return pics.map((p) => String(p)).join('\n')
}

function supportOrderLabel(n: number | undefined): string {
  const v = n === undefined || n === null ? 0 : Number(n)
  if (Number.isNaN(v)) return '—'
  return v === 1 ? '支持预约' : '不支持预约'
}

const stationDetailEquipmentRows = computed(() => {
  const ctx = stationDetailCtx.value
  if (!ctx) return []
  return parseEquipmentInfos(ctx.station)
})

const stationDetailFilteredEquipment = computed(() => {
  const q = stationDetailFilter.value.trim().toLowerCase()
  const rows = stationDetailEquipmentRows.value
  if (!q) return rows
  return rows.filter((row) => {
    const hay = [
      row.EquipmentID,
      row.EquipmentName ?? '',
      row.EquipmentModel ?? '',
      row.ManufacturerName ?? '',
      ...row.ConnectorInfos.flatMap((c) => [
        c.ConnectorID,
        c.ConnectorName ?? '',
        c.ParkNo ?? '',
      ]),
    ]
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
})

/** 当前站点：桩（设备）数、枪（接口）总数 */
const stationDetailPileCount = computed(() => stationDetailEquipmentRows.value.length)

const stationDetailGunCount = computed(() =>
  stationDetailEquipmentRows.value.reduce((n, r) => n + r.ConnectorInfos.length, 0),
)

function policyKey(linkUuid: string, connectorId: string) {
  return `${linkUuid}::${connectorId}`
}

function flattenStationConnectors(st: CecStationRecord): {
  connectorId: string
  equipmentId: string
  equipmentName?: string
}[] {
  const out: { connectorId: string; equipmentId: string; equipmentName?: string }[] = []
  const eqs = st.EquipmentInfos
  if (!Array.isArray(eqs)) return []
  for (const eq of eqs) {
    const e = eq as Record<string, unknown>
    const eid = String(e.EquipmentID ?? '')
    const ename = e.EquipmentName != null ? String(e.EquipmentName) : undefined
    const cis = Array.isArray(e.ConnectorInfos) ? e.ConnectorInfos : []
    for (const c of cis) {
      const cx = c as Record<string, unknown>
      out.push({ connectorId: String(cx.ConnectorID ?? ''), equipmentId: eid, equipmentName: ename })
    }
  }
  return out
}

/** 手机模拟列表：当前时段电价 + 服务费单价之和（与详情「全部费率」首条成功枪逻辑一致） */
function phoneStationPriceLine(it: { linkUuid: string; station: CecStationRecord }): string {
  void policyTimeTick.value
  const now = new Date()
  for (const r of flattenStationConnectors(it.station)) {
    if (!r.connectorId) continue
    const k = policyKey(it.linkUuid, r.connectorId)
    const c = snapshot.value.equipBusinessPolicyByKey?.[k]
    if (c && c.SuccStat === 0 && c.PolicyInfos?.length) {
      const period = resolveCurrentPolicyPeriod(c.PolicyInfos, now)
      if (period) {
        const elec = Number(period.ElecPrice)
        const svc = policySevicePrice(period)
        const sum = (Number.isFinite(elec) ? elec : 0) + (Number.isFinite(svc) ? svc : 0)
        return `${sum.toFixed(4)} 元/kWh`
      }
    }
  }
  return '暂无费率'
}

const stationPolicyConnectorRows = computed(() => {
  const ctx = stationDetailCtx.value
  if (!ctx) return []
  return flattenStationConnectors(ctx.station)
})

const stationDetailLinkUuid = computed(() => stationDetailCtx.value?.linkUuid ?? '')

const stationPolicyFilteredRows = computed(() => {
  const q = policyFilter.value.trim().toLowerCase()
  const rows = stationPolicyConnectorRows.value
  if (!q) return rows
  return rows.filter((r) =>
    [r.connectorId, r.equipmentId, r.equipmentName ?? ''].join(' ').toLowerCase().includes(q),
  )
})

const policyCardData = computed(() => {
  void policyTimeTick.value
  const ctx = stationDetailCtx.value
  if (!ctx) return null
  const now = new Date()
  for (const r of stationPolicyConnectorRows.value) {
    const k = policyKey(ctx.linkUuid, r.connectorId)
    const c = snapshot.value.equipBusinessPolicyByKey?.[k]
    if (c && c.SuccStat === 0 && c.PolicyInfos?.length) {
      const period = resolveCurrentPolicyPeriod(c.PolicyInfos, now)
      if (period) {
        return {
          connectorId: r.connectorId,
          period,
          elec: Number(period.ElecPrice),
          svc: policySevicePrice(period),
        }
      }
    }
  }
  return null
})

const policyClockStr = computed(() => {
  void policyTimeTick.value
  const d = new Date()
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
})

function formatPolicyFetched(linkUuid: string, connectorId: string): string {
  const c = snapshot.value.equipBusinessPolicyByKey?.[policyKey(linkUuid, connectorId)]
  if (!c) return '—'
  return new Date(c.fetchedAt).toLocaleString()
}

function policyRowStatus(linkUuid: string, connectorId: string): string {
  const c = snapshot.value.equipBusinessPolicyByKey?.[policyKey(linkUuid, connectorId)]
  if (!c) return '未同步'
  if (c.SuccStat === 0) return '成功'
  if (c.errorMessage) return c.errorMessage
  return `SuccStat=${c.SuccStat ?? '—'}`
}

function policySumPeriod(linkUuid: string, connectorId: string): string {
  const c = snapshot.value.equipBusinessPolicyByKey?.[policyKey(linkUuid, connectorId)]
  if (!c || c.SuccStat !== 0) return '—'
  const n = c.SumPeriod ?? c.PolicyInfos?.length
  return n != null && !Number.isNaN(Number(n)) ? String(n) : '—'
}

async function syncPolicyForConnector(connectorId: string) {
  const ctx = stationDetailCtx.value
  if (!ctx) return
  policySyncingConnector.value = connectorId
  try {
    const r = await invokeCec<{ ok: true } | { ok: false; error: string }>('queryEquipBusinessPolicy', {
      linkUuid: ctx.linkUuid,
      connectorId,
    })
    if (r.ok) {
      ElMessage.success(`已同步枪 ${connectorId}`)
      await pullMainMerge()
    } else {
      ElMessage.error(r.error)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    ElMessage.error(msg || '同步费率失败')
  } finally {
    policySyncingConnector.value = null
  }
}

async function syncPolicyAllFiltered() {
  const ctx = stationDetailCtx.value
  if (!ctx) return
  const rows = stationPolicyFilteredRows.value
  if (rows.length === 0) {
    ElMessage.warning('没有可同步的枪')
    return
  }
  policySyncAllLoading.value = true
  try {
    for (const row of rows) {
      const res = await invokeCec<{ ok: true } | { ok: false; error: string }>(
        'queryEquipBusinessPolicy',
        {
        linkUuid: ctx.linkUuid,
        connectorId: row.connectorId,
        },
      )
      await pullMainMerge()
      if (!res.ok) {
        ElMessage.error(`枪 ${row.connectorId}：${res.error}`)
        return
      }
    }
    ElMessage.success('已全部同步')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    ElMessage.error(msg || '同步费率失败')
  } finally {
    policySyncAllLoading.value = false
  }
}

function onEquipmentTableRowClick(row: CecEquipmentTableRow, column: { type?: string }) {
  /** 点击展开箭头时由表格自身处理，避免与 toggleRowExpansion 重复触发导致状态不变 */
  if (column?.type === 'expand') return
  equipmentTableRef.value?.toggleRowExpansion(row)
}

function parseOptionalMoney(s: string): number | undefined {
  const t = String(s ?? '').trim()
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

function findStationIdForConnector(connectorId: string): { linkUuid: string; stationId: string } | null {
  const cid = connectorId.trim()
  if (!cid) return null
  const map = snapshot.value.connectorMap[cid]
  if (!map) return null
  const stations = snapshot.value.stationsByLink[map.linkUuid] ?? []
  for (const st of stations) {
    const eqs = (st as { EquipmentInfos?: { ConnectorInfos?: { ConnectorID: string }[] }[] }).EquipmentInfos
    if (!Array.isArray(eqs)) continue
    for (const eq of eqs) {
      for (const c of eq?.ConnectorInfos ?? []) {
        if (String(c?.ConnectorID ?? '').trim() === cid) {
          return { linkUuid: map.linkUuid, stationId: String(st.StationID ?? '').trim() }
        }
      }
    }
  }
  return { linkUuid: map.linkUuid, stationId: '' }
}

function isConnectorStationOpen(connectorId: string): boolean {
  const ctx = findStationIdForConnector(connectorId)
  if (!ctx?.stationId) return false
  const openSet = new Set((snapshot.value.openStationIds[ctx.linkUuid] ?? []).map(String))
  return openSet.has(ctx.stationId)
}

function validateConnectorForStart(
  connectorId: string,
  mode: 'scan' | 'device' = 'scan',
): string | null {
  const cid = connectorId.trim()
  if (!cid) {
    return mode === 'scan'
      ? '请先完成二维码解析，设备号（ConnectorID）不能为空'
      : '请输入设备号'
  }
  if (!snapshot.value.connectorMap[cid]) {
    return '本地未找到该设备号，请先在站点查看中拉取场站信息'
  }
  if (!isConnectorStationOpen(cid)) {
    return '该设备所属场站未开放，请在站点查看中开放后再启动'
  }
  return null
}

/** 与扫码一致：用设备号查 connectorMap，再发起 query_start_charge（qr 与扫码内容对应）；money 为模拟侧可选扩展字段 */
async function startChargeWithConnector(
  connectorIdRaw: string,
  qrPayload: string,
  money?: number,
): Promise<boolean> {
  const connectorId = connectorIdRaw.trim()
  const gate = validateConnectorForStart(connectorId)
  if (gate) {
    ElMessage.warning(gate)
    return false
  }
  const map = snapshot.value.connectorMap[connectorId]!
  const r = await invokeCec<
    { ok: true; text: string; startChargeSeq: string } | { ok: false; error: string }
  >('clientStartCharge', {
    linkUuid: map.linkUuid,
    connectorId,
    qr: qrPayload,
    money,
  })
  if (r.ok) {
    ElMessage.success(`已发起启动，订单号 ${r.startChargeSeq}`)
    await pullMainMerge()
    const ord = [...snapshot.value.orders]
      .reverse()
      .find((o) => o.startChargeSeq === r.startChargeSeq)
    if (ord) liveOrder.value = ord
    return true
  }
  await pullMainMerge()
  ElMessage.error(r.error)
  return false
}

async function resolveConnectorFromQrText(qrText: string): Promise<boolean> {
  const qr = qrText.trim()
  if (!qr) return false
  if (!snapshot.value.links.length) {
    ElMessage.warning('请先配置互联互通对接')
    return false
  }
  qrResolving.value = true
  scanConnectorId.value = ''
  try {
    let lastErr = '二维码解析失败'
    for (const link of snapshot.value.links) {
      const r = await invokeCec<
        { ok: true; connectorId: string; linkUuid: string } | { ok: false; error: string }
      >('clientQueryTerminalCode', { linkUuid: link.linkUuid, qrCode: qr })
      if (r.ok) {
        scanConnectorId.value = r.connectorId
        ElMessage.success(`已解析设备号：${r.connectorId}`)
        return true
      }
      lastErr = r.error
    }
    ElMessage.error(lastErr)
    return false
  } finally {
    qrResolving.value = false
  }
}

async function pickQrImageForStart(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  const mod = await import('html5-qrcode')
  const el = document.getElementById('cec-file-qr-hidden')
  if (!el) return
  const h = new mod.Html5Qrcode('cec-file-qr-hidden')
  try {
    const r = await h.scanFile(f, true)
    pendingQrText.value = r
    phoneStartMode.value = 'scan'
    scanConnectorId.value = ''
    await resolveConnectorFromQrText(r)
  } catch {
    ElMessage.error('未能从图片中识别二维码')
  } finally {
    await h.clear()
  }
  ;(e.target as HTMLInputElement).value = ''
}

function openStartChargeConfirm() {
  if (phoneStartMode.value === 'scan') {
    if (!pendingQrText.value?.trim()) {
      ElMessage.warning('请先选择二维码图片并完成识别')
      return
    }
    if (qrResolving.value) {
      ElMessage.warning('正在解析二维码，请稍候')
      return
    }
    const gate = validateConnectorForStart(scanConnectorId.value, 'scan')
    if (gate) {
      ElMessage.warning(gate)
      return
    }
  } else if (!startDeviceIdInput.value?.trim()) {
    ElMessage.warning('请输入设备号')
    return
  } else {
    const gate = validateConnectorForStart(startDeviceIdInput.value, 'device')
    if (gate) {
      ElMessage.warning(gate)
      return
    }
  }
  startConfirmDialogOpen.value = true
}

const startConfirmMoneyLabel = computed(() => {
  const s =
    phoneStartMode.value === 'scan' ? startMoneyScanStr.value : startMoneyDeviceStr.value
  const m = parseOptionalMoney(s)
  return m != null ? String(m) : '未填写'
})

const startConfirmConnectorPreview = computed(() => {
  if (phoneStartMode.value === 'scan') return scanConnectorId.value?.trim() || '—'
  return startDeviceIdInput.value?.trim() || '—'
})

async function confirmStartChargeFromDialog() {
  const money =
    phoneStartMode.value === 'scan'
      ? parseOptionalMoney(startMoneyScanStr.value)
      : parseOptionalMoney(startMoneyDeviceStr.value)
  let ok = false
  if (phoneStartMode.value === 'scan') {
    const text = pendingQrText.value.trim()
    ok = await startChargeWithConnector(scanConnectorId.value, text, money)
  } else {
    const raw = startDeviceIdInput.value
    ok = await startChargeWithConnector(raw, raw.trim(), money)
  }
  if (!ok) return
  startConfirmDialogOpen.value = false
  pendingQrText.value = ''
  scanConnectorId.value = ''
  startDeviceIdInput.value = ''
  startMoneyScanStr.value = ''
  startMoneyDeviceStr.value = ''
  if (liveOrder.value) enterLiveChargeScreen(liveOrder.value)
}

function openLiveOrderFromPhoneOrders(row: CecOrderRecord) {
  liveOrder.value = row
  if (row.productState === 'charging' || row.productState === 'starting') {
    enterLiveChargeScreen(row)
    return
  }
  ElMessage.info('该订单当前不在充电中，已在订单页选中。')
}

function clearStopWaitTimer() {
  if (stopWaitTimer) {
    clearTimeout(stopWaitTimer)
    stopWaitTimer = null
  }
}

function parseStopNotifyResult(order: CecOrderRecord, since: number): { succStat: number; failReason: number } | null {
  for (let i = order.rawEvents.length - 1; i >= 0; i -= 1) {
    const e = order.rawEvents[i]
    if (e.name !== 'notification_stop_charge_result') continue
    if (e.t < since) break
    try {
      const o = JSON.parse(e.payload) as Record<string, unknown>
      return {
        succStat: Number(o.SuccStat ?? 1),
        failReason: Number(o.FailReason ?? 0),
      }
    } catch {
      return { succStat: 1, failReason: 0 }
    }
  }
  return null
}

watch(
  () => snapshot.value.orders,
  (orders) => {
    if (stopWaitOrderId.value) {
      const waiting = orders.find((o) => o.id === stopWaitOrderId.value)
      if (waiting) {
        const notify = parseStopNotifyResult(waiting, stopWaitStartedAt.value)
        if (notify) {
          clearStopWaitTimer()
          stopWaitOrderId.value = null
          stopWaitStartedAt.value = 0
          stopSubmittingOrderId.value = null
          if (notify.succStat === 0) {
            ElMessage.success('停止成功，订单已结束。')
          } else {
            ElMessage.error(`停止失败，FailReason=${notify.failReason}`)
          }
        }
      }
    }
    if (!liveOrder.value) return
    const latest = orders.find((o) => o.id === liveOrder.value?.id)
    if (!latest) {
      liveOrder.value = null
      if (phoneNav.value === 'liveCharge') {
        closePhoneLiveChargeScreen()
      }
      return
    }
    liveOrder.value = latest
    if (phoneNav.value === 'liveCharge') {
      if (
        latest.productState !== 'charging' &&
        latest.productState !== 'starting' &&
        latest.productState !== 'stopping'
      ) {
        ElMessage.info('订单已结束，已退出实时充电页面。')
        closePhoneLiveChargeScreen()
      }
    }
  },
  { deep: true },
)

let clockInterval: number | null = null
let policyClockInterval: number | null = null
onMounted(() => {
  clockInterval = window.setInterval(() => {
    clockTick.value++
  }, 30000)
  policyClockInterval = window.setInterval(() => {
    policyTimeTick.value++
  }, 1000)
  if (httpGuideVisible.value) {
    nextTick(() => updateHttpGuideAnchor())
    bindHttpGuideAnchorListeners(true)
  }
})

onUnmounted(() => {
  stopPullPercentSmoothing()
  clearStopWaitTimer()
  if (clockInterval != null) {
    window.clearInterval(clockInterval)
    clockInterval = null
  }
  if (policyClockInterval != null) {
    window.clearInterval(policyClockInterval)
    policyClockInterval = null
  }
  bindHttpGuideAnchorListeners(false)
  chart?.dispose()
  chartPower?.dispose()
})

watch(httpGuideVisible, (visible) => {
  if (visible) {
    nextTick(() => updateHttpGuideAnchor())
    bindHttpGuideAnchorListeners(true)
  } else {
    bindHttpGuideAnchorListeners(false)
  }
})

watch(
  () => [detailVisible.value, orderDetailTab.value, processNotifyRows.value],
  () => {
    if (!detailVisible.value || !orderDetail.value || orderDetailTab.value !== 'process') return
    nextTick(() => {
      if (!chartRef.value || !chartPowerRef.value) return
      chart?.dispose()
      chartPower?.dispose()
      chart = echarts.init(chartRef.value)
      chartPower = echarts.init(chartPowerRef.value)
      const rows = processNotifyRows.value
      const x = rows.map((_, i) => i + 1)
      chart.setOption({
        grid: { left: 40, right: 16, top: 16, bottom: 28 },
        xAxis: { type: 'category', data: x },
        yAxis: { type: 'value', name: 'kWh/元' },
        series: [
          { type: 'line', name: '电量', data: rows.map((r) => r.totalPower), smooth: true },
          {
            type: 'line',
            name: '金额',
            data: rows.map((r) => Number(r.payload.TotalMoney ?? 0)),
            smooth: true,
          },
        ],
        tooltip: { trigger: 'axis' },
      })
      chartPower.setOption({
        grid: { left: 44, right: 44, top: 16, bottom: 28 },
        xAxis: { type: 'category', data: x },
        yAxis: [
          { type: 'value', name: 'A/V' },
          { type: 'value', name: 'kW' },
        ],
        series: [
          {
            type: 'line',
            name: '电流A',
            data: rows.map((r) => Number(r.payload.CurrentA ?? 0)),
            smooth: true,
          },
          {
            type: 'line',
            name: '电压V',
            data: rows.map((r) => Number(r.payload.VoltageA ?? 0)),
            smooth: true,
          },
          {
            type: 'line',
            name: '功率kW',
            yAxisIndex: 1,
            data: rows.map((r) => r.powerKw),
            smooth: true,
          },
        ],
        tooltip: { trigger: 'axis' },
      })
    })
  },
)

const filteredLogs = computed(() => {
  const q = logFilter.value.trim().toLowerCase()
  if (!q) return snapshot.value.logs.slice().reverse()
  return snapshot.value.logs
    .filter((l) => JSON.stringify(l).toLowerCase().includes(q))
    .slice()
    .reverse()
})

function isFailureSummary(summary: string): boolean {
  return /(失败|异常|error|fail|sig_fail)/i.test(String(summary ?? ''))
}

function openOrderDetail(row: CecOrderRecord) {
  orderDetail.value = row
  orderDetailTab.value = 'info'
  detailVisible.value = true
}

function canManualSyncOrderStatus(row: CecOrderRecord): boolean {
  return row.protocolState !== 4 && row.productState !== 'completed'
}

async function syncOrderStatus(row: CecOrderRecord) {
  if (!canManualSyncOrderStatus(row)) return
  if (syncingOrderId.value === row.id) return
  syncingOrderId.value = row.id
  try {
    const r = await invokeCec<{ ok: true } | { ok: false; error: string }>('syncOrderStatus', {
      orderId: row.id,
    })
    if (!r.ok) throw new Error(r.error || '同步订单状态失败')
    await pullMainMerge()
    ElMessage.success('已同步订单状态')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    ElMessage.error(msg)
  } finally {
    syncingOrderId.value = null
  }
}

async function stopLiveOrder() {
  const o = liveOrder.value
  if (!o) return
  if (stopSubmittingOrderId.value === o.id) return
  await refreshHttpStatus()
  if (!httpRunning.value) {
    httpGuideAction.value = 'stop'
    pendingStopOrderId.value = o.id
    httpGuideVisible.value = true
    return
  }
  stopSubmittingOrderId.value = o.id
  liveOrder.value = { ...o, productState: 'stopping', protocolState: 3, updatedAt: Date.now() }
  const r = await invokeCec<{ ok: true; text: string } | { ok: false; error: string }>('clientStopCharge', {
    linkUuid: o.linkUuid,
    startChargeSeq: o.startChargeSeq,
    connectorId: o.connectorId,
  })
  if (r.ok) {
    ElMessage.success('已请求停止，等待停止结果...')
    await pullMainMerge()
    clearStopWaitTimer()
    stopWaitOrderId.value = o.id
    stopWaitStartedAt.value = Date.now()
    stopWaitTimer = setTimeout(async () => {
      if (stopWaitOrderId.value !== o.id) return
      stopWaitOrderId.value = null
      stopWaitStartedAt.value = 0
      stopSubmittingOrderId.value = null
      ElMessage.warning('停止结果等待超时，订单已恢复为充电中。')
      await pullMainMerge()
      const now = Date.now()
      snapshot.value.orders = snapshot.value.orders.map((x) => {
        if (x.id !== o.id) return x
        if (x.productState !== 'stopping' && x.protocolState !== 3) return x
        return {
          ...x,
          productState: 'charging',
          protocolState: 2,
          updatedAt: now,
        }
      })
      const latest = snapshot.value.orders.find((x) => x.id === o.id)
      if (latest && liveOrder.value?.id === o.id) {
        liveOrder.value = latest
      }
    }, 60_000)
  } else {
    stopSubmittingOrderId.value = null
    ElMessage.error(`停止失败：${r.error}`)
    await pullMainMerge()
    const now = Date.now()
    snapshot.value.orders = snapshot.value.orders.map((x) =>
      x.id === o.id
        ? {
            ...x,
            productState: 'charging',
            protocolState: 2,
            updatedAt: now,
          }
        : x,
    )
    const latest = snapshot.value.orders.find((x) => x.id === o.id)
    if (latest && liveOrder.value?.id === o.id) {
      liveOrder.value = latest
    }
  }
}

function stateLabel(s: CecOrderRecord['productState']): string {
  const m: Record<string, string> = {
    starting: '启动中',
    suspended: '挂起',
    charging: '充电中',
    start_failed: '启动失败',
    stopping: '停止中',
    pending_settlement: '待结算',
    completed: '已完成',
  }
  return m[s] ?? s
}

function stopReasonLabel(v: number | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  const m: Record<number, string> = {
    0: '用户手动停止充电',
    1: '客户端地运营商平台停止充电',
    2: 'BMS 停止充电',
    3: '充电机设备故障',
    4: '连接器断开',
  }
  return m[v] ?? `${v}（自定义）`
}

type ChargeDetailRow = {
  DetailStartTime: string
  DetailEndTime: string
  ElecPrice?: number
  SevicePrice?: number
  DetailPower?: number
  DetailElecMoney?: number
  DetailSeviceMoney?: number
}

function orderChargeDetailRows(row: CecOrderRecord | null): ChargeDetailRow[] {
  if (!row?.orderInfo?.chargeDetails?.length) return []
  const list = row.orderInfo.chargeDetails
  return list
    .filter((it): it is Record<string, unknown> => Boolean(it) && typeof it === 'object')
    .map((it) => ({
      DetailStartTime: String(it.DetailStartTime ?? ''),
      DetailEndTime: String(it.DetailEndTime ?? ''),
      ElecPrice: it.ElecPrice != null ? Number(it.ElecPrice) : undefined,
      SevicePrice: it.SevicePrice != null ? Number(it.SevicePrice) : undefined,
      DetailPower: it.DetailPower != null ? Number(it.DetailPower) : undefined,
      DetailElecMoney: it.DetailElecMoney != null ? Number(it.DetailElecMoney) : undefined,
      DetailSeviceMoney: it.DetailSeviceMoney != null ? Number(it.DetailSeviceMoney) : undefined,
    }))
}

function linkNameByUuid(linkUuid: string): string {
  const row = snapshot.value.links.find((l) => l.linkUuid === linkUuid)
  return row?.name || linkUuid
}

function formatOrderStartTime(row: CecOrderRecord): string {
  return new Date(row.createdAt).toLocaleString()
}

async function removeOrder(row: CecOrderRecord) {
  try {
    await ElMessageBox.confirm(
      `确定删除订单「${row.startChargeSeq}」？将同时删除该订单对应的过程数据。`,
      '删除订单',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const id = row.id
  await deleteOrderEverywhere(id)
  if (liveOrder.value?.id === id) liveOrder.value = null
  if (orderDetail.value?.id === id) {
    orderDetail.value = null
    detailVisible.value = false
  }
  ElMessage.success('订单已删除')
}

const myOrders = computed(() =>
  snapshot.value.orders.slice().sort((a, b) => b.updatedAt - a.updatedAt),
)
const phoneOrderKeyword = ref('')
const phoneOrderRows = computed(() => {
  const q = phoneOrderKeyword.value.trim().toLowerCase()
  if (!q) return myOrders.value
  return myOrders.value.filter((o) => {
    const amount = Number(o.orderInfo?.totalMoney ?? o.samples.at(-1)?.totalMoney ?? 0).toFixed(2)
    const power = Number(o.orderInfo?.totalPower ?? o.samples.at(-1)?.totalPower ?? 0).toFixed(2)
    const hay = [
      o.startChargeSeq,
      o.connectorId,
      o.orderInfo?.startTime ?? '',
      o.orderInfo?.endTime ?? '',
      amount,
      power,
      stateLabel(o.productState),
    ]
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
})

/** 全部已拉取站点（多对接扁平） */
const allStationRows = computed(() => {
  const out: { linkName: string; linkUuid: string; station: CecStationRecord }[] = []
  for (const link of snapshot.value.links) {
    const list = snapshot.value.stationsByLink[link.linkUuid] ?? []
    for (const station of list) {
      out.push({ linkName: link.name, linkUuid: link.linkUuid, station })
    }
  }
  return out
})

const filteredStationRows = computed(() => {
  const kw = stationKeyword.value.trim().toLowerCase()
  const linkOnly = stationLinkFilter.value
  return allStationRows.value.filter((row) => {
    if (linkOnly && row.linkUuid !== linkOnly) return false
    if (!kw) return true
    const s = row.station
    const hay = [
      row.linkName,
      String(s.StationID ?? ''),
      String(s.StationName ?? ''),
      String(s.Address ?? ''),
      String(s.AreaCode ?? ''),
      String(s.OperatorID ?? ''),
    ]
      .join(' ')
      .toLowerCase()
    return hay.includes(kw)
  })
})

const sortedStationRows = computed(() => {
  const rows = filteredStationRows.value.slice()
  const k = stationSortKey.value
  if (!k) return rows
  const ord = stationSortOrder.value === 'asc' ? 1 : -1
  rows.sort((a, b) => {
    let r = 0
    switch (k) {
      case 'link':
        r = compareStationCellStr(String(a.linkName ?? ''), String(b.linkName ?? ''))
        break
      case 'id':
        r = compareStationCellStr(String(a.station.StationID ?? ''), String(b.station.StationID ?? ''))
        break
      case 'name':
        r = compareStationCellStr(String(a.station.StationName ?? ''), String(b.station.StationName ?? ''))
        break
      case 'area':
        r = compareStationCellStr(String(a.station.AreaCode ?? ''), String(b.station.AreaCode ?? ''))
        break
      case 'st': {
        const na = Number(a.station.StationStatus)
        const nb = Number(b.station.StationStatus)
        const va = Number.isFinite(na) ? na : Number.POSITIVE_INFINITY
        const vb = Number.isFinite(nb) ? nb : Number.POSITIVE_INFINITY
        r = va === vb ? 0 : va < vb ? -1 : 1
        break
      }
      case 'open': {
        const va = isStationRowOpen(a) ? 1 : 0
        const vb = isStationRowOpen(b) ? 1 : 0
        r = va - vb
        break
      }
      case 'dev': {
        const pa = stationDeviceStatusPopover(a)
        const pb = stationDeviceStatusPopover(b)
        const va = pa ? pa.online / Math.max(1, pa.total) : -1
        const vb = pb ? pb.online / Math.max(1, pb.total) : -1
        r = va === vb ? 0 : va < vb ? -1 : 1
        break
      }
      default:
        r = 0
    }
    return r * ord
  })
  return rows
})

const pagedStationRows = computed(() => {
  const start = (stationPage.value - 1) * stationPageSize.value
  return sortedStationRows.value.slice(start, start + stationPageSize.value)
})

const filteredOrderRows = computed(() => {
  const q = orderSeqFilter.value.trim().toLowerCase()
  const list = myOrders.value
  if (!q) return list
  return list.filter((o) => o.startChargeSeq.toLowerCase().includes(q))
})

const pagedOrderRows = computed(() => {
  const start = (orderPage.value - 1) * orderPageSize.value
  return filteredOrderRows.value.slice(start, start + orderPageSize.value)
})

watch([stationKeyword, stationLinkFilter], () => {
  stationPage.value = 1
})

watch(orderSeqFilter, () => {
  orderPage.value = 1
})

watch([sortedStationRows, stationPageSize], () => {
  const maxPage = Math.max(1, Math.ceil(sortedStationRows.value.length / stationPageSize.value) || 1)
  if (stationPage.value > maxPage) stationPage.value = maxPage
})

watch([filteredOrderRows, orderPageSize], () => {
  const maxPage = Math.max(1, Math.ceil(filteredOrderRows.value.length / orderPageSize.value) || 1)
  if (orderPage.value > maxPage) orderPage.value = maxPage
})

watch(pullDialogOpen, (open) => {
  if (open && !pullLinkUuid.value && snapshot.value.links[0]) {
    pullLinkUuid.value = snapshot.value.links[0].linkUuid
  }
})

/** 手机模拟：底部导航 */
const phoneNav = ref<'charge' | 'orders' | 'startCharge' | 'liveCharge'>('charge')

/** 手机模拟：界面切换方向（充电↔订单、进入/退出启动充电） */
function phoneTransitionFor(
  from: 'charge' | 'orders' | 'startCharge' | 'liveCharge',
  to: 'charge' | 'orders' | 'startCharge' | 'liveCharge',
): 'slide-left' | 'slide-right' {
  if ((from === 'startCharge' || from === 'liveCharge') && to !== from) return 'slide-right'
  if ((to === 'startCharge' || to === 'liveCharge') && from !== to) return 'slide-left'
  if (from === 'charge' && to === 'orders') return 'slide-left'
  if (from === 'orders' && to === 'charge') return 'slide-right'
  return 'slide-left'
}

const phoneTransitionName = ref<'slide-left' | 'slide-right'>('slide-left')

watch(phoneNav, (to, from) => {
  if (from !== undefined) {
    phoneTransitionName.value = phoneTransitionFor(from, to)
  }
})

const clockTick = ref(0)
const clockStr = computed(() => {
  void clockTick.value
  const d = new Date()
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
})

const httpGuideAnchor = ref<{ left: number; top: number }>({ left: 0, top: 0 })
const httpGuideWidth = ref(320)
const httpGuideArrowLeft = ref(0)

function updateHttpGuideAnchor() {
  if (typeof window === 'undefined') return
  const btn = document.getElementById('cec-http-service-toggle')
  if (!btn) return
  const rect = btn.getBoundingClientRect()
  const margin = 16
  const maxWidth = Math.max(220, window.innerWidth - margin * 2)
  const width = Math.min(240, maxWidth)
  const minCenter = margin + width / 2
  const maxCenter = window.innerWidth - margin - width / 2
  const preferredCenter = rect.left + rect.width / 2
  const safeCenter = Math.min(maxCenter, Math.max(minCenter, preferredCenter))
  httpGuideWidth.value = width
  const arrowPadding = 14
  const arrowLeftRaw = preferredCenter - (safeCenter - width / 2)
  httpGuideArrowLeft.value = Math.min(width - arrowPadding, Math.max(arrowPadding, arrowLeftRaw))
  httpGuideAnchor.value = {
    left: safeCenter,
    top: rect.bottom + 8,
  }
}

function bindHttpGuideAnchorListeners(bind: boolean) {
  if (typeof window === 'undefined') return
  if (bind) {
    window.addEventListener('resize', updateHttpGuideAnchor)
    window.addEventListener('scroll', updateHttpGuideAnchor, true)
  } else {
    window.removeEventListener('resize', updateHttpGuideAnchor)
    window.removeEventListener('scroll', updateHttpGuideAnchor, true)
  }
}
</script>

<template>
  <div class="cec-plugin-root relative flex min-h-0 flex-1 flex-col gap-[var(--space-lg)] text-[var(--um-text)]">
    <div id="cec-file-qr-hidden" class="fixed left-0 top-0 h-px w-px overflow-hidden opacity-0" aria-hidden="true" />
    <header class="flex shrink-0 flex-wrap items-center gap-3">
      <h2 class="um-display text-lg font-semibold text-[var(--um-text)]">内互联模拟</h2>
      <div class="relative inline-flex shrink-0">
        <el-tooltip :content="httpRunning ? '停止 HTTP 服务' : '启动 HTTP 服务'" placement="bottom">
          <el-button
            id="cec-http-service-toggle"
            :type="httpRunning ? 'warning' : 'primary'"
            circle
            class="!inline-flex items-center justify-center"
            :class="{ 'cec-http-guide-pulse': httpGuideVisible && !httpRunning }"
            @click="toggleHttp"
          >
            <el-icon :size="18">
              <VideoPause v-if="httpRunning" />
              <VideoPlay v-else />
            </el-icon>
          </el-button>
        </el-tooltip>
      </div>
      <el-tooltip content="服务与日志配置" placement="bottom">
        <el-button circle class="!inline-flex items-center justify-center" @click="openCfg">
          <el-icon :size="18"><Setting /></el-icon>
        </el-button>
      </el-tooltip>
      <span v-if="httpRunning" class="text-xs text-[var(--um-text-muted)]">
        监听 {{ snapshot.settings.bindHost }}:{{ snapshot.settings.httpPort }}
      </span>
    </header>

    <div class="cec-workspace">
      <section class="cec-pane rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] p-[var(--space-md)]">
        <div class="mb-2 text-xs text-[var(--um-text-muted)]">手机模拟</div>
        <div id="cec-phone-mock-stage" class="cec-phone-mock-stage">
          <div class="flex justify-center px-1 py-2">
            <div class="cec-phone-wrap flex justify-center">
              <div class="cec-phone">
              <div class="cec-phone-bezel" aria-hidden="true" />
              <div class="cec-phone-inner">
                <header class="cec-phone-status">
                  <span class="cec-phone-time">{{ clockStr }}</span>
                  <span class="cec-phone-notch" />
                  <span class="cec-phone-icons">●●●</span>
                </header>
                <div class="cec-phone-main-screen">
                <div class="cec-phone-body">
                  <div class="cec-phone-body-content">
                  <Transition :name="phoneTransitionName" mode="out-in">
                  <div v-if="phoneNav === 'charge'" key="phone-charge" class="cec-phone-panel cec-phone-panel--fixed">
                    <div class="cec-phone-panel-head">
                      <div class="cec-phone-title">充电</div>
                      <p class="cec-phone-sub">附近开放站点</p>
                    </div>
                    <div class="cec-phone-panel-list-scroll">
                      <ul class="cec-station-list">
                        <li
                          v-for="it in openStationsFlat"
                          :key="`${it.linkUuid}-${stationIdNormalized(it.station)}`"
                          class="cec-station-card"
                        >
                          <div class="cec-station-name">{{ it.station.StationName }}</div>
                          <div class="cec-station-price-row">
                            <div class="cec-station-price">
                              <el-icon class="cec-station-price-icon" :size="14"><Coin /></el-icon>
                              <span>{{ phoneStationPriceLine(it) }}</span>
                            </div>
                            <div v-if="phoneStationIdleStats(it).show" class="cec-station-idle-inline">
                              <el-icon class="cec-station-idle-icon" :size="14"><CircleCheck /></el-icon>
                              <span class="tabular-nums">
                                {{ phoneStationIdleStats(it).idle }}/{{ phoneStationIdleStats(it).total }}
                              </span>
                            </div>
                          </div>
                        </li>
                        <li v-if="openStationsFlat.length === 0" class="cec-phone-empty">
                          暂无开放站点，请在「功能展示 → 站点查看」中拉取并开放站点。
                        </li>
                      </ul>
                    </div>
                    <div class="cec-phone-actions">
                      <button
                        type="button"
                        class="cec-btn-primary w-full"
                        @click="openPhoneStartChargeDrawer"
                      >
                        启动充电
                      </button>
                    </div>
                  </div>
                  <div v-else-if="phoneNav === 'orders'" key="phone-orders" class="cec-phone-panel cec-phone-panel--fixed">
                    <div class="cec-phone-panel-head">
                      <div class="cec-phone-title">我的订单</div>
                      <div class="cec-phone-order-search">
                        <input
                          v-model.trim="phoneOrderKeyword"
                          type="text"
                          class="cec-phone-order-search-input"
                          placeholder="搜索订单号 / 设备号 / 状态"
                        />
                      </div>
                    </div>
                    <div class="cec-phone-panel-list-scroll">
                      <ul class="cec-order-list">
                        <li v-for="row in phoneOrderRows" :key="row.id">
                          <button
                            type="button"
                            class="cec-order-row"
                            :class="{ 'cec-order-row--active': liveOrder?.id === row.id }"
                            @click="openLiveOrderFromPhoneOrders(row)"
                          >
                            <div class="cec-order-seq">{{ row.startChargeSeq }}</div>
                            <div
                              class="cec-order-state"
                              :class="{ 'cec-order-state--completed': row.productState === 'completed' }"
                            >
                              {{ stateLabel(row.productState) }}
                            </div>
                            <div class="cec-order-meta-grid">
                              <div class="cec-order-meta-item">
                                <el-icon :size="12"><Document /></el-icon>
                                <span>{{
                                  (row.orderInfo?.startTime || '—') + ' ~ ' + (row.orderInfo?.endTime || '—')
                                }}</span>
                              </div>
                              <div class="cec-order-meta-item">
                                <el-icon :size="12"><Lightning /></el-icon>
                                <span>{{ row.connectorId || '—' }}</span>
                              </div>
                              <div class="cec-order-meta-item">
                                <el-icon :size="12"><Coin /></el-icon>
                                <span>{{
                                  Number(row.orderInfo?.totalMoney ?? row.samples.at(-1)?.totalMoney ?? 0).toFixed(2)
                                }}</span>
                              </div>
                              <div class="cec-order-meta-item">
                                <el-icon :size="12"><CircleCheck /></el-icon>
                                <span>{{
                                  Number(row.orderInfo?.totalPower ?? row.samples.at(-1)?.totalPower ?? 0).toFixed(2)
                                }}</span>
                              </div>
                            </div>
                          </button>
                        </li>
                        <li v-if="phoneOrderRows.length === 0" class="cec-phone-empty">
                          {{ phoneOrderKeyword ? '无匹配订单' : '暂无订单' }}
                        </li>
                      </ul>
                    </div>
                  </div>
                  <div v-else-if="phoneNav === 'liveCharge'" key="phone-live" class="cec-phone-scroll cec-phone-start-screen cec-phone-panel">
                    <div class="cec-phone-start-toolbar">
                      <button type="button" class="cec-phone-back-btn" @click="closePhoneLiveChargeScreen">
                        <el-icon class="cec-phone-back-icon" :size="18"><ArrowLeft /></el-icon>
                        <span>返回</span>
                      </button>
                      <div class="cec-phone-start-toolbar-title">实时充电</div>
                    </div>
                    <section v-if="liveOrder" class="cec-live-card">
                      <div class="cec-live-label">实时充电</div>
                      <div class="cec-live-seq">{{ liveOrder.startChargeSeq }}</div>
                      <div class="cec-live-metrics">
                        <div>
                          <div class="cec-live-num">
                            {{ (liveOrder.samples.at(-1)?.totalPower ?? 0).toFixed(2) }}
                          </div>
                          <div class="cec-live-unit">累计电量 kWh</div>
                        </div>
                        <div>
                          <div class="cec-live-num">
                            {{ (liveOrder.samples.at(-1)?.totalMoney ?? 0).toFixed(2) }}
                          </div>
                          <div class="cec-live-unit">金额 元</div>
                        </div>
                      </div>
                      <button
                        v-if="
                          liveOrder.productState === 'charging' ||
                          liveOrder.productState === 'starting' ||
                          liveOrder.productState === 'stopping'
                        "
                        type="button"
                        class="cec-btn-stop"
                        :disabled="stopSubmittingOrderId === liveOrder.id || liveOrder.productState === 'stopping'"
                        :class="{ 'opacity-70': stopSubmittingOrderId === liveOrder.id || liveOrder.productState === 'stopping' }"
                        @click="stopLiveOrder"
                      >
                        {{ stopSubmittingOrderId === liveOrder.id || liveOrder.productState === 'stopping' ? '停止中...' : '停止充电' }}
                      </button>
                    </section>
                    <div v-else class="cec-phone-empty">暂无实时充电订单</div>
                  </div>
                  <div v-else key="phone-start" class="cec-phone-scroll cec-phone-start-screen cec-phone-panel">
                    <div class="cec-phone-start-toolbar">
                      <button type="button" class="cec-phone-back-btn" @click="closePhoneStartChargeScreen">
                        <el-icon class="cec-phone-back-icon" :size="18"><ArrowLeft /></el-icon>
                        <span>返回</span>
                      </button>
                      <div class="cec-phone-start-toolbar-title">启动充电</div>
                    </div>
                    <el-radio-group v-model="phoneStartMode" size="small" class="cec-phone-start-mode mb-4 w-full">
                      <el-radio-button value="scan">扫码充电</el-radio-button>
                      <el-radio-button value="device">设备号充电</el-radio-button>
                    </el-radio-group>
                    <div v-show="phoneStartMode === 'scan'" class="flex flex-col gap-3">
                      <div>
                        <div class="mb-1 text-xs text-[var(--um-text-muted)]">金额（元）</div>
                        <el-input v-model="startMoneyScanStr" size="small" placeholder="可选" clearable />
                      </div>
                      <div>
                        <el-button
                          size="small"
                          type="primary"
                          plain
                          :loading="qrResolving"
                          :disabled="qrResolving"
                          @click="fileInputStartRef?.click()"
                        >
                          {{ qrResolving ? '解析中…' : '选择二维码图片' }}
                        </el-button>
                        <input
                          ref="fileInputStartRef"
                          type="file"
                          accept="image/*"
                          class="hidden"
                          @change="pickQrImageForStart"
                        />
                      </div>
                      <div>
                        <div class="mb-1 text-xs text-[var(--um-text-muted)]">设备号（ConnectorID）</div>
                        <el-input
                          :model-value="scanConnectorId"
                          size="small"
                          placeholder="选择二维码后将自动解析"
                          readonly
                        />
                      </div>
                      <p
                        v-if="pendingQrText"
                        class="max-h-20 overflow-auto break-all text-xs text-[var(--um-text-muted)]"
                      >
                        二维码原文：{{ pendingQrText }}
                      </p>
                      <div class="border-t border-[var(--um-border)] pt-4">
                        <button
                          type="button"
                          class="cec-btn-primary w-full"
                          :disabled="qrResolving"
                          @click="openStartChargeConfirm"
                        >
                          启动
                        </button>
                      </div>
                    </div>
                    <div v-show="phoneStartMode === 'device'" class="flex flex-col gap-3">
                      <div>
                        <div class="mb-1 text-xs text-[var(--um-text-muted)]">设备号（ConnectorID）</div>
                        <el-input v-model="startDeviceIdInput" size="small" placeholder="必填" clearable />
                      </div>
                      <div>
                        <div class="mb-1 text-xs text-[var(--um-text-muted)]">金额（元）</div>
                        <el-input v-model="startMoneyDeviceStr" size="small" placeholder="可选" clearable />
                      </div>
                      <div class="border-t border-[var(--um-border)] pt-4">
                        <button type="button" class="cec-btn-primary w-full" @click="openStartChargeConfirm">
                          启动
                        </button>
                      </div>
                    </div>
                  </div>
                  </Transition>
                  </div>
                </div>
                <nav class="cec-phone-tabbar" aria-label="手机模拟导航">
                  <button
                    type="button"
                    class="cec-tabbar-btn"
                    :class="{ 'cec-tabbar-btn--on': phoneNav === 'charge' }"
                    @click="phoneNav = 'charge'"
                  >
                    充电
                  </button>
                  <button
                    type="button"
                    class="cec-tabbar-btn"
                    :class="{ 'cec-tabbar-btn--on': phoneNav === 'orders' }"
                    @click="phoneNav = 'orders'"
                  >
                    订单
                  </button>
                </nav>
                </div>
              </div>
            </div>
          </div>
          </div>
        </div>
      </section>

      <section class="cec-pane rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] p-[var(--space-md)]">
        <div class="cec-center-nav mb-3" role="navigation" aria-label="功能展示">
          <button
            type="button"
            class="cec-center-nav-item"
            :class="{ 'cec-center-nav-item--active': bizPanel === 'stations' }"
            @click="bizPanel = 'stations'"
          >
            站点查看
          </button>
          <button
            type="button"
            class="cec-center-nav-item"
            :class="{ 'cec-center-nav-item--active': bizPanel === 'orders' }"
            @click="bizPanel = 'orders'"
          >
            订单查看
          </button>
        </div>

        <div v-show="bizPanel === 'stations'" class="cec-biz-panel">
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <el-button type="primary" size="small" @click="pullDialogOpen = true">拉取站点</el-button>
            <span class="text-xs text-[var(--um-text-muted)]">从第三方分页拉取直至完成，结果合并到当前对接</span>
          </div>
          <div class="mb-3 flex flex-wrap items-end justify-between gap-4">
            <div class="flex flex-wrap items-end gap-4">
              <div>
                <div class="mb-1 text-xs text-[var(--um-text-muted)]">关键字</div>
                <el-input
                  v-model="stationKeyword"
                  size="small"
                  clearable
                  placeholder="站点 ID / 名称 / 地址 / 对接名称"
                  style="width: 220px"
                />
              </div>
              <div>
                <div class="mb-1 text-xs text-[var(--um-text-muted)]">对接</div>
                <el-select
                  v-model="stationLinkFilter"
                  size="small"
                  clearable
                  placeholder="全部对接"
                  style="width: 160px"
                >
                  <el-option
                    v-for="l in snapshot.links"
                    :key="l.id"
                    :label="l.name"
                    :value="l.linkUuid"
                  />
                </el-select>
              </div>
            </div>
            <el-button
              v-show="stationSelection.length > 0"
              type="danger"
              size="small"
              @click="deleteSelectedStations"
            >
              删除选中（{{ stationSelection.length }}）
            </el-button>
          </div>
          <el-table
            ref="stationTableRef"
            :data="pagedStationRows"
            :row-key="stationRowKey"
            size="small"
            max-height="420"
            border
            @row-dblclick="openStationDetailDialog"
            @selection-change="onStationSelectionChange"
          >
            <el-table-column type="selection" width="48" reserve-selection />
            <el-table-column width="100">
              <template #header>
                <button
                  type="button"
                  class="cec-st-sort-th"
                  @click="toggleStationSort('link')"
                >
                  <span>对接</span>
                  <span class="cec-st-sort-tris" aria-hidden="true">
                    <span
                      class="cec-st-sort-tri cec-st-sort-tri--up"
                      :class="{
                        'is-active': stationSortKey === 'link' && stationSortOrder === 'asc',
                      }"
                    />
                    <span
                      class="cec-st-sort-tri cec-st-sort-tri--down"
                      :class="{
                        'is-active': stationSortKey === 'link' && stationSortOrder === 'desc',
                      }"
                    />
                  </span>
                </button>
              </template>
              <template #default="{ row }">{{ row.linkName }}</template>
            </el-table-column>
            <el-table-column width="100">
              <template #header>
                <button
                  type="button"
                  class="cec-st-sort-th"
                  @click="toggleStationSort('id')"
                >
                  <span>站点 ID</span>
                  <span class="cec-st-sort-tris" aria-hidden="true">
                    <span
                      class="cec-st-sort-tri cec-st-sort-tri--up"
                      :class="{
                        'is-active': stationSortKey === 'id' && stationSortOrder === 'asc',
                      }"
                    />
                    <span
                      class="cec-st-sort-tri cec-st-sort-tri--down"
                      :class="{
                        'is-active': stationSortKey === 'id' && stationSortOrder === 'desc',
                      }"
                    />
                  </span>
                </button>
              </template>
              <template #default="{ row }">{{ row.station.StationID }}</template>
            </el-table-column>
            <el-table-column min-width="120" show-overflow-tooltip>
              <template #header>
                <button
                  type="button"
                  class="cec-st-sort-th"
                  @click="toggleStationSort('name')"
                >
                  <span>名称</span>
                  <span class="cec-st-sort-tris" aria-hidden="true">
                    <span
                      class="cec-st-sort-tri cec-st-sort-tri--up"
                      :class="{
                        'is-active': stationSortKey === 'name' && stationSortOrder === 'asc',
                      }"
                    />
                    <span
                      class="cec-st-sort-tri cec-st-sort-tri--down"
                      :class="{
                        'is-active': stationSortKey === 'name' && stationSortOrder === 'desc',
                      }"
                    />
                  </span>
                </button>
              </template>
              <template #default="{ row }">{{ row.station.StationName }}</template>
            </el-table-column>
            <el-table-column width="90" show-overflow-tooltip>
              <template #header>
                <button
                  type="button"
                  class="cec-st-sort-th"
                  @click="toggleStationSort('area')"
                >
                  <span>区划</span>
                  <span class="cec-st-sort-tris" aria-hidden="true">
                    <span
                      class="cec-st-sort-tri cec-st-sort-tri--up"
                      :class="{
                        'is-active': stationSortKey === 'area' && stationSortOrder === 'asc',
                      }"
                    />
                    <span
                      class="cec-st-sort-tri cec-st-sort-tri--down"
                      :class="{
                        'is-active': stationSortKey === 'area' && stationSortOrder === 'desc',
                      }"
                    />
                  </span>
                </button>
              </template>
              <template #default="{ row }">{{ row.station.AreaCode }}</template>
            </el-table-column>
            <el-table-column width="110" show-overflow-tooltip>
              <template #header>
                <button
                  type="button"
                  class="cec-st-sort-th"
                  @click="toggleStationSort('st')"
                >
                  <span>站点状态</span>
                  <span class="cec-st-sort-tris" aria-hidden="true">
                    <span
                      class="cec-st-sort-tri cec-st-sort-tri--up"
                      :class="{
                        'is-active': stationSortKey === 'st' && stationSortOrder === 'asc',
                      }"
                    />
                    <span
                      class="cec-st-sort-tri cec-st-sort-tri--down"
                      :class="{
                        'is-active': stationSortKey === 'st' && stationSortOrder === 'desc',
                      }"
                    />
                  </span>
                </button>
              </template>
              <template #default="{ row }">{{ stationStatusLabelCec(row.station.StationStatus) }}</template>
            </el-table-column>
            <el-table-column width="72" align="center">
              <template #header>
                <button
                  type="button"
                  class="cec-st-sort-th cec-st-sort-th--center"
                  @click="toggleStationSort('open')"
                >
                  <span>开放</span>
                  <span class="cec-st-sort-tris" aria-hidden="true">
                    <span
                      class="cec-st-sort-tri cec-st-sort-tri--up"
                      :class="{
                        'is-active': stationSortKey === 'open' && stationSortOrder === 'asc',
                      }"
                    />
                    <span
                      class="cec-st-sort-tri cec-st-sort-tri--down"
                      :class="{
                        'is-active': stationSortKey === 'open' && stationSortOrder === 'desc',
                      }"
                    />
                  </span>
                </button>
              </template>
              <template #default="{ row }">
                <span @click.stop @dblclick.stop>
                  <el-switch
                    :model-value="isStationRowOpen(row)"
                    @update:model-value="(v: boolean) => toggleOpen(row.linkUuid, row.station, v)"
                  />
                </span>
              </template>
            </el-table-column>
            <el-table-column width="120" align="center">
              <template #header>
                <button
                  type="button"
                  class="cec-st-sort-th cec-st-sort-th--center"
                  @click="toggleStationSort('dev')"
                >
                  <span>设备状态</span>
                  <span class="cec-st-sort-tris" aria-hidden="true">
                    <span
                      class="cec-st-sort-tri cec-st-sort-tri--up"
                      :class="{
                        'is-active': stationSortKey === 'dev' && stationSortOrder === 'asc',
                      }"
                    />
                    <span
                      class="cec-st-sort-tri cec-st-sort-tri--down"
                      :class="{
                        'is-active': stationSortKey === 'dev' && stationSortOrder === 'desc',
                      }"
                    />
                  </span>
                </button>
              </template>
              <template #default="{ row }">
                <el-popover placement="bottom" :width="300" trigger="click">
                  <template #reference>
                    <el-button link type="primary" size="small" @click.stop>
                      {{ stationDeviceStatusButtonText(row) }}
                    </el-button>
                  </template>
                  <template v-if="stationDeviceStatusPopover(row)">
                    <div class="text-sm text-[var(--um-text)]">
                      枪设备在线：
                      <span class="font-semibold tabular-nums">
                        {{ stationDeviceStatusPopover(row)!.online }} /
                        {{ stationDeviceStatusPopover(row)!.total }}
                      </span>
                    </div>
                    <div
                      class="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface-2)] p-3 text-xs"
                    >
                      <div>
                        空闲
                        <span class="ml-1 font-semibold tabular-nums text-[var(--um-text)]">{{
                          stationDeviceStatusPopover(row)!.idle
                        }}</span>
                      </div>
                      <div>
                        充电中
                        <span class="ml-1 font-semibold tabular-nums text-[var(--um-text)]">{{
                          stationDeviceStatusPopover(row)!.charging
                        }}</span>
                      </div>
                      <div>
                        占用
                        <span class="ml-1 font-semibold tabular-nums text-[var(--um-text)]">{{
                          stationDeviceStatusPopover(row)!.occupied
                        }}</span>
                      </div>
                      <div>
                        故障
                        <span class="ml-1 font-semibold tabular-nums text-[var(--um-text)]">{{
                          stationDeviceStatusPopover(row)!.fault
                        }}</span>
                      </div>
                    </div>
                  </template>
                  <template v-else>
                    <p class="text-xs text-[var(--um-text-muted)]">暂无状态，请在操作列点击「拉取状态」</p>
                  </template>
                </el-popover>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="168" align="center">
              <template #default="{ row }">
                <el-button
                  link
                  type="primary"
                  size="small"
                  :loading="stationStatusPullingKey === stationRowKey(row)"
                  @click="pullStationStatusRow(row)"
                >
                  拉取状态
                </el-button>
                <el-button link type="primary" size="small" @click="openStationDetailDialog(row)">
                  详情
                </el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="mt-3 flex justify-end">
            <el-pagination
              v-model:current-page="stationPage"
              v-model:page-size="stationPageSize"
              :page-sizes="[10, 20, 50, 100]"
              layout="total, sizes, prev, pager, next"
              :total="sortedStationRows.length"
              size="small"
              background
            />
          </div>
        </div>

        <div v-show="bizPanel === 'orders'" class="cec-biz-panel">
          <div class="mb-3">
            <el-input
              v-model="orderSeqFilter"
              size="small"
              clearable
              placeholder="按订单号筛选"
              class="max-w-xs"
            />
          </div>
          <el-table :data="pagedOrderRows" size="small" max-height="420" border>
            <el-table-column label="启动时间" width="168" show-overflow-tooltip>
              <template #default="{ row }">{{ formatOrderStartTime(row) }}</template>
            </el-table-column>
            <el-table-column label="互联互通名称" min-width="120" show-overflow-tooltip>
              <template #default="{ row }">{{ linkNameByUuid(row.linkUuid) }}</template>
            </el-table-column>
            <el-table-column prop="startChargeSeq" label="订单号" min-width="140" show-overflow-tooltip />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">{{ stateLabel(row.productState) }}</template>
            </el-table-column>
            <el-table-column prop="connectorId" label="枪" width="120" show-overflow-tooltip />
            <el-table-column label="操作" width="270" align="center">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="openOrderDetail(row)">详情</el-button>
                <el-button
                  v-if="canManualSyncOrderStatus(row)"
                  link
                  type="primary"
                  size="small"
                  :loading="syncingOrderId === row.id"
                  @click="syncOrderStatus(row)"
                >
                  同步订单状态
                </el-button>
                <el-button link type="danger" size="small" @click.stop="removeOrder(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="mt-3 flex justify-end">
            <el-pagination
              v-model:current-page="orderPage"
              v-model:page-size="orderPageSize"
              :page-sizes="[10, 20, 50, 100]"
              layout="total, sizes, prev, pager, next"
              :total="filteredOrderRows.length"
              size="small"
              background
            />
          </div>
        </div>
      </section>

      <section class="cec-side-shell">
        <div
          v-if="rightPanel !== 'none'"
          class="cec-side-panel rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] p-[var(--space-md)]"
        >
          <div v-if="rightPanel === 'links'" class="cec-side-panel-inner cec-biz-panel">
            <div class="mb-3 flex flex-wrap gap-2">
              <el-button type="primary" size="small" @click="openLinkDialog()">新增配置</el-button>
              <el-button size="small" @click="triggerLinkImport">导入 JSON</el-button>
              <input
                ref="linkImportInputRef"
                type="file"
                accept="application/json,.json"
                class="hidden"
                @change="onImportLinkConfig"
              />
            </div>
            <div class="mb-3 flex flex-wrap items-end gap-4">
              <div>
                <div class="mb-1 text-xs text-[var(--um-text-muted)]">关键字</div>
                <el-input
                  v-model="linkKeyword"
                  size="small"
                  clearable
                  placeholder="名称 / 对接码"
                  style="width: 220px"
                />
              </div>
            </div>
            <el-table :data="pagedLinks" size="small" max-height="420" border>
              <el-table-column prop="name" label="名称" min-width="100" show-overflow-tooltip />
              <el-table-column prop="linkUuid" label="对接码" min-width="120" show-overflow-tooltip />
              <el-table-column label="操作" width="248" align="center">
                <template #default="{ row }">
                  <el-button link type="primary" size="small" @click="openLinkDialog(row)">编辑</el-button>
                  <el-button link type="primary" size="small" @click="openTokenDialog(row)">Token</el-button>
                  <el-button link type="primary" size="small" @click="exportLinkConfigJson(row)">导出 JSON</el-button>
                  <el-button link type="danger" size="small" @click="removeLink(row.id)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
            <div class="mt-3 flex justify-end">
              <el-pagination
                v-model:current-page="linkPage"
                v-model:page-size="linkPageSize"
                :page-sizes="[10, 20, 50, 100]"
                layout="total, sizes, prev, pager, next"
                :total="filteredLinks.length"
                size="small"
                background
              />
            </div>
          </div>
          <div v-else class="cec-side-panel-inner">
            <div class="cec-side-panel-toolbar mb-2 flex items-center gap-2">
              <el-input v-model="logFilter" size="small" placeholder="过滤关键字" clearable />
              <el-button size="small" type="danger" plain @click="clearAllLogs">清空日志</el-button>
            </div>
            <div class="cec-side-panel-scroll cec-scroll-unified space-y-1 text-xs">
              <div
                v-for="log in filteredLogs"
                :key="log.id"
                class="rounded border border-[var(--um-border)] bg-[var(--um-surface-2)] px-2 py-1"
              >
                <div class="flex gap-1">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left"
                    @click="expandedLogs[log.id] = !expandedLogs[log.id]"
                  >
                    <span class="text-[var(--um-text-muted)]">{{ new Date(log.t).toLocaleString() }}</span>
                    <span
                      :class="
                        log.direction === 'inbound'
                          ? 'text-[oklch(0.65_0.12_195)]'
                          : 'text-[oklch(0.65_0.12_140)]'
                      "
                    >
                      {{ log.direction === 'inbound' ? '接收' : '向外' }}
                    </span>
                    <span>{{ log.name }}</span>
                    <span :class="isFailureSummary(log.summary) ? 'text-red-500' : 'text-[var(--um-text-muted)]'">
                      {{ log.summary }}
                    </span>
                  </button>
                  <div
                    v-if="logShowsPlainCipherToggle(log)"
                    class="cec-log-mode-switch inline-flex shrink-0 self-start overflow-hidden rounded border border-[var(--um-border)] text-[10px] leading-none"
                  >
                    <button
                      type="button"
                      class="px-1.5 py-1 transition-colors"
                      :class="
                        !isLogCipherMode(log.id)
                          ? 'bg-[var(--el-color-primary)] text-white'
                          : 'bg-[var(--um-surface)] text-[var(--um-text-muted)] hover:text-[var(--um-text)]'
                      "
                      @click.stop="setLogCipherView(log.id, false)"
                    >
                      明文
                    </button>
                    <button
                      type="button"
                      class="border-l border-[var(--um-border)] px-1.5 py-1 transition-colors"
                      :class="
                        isLogCipherMode(log.id)
                          ? 'bg-[var(--el-color-primary)] text-white'
                          : 'bg-[var(--um-surface)] text-[var(--um-text-muted)] hover:text-[var(--um-text)]'
                      "
                      @click.stop="setLogCipherView(log.id, true)"
                    >
                      密文
                    </button>
                  </div>
                  <el-tooltip content="复制本条" placement="left">
                    <el-button
                      link
                      type="primary"
                      size="small"
                      class="!h-6 !min-h-0 shrink-0 self-start px-1"
                      @click.stop="copyLogEntry(log)"
                    >
                      <el-icon :size="14"><DocumentCopy /></el-icon>
                    </el-button>
                  </el-tooltip>
                </div>
                <pre v-if="expandedLogs[log.id]" class="mt-1 whitespace-pre-wrap break-all text-[10px]">{{
                  formatLogExpanded(log)
                }}</pre>
              </div>
            </div>
          </div>
        </div>
        <div class="cec-side-rail rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)]">
          <el-tooltip content="互联互通配置" placement="left">
            <button
              type="button"
              class="cec-side-btn"
              :class="{ 'cec-side-btn--active': rightPanel === 'links' }"
              @click="toggleRightPanel('links')"
            >
              <el-icon :size="18"><Setting /></el-icon>
            </button>
          </el-tooltip>
          <el-tooltip content="日志展示" placement="left">
            <button
              type="button"
              class="cec-side-btn"
              :class="{ 'cec-side-btn--active': rightPanel === 'logs' }"
              @click="toggleRightPanel('logs')"
            >
              <el-icon :size="18"><Document /></el-icon>
            </button>
          </el-tooltip>
        </div>
      </section>
    </div>

    <el-dialog v-model="pullDialogOpen" title="拉取站点" width="440px" destroy-on-close append-to-body>
      <p class="mb-3 text-xs leading-relaxed text-[var(--um-text-muted)]">
        按分页连续调用 query_stations_info，直至无更多页，站点合并写入所选第三方对接并更新枪号映射。
      </p>
      <el-form label-width="100px" size="small">
        <el-form-item label="第三方配置">
          <el-select
            v-model="pullLinkUuid"
            placeholder="选择互联互通对接"
            class="w-full"
            filterable
            teleported
            popper-class="cec-dialog-select-popper"
          >
            <el-option
              v-for="l in snapshot.links"
              :key="l.id"
              :label="`${l.name} (${l.linkUuid})`"
              :value="l.linkUuid"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="每页条数">
          <el-input-number
            v-model="pullPageSize"
            :min="1"
            :max="2000"
            :step="10"
            class="w-full"
            controls-position="right"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pullDialogOpen = false">取消</el-button>
        <el-button
          type="primary"
          :loading="pullOverlayActive"
          :disabled="snapshot.links.length === 0"
          @click="runPullStations"
        >
          拉取
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="stationDetailOpen"
      title="电站详情"
      width="920px"
      class="cec-station-detail-dialog !max-w-[96vw]"
      destroy-on-close
    >
      <template v-if="stationDetailCtx">
        <el-tabs v-model="stationDetailTab" class="cec-station-detail-tabs">
          <el-tab-pane label="电站信息" name="station">
            <el-descriptions
              :column="2"
              border
              size="small"
              class="cec-station-desc mt-1 max-h-[min(520px,60vh)] overflow-auto"
            >
              <el-descriptions-item label="充电站 ID">{{ stationInfoText(stationDetailCtx.station.StationID) }}</el-descriptions-item>
              <el-descriptions-item label="运营商 ID">{{ stationInfoText(stationDetailCtx.station.OperatorID) }}</el-descriptions-item>
              <el-descriptions-item label="设备所属方 ID">{{ stationInfoText(stationDetailCtx.station.EquipmentOwnerID) }}</el-descriptions-item>
              <el-descriptions-item label="充电站名称">{{ stationInfoText(stationDetailCtx.station.StationName) }}</el-descriptions-item>
              <el-descriptions-item label="国家代码">{{ stationInfoText(stationDetailCtx.station.CountryCode) }}</el-descriptions-item>
              <el-descriptions-item label="省市辖区编码">{{ stationInfoText(stationDetailCtx.station.AreaCode) }}</el-descriptions-item>
              <el-descriptions-item label="详细地址" :span="2">
                <span class="cec-station-desc-value">{{ stationInfoText(stationDetailCtx.station.Address) }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="站点电话">{{ stationInfoText(stationDetailCtx.station.StationTel) }}</el-descriptions-item>
              <el-descriptions-item label="服务电话">{{ stationInfoText(stationDetailCtx.station.ServiceTel) }}</el-descriptions-item>
              <el-descriptions-item label="站点类型">{{ stationTypeLabelCec(stationDetailCtx.station.StationType) }}</el-descriptions-item>
              <el-descriptions-item label="站点状态">{{ stationStatusLabelCec(stationDetailCtx.station.StationStatus) }}</el-descriptions-item>
              <el-descriptions-item label="车位数量">{{ stationInfoText(stationDetailCtx.station.ParkNums) }}</el-descriptions-item>
              <el-descriptions-item label="经纬度" :span="2">
                经度 {{ stationInfoText(stationDetailCtx.station.StationLng) }} · 纬度
                {{ stationInfoText(stationDetailCtx.station.StationLat) }}
              </el-descriptions-item>
              <el-descriptions-item label="站点引导" :span="2">{{ stationInfoText(stationDetailCtx.station.SiteGuide) }}</el-descriptions-item>
              <el-descriptions-item label="建设场所">{{ constructionLabelCec(stationDetailCtx.station.Construction) }}</el-descriptions-item>
              <el-descriptions-item label="使用车型描述" :span="2">{{ stationInfoText(stationDetailCtx.station.MatchCars) }}</el-descriptions-item>
              <el-descriptions-item label="车位楼层及数量" :span="2">{{ stationInfoText(stationDetailCtx.station.ParkInfo) }}</el-descriptions-item>
              <el-descriptions-item label="营业时间">{{ stationInfoText(stationDetailCtx.station.BusinetHours) }}</el-descriptions-item>
              <el-descriptions-item label="充电电费率">{{ stationInfoText(stationDetailCtx.station.ElectricityFee) }}</el-descriptions-item>
              <el-descriptions-item label="服务费率">{{ stationInfoText(stationDetailCtx.station.ServiceFee) }}</el-descriptions-item>
              <el-descriptions-item label="停车费">{{ stationInfoText(stationDetailCtx.station.ParkFee) }}</el-descriptions-item>
              <el-descriptions-item label="支付方式">{{ stationInfoText(stationDetailCtx.station.Payment) }}</el-descriptions-item>
              <el-descriptions-item label="是否支持预约">{{ supportOrderLabel(stationDetailCtx.station.SupportOrder) }}</el-descriptions-item>
              <el-descriptions-item label="站点照片" :span="2">
                <span class="cec-station-desc-value">{{ stationPicturesText(stationDetailCtx.station.Pictures) }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="备注" :span="2">{{ stationInfoText(stationDetailCtx.station.Remark) }}</el-descriptions-item>
            </el-descriptions>
          </el-tab-pane>
          <el-tab-pane label="电桩信息" name="pile">
            <div class="cec-pile-stat-cards mb-3 flex flex-wrap gap-3">
              <div class="cec-pile-stat-card">
                <div class="cec-pile-stat-num">{{ stationDetailPileCount }}</div>
                <div class="cec-pile-stat-label">桩数量</div>
              </div>
              <div class="cec-pile-stat-card">
                <div class="cec-pile-stat-num">{{ stationDetailGunCount }}</div>
                <div class="cec-pile-stat-label">枪数量</div>
              </div>
            </div>
            <div
              v-if="stationDetailConnectorStats"
              class="cec-connector-summary-card mb-3 rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface-2)] p-4"
            >
              <div class="mb-3 text-center text-sm font-medium text-[var(--um-text)]">
                枪设备在线
                <span class="tabular-nums text-[var(--um-brand)]">
                  {{ stationDetailConnectorStats.online }} / {{ stationDetailConnectorStats.total }}
                </span>
              </div>
              <div class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div class="rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] px-3 py-2 text-center">
                  <div class="text-xs text-[var(--um-text-muted)]">空闲</div>
                  <div class="text-lg font-semibold tabular-nums">{{ stationDetailConnectorStats.idle }}</div>
                </div>
                <div class="rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] px-3 py-2 text-center">
                  <div class="text-xs text-[var(--um-text-muted)]">充电中</div>
                  <div class="text-lg font-semibold tabular-nums">{{ stationDetailConnectorStats.charging }}</div>
                </div>
                <div class="rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] px-3 py-2 text-center">
                  <div class="text-xs text-[var(--um-text-muted)]">占用</div>
                  <div class="text-lg font-semibold tabular-nums">{{ stationDetailConnectorStats.occupied }}</div>
                </div>
                <div class="rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] px-3 py-2 text-center">
                  <div class="text-xs text-[var(--um-text-muted)]">故障</div>
                  <div class="text-lg font-semibold tabular-nums">{{ stationDetailConnectorStats.fault }}</div>
                </div>
              </div>
            </div>
            <p v-else class="mb-3 text-xs text-[var(--um-text-muted)]">
              暂无接口状态：请在站点列表对该站执行「拉取状态」后展示。
            </p>
            <div class="mb-2">
              <div class="mb-1 text-xs text-[var(--um-text-muted)]">搜索桩 / 枪</div>
              <el-input
                v-model="stationDetailFilter"
                size="small"
                clearable
                placeholder="设备编码、型号、枪编码、车位号…"
                class="max-w-sm"
              />
            </div>
            <el-table
              ref="equipmentTableRef"
              :data="stationDetailFilteredEquipment"
              row-key="rowKey"
              size="small"
              border
              max-height="420"
              class="cec-equipment-expand-table"
              @row-click="onEquipmentTableRowClick"
            >
              <el-table-column type="expand">
                <template #default="{ row: eqRow }">
                  <div class="cec-connector-nested px-2 pb-2">
                    <el-table :data="eqRow.ConnectorInfos" size="small" border class="w-full">
                      <el-table-column label="枪编码" min-width="120" show-overflow-tooltip>
                        <template #default="{ row: c }">{{ c.ConnectorID }}</template>
                      </el-table-column>
                      <el-table-column label="接口状态" width="108" show-overflow-tooltip>
                        <template #default="{ row: c }">{{ connectorStatusForGun(c.ConnectorID) }}</template>
                      </el-table-column>
                      <el-table-column label="名称" min-width="90" show-overflow-tooltip>
                        <template #default="{ row: c }">{{ c.ConnectorName ?? '—' }}</template>
                      </el-table-column>
                      <el-table-column label="接口类型" min-width="120" show-overflow-tooltip>
                        <template #default="{ row: c }">{{ connectorTypeLabel(c.ConnectorType) }}</template>
                      </el-table-column>
                      <el-table-column label="电压 V" width="100" align="right">
                        <template #default="{ row: c }">
                          {{ c.VoltageLowerLimits ?? '—' }} ~ {{ c.VoltageUpperLimits ?? '—' }}
                        </template>
                      </el-table-column>
                      <el-table-column label="电流 A" width="72" align="right">
                        <template #default="{ row: c }">{{ Number.isFinite(c.Current) ? c.Current : '—' }}</template>
                      </el-table-column>
                      <el-table-column label="功率 kW" width="80" align="right">
                        <template #default="{ row: c }">{{ Number.isFinite(c.Power) ? c.Power : '—' }}</template>
                      </el-table-column>
                      <el-table-column label="车位" width="80" show-overflow-tooltip>
                        <template #default="{ row: c }">{{ c.ParkNo ?? '—' }}</template>
                      </el-table-column>
                    </el-table>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="设备编码" min-width="140" show-overflow-tooltip>
                <template #default="{ row: eqRow }">{{ eqRow.EquipmentID }}</template>
              </el-table-column>
              <el-table-column label="名称" min-width="100" show-overflow-tooltip>
                <template #default="{ row: eqRow }">{{ eqRow.EquipmentName ?? '—' }}</template>
              </el-table-column>
              <el-table-column label="类型" width="88">
                <template #default="{ row: eqRow }">{{ equipmentTypeLabel(eqRow.EquipmentType) }}</template>
              </el-table-column>
              <el-table-column label="型号" min-width="100" show-overflow-tooltip>
                <template #default="{ row: eqRow }">{{ eqRow.EquipmentModel ?? '—' }}</template>
              </el-table-column>
              <el-table-column label="厂商" min-width="100" show-overflow-tooltip>
                <template #default="{ row: eqRow }">{{ eqRow.ManufacturerName ?? '—' }}</template>
              </el-table-column>
              <el-table-column label="桩功率 kW" width="96" align="right">
                <template #default="{ row: eqRow }">{{ Number.isFinite(eqRow.Power) ? eqRow.Power : '—' }}</template>
              </el-table-column>
              <el-table-column label="枪数" width="64" align="center">
                <template #default="{ row: eqRow }">{{ eqRow.ConnectorInfos.length }}</template>
              </el-table-column>
              <el-table-column label="操作" width="72" align="center" fixed="right">
                <template #default="{ row: eqRow }">
                  <el-button link type="danger" size="small" @click.stop="deleteEquipmentRow(eqRow)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
            <p v-if="stationDetailFilteredEquipment.length === 0" class="mt-2 text-center text-xs text-[var(--um-text-muted)]">
              {{ stationDetailEquipmentRows.length === 0 ? '暂无 EquipmentInfos，请确认已拉取站点且对端返回设备列表' : '无匹配项，请调整搜索关键字' }}
            </p>
          </el-tab-pane>
          <el-tab-pane label="全部费率信息" name="policy">
            <div class="cec-policy-current-card mb-4 rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface-2)] p-4">
              <div class="mb-3 text-center text-sm font-medium text-[var(--um-text)]">
                当前时刻 {{ policyClockStr }}
              </div>
              <div class="flex flex-wrap items-stretch justify-center gap-6">
                <div class="cec-policy-current-item flex min-w-[200px] flex-1 items-center gap-3">
                  <el-icon class="shrink-0 text-[oklch(0.65_0.14_85)]" :size="28"><Lightning /></el-icon>
                  <div class="min-w-0">
                    <div class="text-xs text-[var(--um-text-muted)]">电价</div>
                    <div class="text-lg font-semibold tabular-nums text-[var(--um-text)]">
                      {{ policyCardData ? policyCardData.elec.toFixed(4) : '—' }}
                      <span v-if="policyCardData" class="text-xs font-normal text-[var(--um-text-muted)]">元/kWh</span>
                    </div>
                  </div>
                </div>
                <div class="cec-policy-current-item flex min-w-[200px] flex-1 items-center gap-3">
                  <el-icon class="shrink-0 text-[oklch(0.65_0.12_145)]" :size="28"><Coin /></el-icon>
                  <div class="min-w-0">
                    <div class="text-xs text-[var(--um-text-muted)]">服务费</div>
                    <div class="text-lg font-semibold tabular-nums text-[var(--um-text)]">
                      {{ policyCardData ? policyCardData.svc.toFixed(4) : '—' }}
                      <span v-if="policyCardData" class="text-xs font-normal text-[var(--um-text-muted)]">元/kWh</span>
                    </div>
                  </div>
                </div>
              </div>
              <p v-if="!policyCardData" class="mt-3 text-center text-xs text-[var(--um-text-muted)]">
                暂无已同步的费率策略，请在下方列表中同步后展示（取首条成功枪参与当前时段匹配）
              </p>
            </div>
            <div class="mb-2 flex flex-wrap items-end justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="mb-1 text-xs text-[var(--um-text-muted)]">过滤枪 / 设备</div>
                <el-input
                  v-model="policyFilter"
                  size="small"
                  clearable
                  placeholder="枪编码、设备编码、设备名称"
                  class="max-w-md"
                />
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <el-button size="small" @click="policyFilter = ''">显示全部</el-button>
                <el-button
                  type="primary"
                  size="small"
                  :loading="policySyncAllLoading"
                  @click="syncPolicyAllFiltered"
                >
                  同步
                </el-button>
              </div>
            </div>
            <el-table
              v-if="stationDetailCtx"
              :data="stationPolicyFilteredRows"
              size="small"
              border
              max-height="380"
              class="max-w-full"
            >
              <el-table-column type="expand">
                <template #default="{ row: pr }">
                  <div class="cec-policy-expand px-2 pb-2">
                    <div class="mb-1 text-[11px] text-[var(--um-text-muted)]">时段费率（PolicyInfos）</div>
                    <el-table
                      :data="
                        snapshot.equipBusinessPolicyByKey?.[policyKey(stationDetailLinkUuid, pr.connectorId)]
                          ?.PolicyInfos ?? []
                      "
                      size="small"
                      border
                      class="w-full"
                    >
                      <el-table-column label="起始时间" width="110">
                        <template #default="{ row: pi }">{{ pi.StartTime }}</template>
                      </el-table-column>
                      <el-table-column label="电费" width="120" align="right">
                        <template #default="{ row: pi }">{{
                          Number.isFinite(Number(pi.ElecPrice)) ? Number(pi.ElecPrice).toFixed(4) : '—'
                        }}</template>
                      </el-table-column>
                      <el-table-column label="服务费" width="120" align="right">
                        <template #default="{ row: pi }">{{ policySevicePrice(pi).toFixed(4) }}</template>
                      </el-table-column>
                    </el-table>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="枪编码" min-width="120" show-overflow-tooltip>
                <template #default="{ row: pr }">{{ pr.connectorId }}</template>
              </el-table-column>
              <el-table-column label="设备编码" min-width="120" show-overflow-tooltip>
                <template #default="{ row: pr }">{{ pr.equipmentId || '—' }}</template>
              </el-table-column>
              <el-table-column label="时段数" width="80" align="center">
                <template #default="{ row: pr }">
                  {{ policySumPeriod(stationDetailLinkUuid, pr.connectorId) }}
                </template>
              </el-table-column>
              <el-table-column label="同步时间" min-width="150" show-overflow-tooltip>
                <template #default="{ row: pr }">
                  {{ formatPolicyFetched(stationDetailLinkUuid, pr.connectorId) }}
                </template>
              </el-table-column>
              <el-table-column label="状态" min-width="140" show-overflow-tooltip>
                <template #default="{ row: pr }">
                  {{ policyRowStatus(stationDetailLinkUuid, pr.connectorId) }}
                </template>
              </el-table-column>
              <el-table-column label="操作" width="100" align="center" fixed="right">
                <template #default="{ row: pr }">
                  <el-button
                    link
                    type="primary"
                    size="small"
                    :loading="policySyncingConnector === pr.connectorId"
                    @click="syncPolicyForConnector(pr.connectorId)"
                  >
                    同步
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
            <p
              v-if="stationPolicyFilteredRows.length === 0"
              class="mt-2 text-center text-xs text-[var(--um-text-muted)]"
            >
              {{
                stationPolicyConnectorRows.length === 0
                  ? '暂无充电枪，请确认站点已拉取且包含 EquipmentInfos'
                  : '无匹配项，请调整过滤条件或点击「显示全部」'
              }}
            </p>
          </el-tab-pane>
        </el-tabs>
      </template>
      <template #footer>
        <el-button type="primary" @click="stationDetailOpen = false">关闭</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="cfgOpen" title="配置" width="640px" class="cec-cfg-dialog">
      <div class="flex min-h-[280px] gap-4">
        <nav
          class="cec-cfg-nav flex w-[148px] shrink-0 flex-col gap-0.5 border-r border-[var(--um-border)] pr-3"
          aria-label="配置分类"
        >
          <button
            type="button"
            class="cec-cfg-nav-item"
            :class="{ 'cec-cfg-nav-item--active': cfgSection === 'http' }"
            @click="cfgSection = 'http'"
          >
            HTTP 服务配置
          </button>
          <button
            type="button"
            class="cec-cfg-nav-item"
            :class="{ 'cec-cfg-nav-item--active': cfgSection === 'logs' }"
            @click="cfgSection = 'logs'"
          >
            日志配置
          </button>
          <button
            type="button"
            class="cec-cfg-nav-item"
            :class="{ 'cec-cfg-nav-item--active': cfgSection === 'import' }"
            @click="cfgSection = 'import'"
          >
            基础信息导入
          </button>
        </nav>
        <div class="min-w-0 flex-1">
          <div v-show="cfgSection === 'http'" class="space-y-3">
            <p class="text-xs leading-relaxed text-[var(--um-text-muted)]">
              服务启动不依赖协议内容。POST 到 <code class="rounded bg-[var(--um-surface-2)] px-1 py-0.5 text-[11px]">/api/</code>
              下任意深度路径时，取<strong>最后两段</strong>作为对接码与接口名（支持驼峰，例如
              <code class="rounded bg-[var(--um-surface-2)] px-1">notificationStatus</code>）。
            </p>
            <el-form label-width="112px" size="small">
              <el-form-item label="端口">
                <el-input-number v-model="snapshot.settings.httpPort" :min="1024" :max="65535" />
              </el-form-item>
              <el-form-item label="绑定地址">
                <el-input v-model="snapshot.settings.bindHost" placeholder="0.0.0.0" />
              </el-form-item>
            </el-form>
          </div>
          <div v-show="cfgSection === 'logs'">
            <el-form label-width="112px" size="small">
              <el-form-item label="日志条数上限">
                <el-input-number v-model="snapshot.settings.logMaxEntries" :min="100" :max="50000" />
              </el-form-item>
            </el-form>
          </div>
          <div v-show="cfgSection === 'import'">
            <p class="mb-3 text-xs text-[var(--um-text-muted)]">
              导入协议映射 JSON（用于接口路径、字段等元数据；HTTP 验签与路由不依赖此处）。
            </p>
            <input type="file" accept="application/json" @change="onImportProtocol" />
            <div class="mt-4">
              <div class="mb-2 text-xs font-medium text-[var(--um-text-muted)]">已导入协议列表</div>
              <el-table :data="snapshot.protocols" size="small" border max-height="260">
                <el-table-column label="协议名称" min-width="160">
                  <template #default="{ row }">
                    {{ row.protocolName || row.protocolId }}
                  </template>
                </el-table-column>
                <el-table-column label="导入时间" min-width="160">
                  <template #default="{ row }">
                    {{ formatProtocolImportedAt(row.importedAt) }}
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="120" align="center">
                  <template #default="{ row }">
                    <el-button link type="primary" size="small" @click="exportProtocolMappingJson(row)">
                      导出 JSON
                    </el-button>
                    <el-button link type="danger" size="small" @click="removeProtocolRow(row)">
                      删除
                    </el-button>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </div>
        </div>
      </div>
    </el-dialog>

    <el-dialog v-model="linkDialog" :title="editingLink?.id ? '编辑配置' : '新增配置'" width="640px">
      <el-form v-if="editingLink" label-width="120px" size="small">
        <el-divider content-position="left">基本信息</el-divider>
        <el-form-item label="对接名称">
          <el-input v-model="editingLink.name" />
        </el-form-item>
        <el-form-item label="对接唯一码">
          <el-input v-model="editingLink.linkUuid" readonly />
        </el-form-item>
        <el-form-item label="协议">
          <el-select v-model="editingLink.protocolId" teleported popper-class="cec-dialog-select-popper">
            <el-option v-for="p in snapshot.protocols" :key="p.protocolId" :label="p.protocolName" :value="p.protocolId" />
          </el-select>
        </el-form-item>
        <el-divider content-position="left">本地配置</el-divider>
        <el-form-item label="平台编码">
          <el-input v-model="editingLink.local.operatorId" />
        </el-form-item>
        <el-form-item label="请求地址">
          <el-input v-model="editingLink.local.requestBaseUrl" />
        </el-form-item>
        <el-form-item label="OperatorSecret">
          <el-input v-model="editingLink.local.operatorSecret" type="text" autocomplete="off" />
        </el-form-item>
        <el-form-item label="SigSecret">
          <el-input v-model="editingLink.local.sigSecret" type="text" autocomplete="off" />
        </el-form-item>
        <el-form-item label="DataSecret">
          <el-input v-model="editingLink.local.dataSecret" type="text" autocomplete="off" />
        </el-form-item>
        <el-form-item label="DataSecretIV">
          <el-input v-model="editingLink.local.dataSecretIV" type="text" autocomplete="off" />
        </el-form-item>
        <el-divider content-position="left">三方配置</el-divider>
        <el-form-item label="平台编码">
          <el-input v-model="editingLink.thirdParty.operatorId" />
        </el-form-item>
        <el-form-item label="互联互通地址">
          <el-input
            v-model="editingLink.thirdParty.interconnectionUrl"
            placeholder="https://第三方平台根地址"
          />
          <p class="mt-1 text-xs leading-snug text-[var(--um-text-muted)]">
            数据推送到第三方、站点拉取等对外调用均优先使用此根地址；扫码枪号归属到本对接后，相关调用按该第三方精确路由。
          </p>
        </el-form-item>
        <el-form-item label="OperatorSecret">
          <el-input v-model="editingLink.thirdParty.operatorSecret" type="text" autocomplete="off" />
        </el-form-item>
        <el-form-item label="SigSecret">
          <el-input v-model="editingLink.thirdParty.sigSecret" type="text" autocomplete="off" />
        </el-form-item>
        <el-form-item label="DataSecret">
          <el-input v-model="editingLink.thirdParty.dataSecret" type="text" autocomplete="off" />
        </el-form-item>
        <el-form-item label="DataSecretIV">
          <el-input v-model="editingLink.thirdParty.dataSecretIV" type="text" autocomplete="off" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="linkDialog = false">取消</el-button>
        <el-button v-if="editingLink" @click="exportLinkConfigJson(editingLink)">导出 JSON</el-button>
        <el-button type="primary" @click="saveLink">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="tokenDialogOpen"
      :title="tokenDialogLink ? `Token · ${tokenDialogLink.name}` : 'Token'"
      width="560px"
      destroy-on-close
    >
      <div v-if="tokenDialogLink" class="space-y-4">
        <button
          type="button"
          class="cec-token-card w-full rounded border border-[var(--um-border)] bg-[var(--um-surface-2)] p-3 text-left transition-colors hover:border-[var(--el-color-primary-light-5)]"
          @click="clearInboundTokenInDialog()"
        >
          <div class="mb-2 flex items-center justify-between gap-2">
            <span class="text-sm font-medium text-[var(--um-text)]">内部 Token</span>
            <span
              class="text-xs"
              :class="
                tokenEntryPresence(tokenDialogInbound) === 'valid'
                  ? 'text-[oklch(0.65_0.12_140)]'
                  : tokenEntryPresence(tokenDialogInbound) === 'expired'
                    ? 'text-amber-500'
                    : 'text-[var(--um-text-muted)]'
              "
            >
              {{ tokenPresenceLabel(tokenEntryPresence(tokenDialogInbound)) }}
            </span>
          </div>
          <p class="mb-1 text-xs text-[var(--um-text-muted)]">本机 HTTP 签发给对端调用时的 Bearer token（query_token 应答）</p>
          <p class="break-all font-mono text-xs text-[var(--um-text)]">
            {{ tokenDialogInbound?.accessToken || '—' }}
          </p>
          <p v-if="tokenDialogInbound?.accessToken" class="mt-2 text-xs text-[var(--um-text-muted)]">
            过期时间：{{ formatTokenExpiresAt(tokenDialogInbound.expiresAtMs) }}
          </p>
          <p class="mt-2 text-[10px] text-[var(--um-text-muted)]">点击此区域可清除并使 token 失效</p>
        </button>

        <button
          type="button"
          class="cec-token-card w-full rounded border border-[var(--um-border)] bg-[var(--um-surface-2)] p-3 text-left transition-colors hover:border-[var(--el-color-primary-light-5)]"
          @click="clearThirdPartyTokenInDialog()"
        >
          <div class="mb-2 flex items-center justify-between gap-2">
            <span class="text-sm font-medium text-[var(--um-text)]">三方 Token</span>
            <span
              class="text-xs"
              :class="
                tokenEntryPresence(tokenDialogThirdParty) === 'valid'
                  ? 'text-[oklch(0.65_0.12_140)]'
                  : tokenEntryPresence(tokenDialogThirdParty) === 'expired'
                    ? 'text-amber-500'
                    : 'text-[var(--um-text-muted)]'
              "
            >
              {{ tokenPresenceLabel(tokenEntryPresence(tokenDialogThirdParty)) }}
            </span>
          </div>
          <p class="mb-1 text-xs text-[var(--um-text-muted)]">向外请求对端时缓存的 query_token AccessToken</p>
          <p class="break-all font-mono text-xs text-[var(--um-text)]">
            {{ tokenDialogThirdParty?.accessToken || '—' }}
          </p>
          <p v-if="tokenDialogThirdParty?.accessToken" class="mt-2 text-xs text-[var(--um-text-muted)]">
            过期时间：{{ formatTokenExpiresAt(tokenDialogThirdParty.expiresAtMs) }}
          </p>
          <p class="mt-2 text-[10px] text-[var(--um-text-muted)]">点击此区域可清除并使 token 失效</p>
        </button>
      </div>
      <template #footer>
        <el-button @click="tokenDialogOpen = false">关闭</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="startConfirmDialogOpen" title="确认启动充电" width="420px" destroy-on-close>
      <el-descriptions :column="1" size="small" border>
        <el-descriptions-item label="方式">
          {{ phoneStartMode === 'scan' ? '扫码充电' : '设备号充电' }}
        </el-descriptions-item>
        <el-descriptions-item label="设备号（ConnectorID）">
          <span class="break-all">{{ startConfirmConnectorPreview }}</span>
        </el-descriptions-item>
        <el-descriptions-item v-if="phoneStartMode === 'scan'" label="二维码原文">
          <span class="break-all">{{ pendingQrText?.trim() || '—' }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="金额（元）">{{ startConfirmMoneyLabel }}</el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="startConfirmDialogOpen = false">取消</el-button>
        <el-button type="primary" @click="confirmStartChargeFromDialog">启动</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="detailVisible" title="订单详情" width="800px" class="cec-order-detail-dialog">
      <div v-if="orderDetail" class="space-y-3">
        <el-tabs v-model="orderDetailTab">
          <el-tab-pane label="订单信息" name="info">
            <div class="cec-order-detail-tab-content">
              <el-descriptions :column="1" border size="small" class="cec-order-info-desc">
                <el-descriptions-item label="订单号">{{ orderDetail.startChargeSeq }}</el-descriptions-item>
                <el-descriptions-item label="枪">{{ orderDetail.connectorId }}</el-descriptions-item>
                <el-descriptions-item label="状态">{{ stateLabel(orderDetail.productState) }}</el-descriptions-item>
                <el-descriptions-item label="开始时间">{{ orderDetail.orderInfo?.startTime || '—' }}</el-descriptions-item>
                <el-descriptions-item label="结束时间">{{ orderDetail.orderInfo?.endTime || '—' }}</el-descriptions-item>
                <el-descriptions-item label="累计充电量(度)">
                  {{
                    Number(orderDetail.orderInfo?.totalPower ?? 0).toFixed(2)
                  }}
                </el-descriptions-item>
                <el-descriptions-item label="总电费(元)">
                  {{
                    Number(orderDetail.orderInfo?.totalElecMoney ?? 0).toFixed(2)
                  }}
                </el-descriptions-item>
                <el-descriptions-item label="总服务费(元)">
                  {{
                    Number(orderDetail.orderInfo?.totalSeviceMoney ?? 0).toFixed(2)
                  }}
                </el-descriptions-item>
                <el-descriptions-item label="累计总金额(元)">
                  {{
                    Number(orderDetail.orderInfo?.totalMoney ?? 0).toFixed(2)
                  }}
                </el-descriptions-item>
                <el-descriptions-item label="停止原因">
                  {{ stopReasonLabel(orderDetail.orderInfo?.stopReason) }}
                </el-descriptions-item>
                <el-descriptions-item label="时段数N">
                  {{ orderDetail.orderInfo?.sumPeriod ?? '—' }}
                </el-descriptions-item>
              </el-descriptions>

              <div class="pt-1">
                <div class="mb-2 text-sm font-medium text-[var(--um-text)]">分时电量</div>
                <el-table
                  :data="orderChargeDetailRows(orderDetail)"
                  size="small"
                  border
                  max-height="260"
                  empty-text="暂无分时电量明细"
                >
                  <el-table-column prop="DetailStartTime" label="开始时间" min-width="150" />
                  <el-table-column prop="DetailEndTime" label="结束时间" min-width="150" />
                  <el-table-column label="电价" min-width="88">
                    <template #default="{ row }">{{
                      row.ElecPrice != null ? Number(row.ElecPrice).toFixed(4) : '—'
                    }}</template>
                  </el-table-column>
                  <el-table-column label="服务费价" min-width="96">
                    <template #default="{ row }">{{
                      row.SevicePrice != null ? Number(row.SevicePrice).toFixed(4) : '—'
                    }}</template>
                  </el-table-column>
                  <el-table-column label="电量(度)" min-width="90">
                    <template #default="{ row }">{{
                      row.DetailPower != null ? Number(row.DetailPower).toFixed(2) : '—'
                    }}</template>
                  </el-table-column>
                  <el-table-column label="电费(元)" min-width="90">
                    <template #default="{ row }">{{
                      row.DetailElecMoney != null ? Number(row.DetailElecMoney).toFixed(2) : '—'
                    }}</template>
                  </el-table-column>
                  <el-table-column label="服务费(元)" min-width="96">
                    <template #default="{ row }">{{
                      row.DetailSeviceMoney != null ? Number(row.DetailSeviceMoney).toFixed(2) : '—'
                    }}</template>
                  </el-table-column>
                </el-table>
              </div>
            </div>
          </el-tab-pane>
          <el-tab-pane label="过程数据" name="process">
            <div class="cec-order-detail-tab-content cec-process-content cec-scroll-unified">
              <div v-if="orderDetail" ref="chartRef" class="h-56 w-full" />
              <div v-if="orderDetail" ref="chartPowerRef" class="mt-2 h-56 w-full" />
              <el-table v-if="orderDetail" :data="processNotifyRows" size="small" class="mt-2 w-full">
                <el-table-column prop="idx" label="序号" width="56" />
                <el-table-column prop="t" label="时间" width="148">
                  <template #default="{ row }">{{ new Date(row.t).toLocaleString() }}</template>
                </el-table-column>
                <el-table-column label="功率(kW)" width="86">
                  <template #default="{ row }">{{ Number(row.powerKw ?? 0).toFixed(2) }}</template>
                </el-table-column>
                <el-table-column label="电量(度)" width="86">
                  <template #default="{ row }">{{ Number(row.totalPower ?? 0).toFixed(2) }}</template>
                </el-table-column>
                <el-table-column label="SOC(%)" width="78">
                  <template #default="{ row }">{{ Number(row.soc ?? 0).toFixed(2) }}</template>
                </el-table-column>
                <el-table-column label="分时电量" min-width="96">
                  <template #default="{ row }">
                    <el-popover trigger="click" placement="left" width="520">
                      <template #reference>
                        <el-button link type="primary" size="small">
                          查看（{{ row.chargeDetails?.length ?? 0 }}）
                        </el-button>
                      </template>
                      <el-form label-width="98px" size="small">
                        <el-form-item
                          v-for="(d, i) in row.chargeDetails"
                          :key="i"
                          :label="`时段${i + 1}`"
                        >
                          <el-descriptions :column="2" border size="small" class="w-full">
                            <el-descriptions-item label="开始时间">{{ chargeDetailObj(d).DetailStartTime ?? '—' }}</el-descriptions-item>
                            <el-descriptions-item label="结束时间">{{ chargeDetailObj(d).DetailEndTime ?? '—' }}</el-descriptions-item>
                            <el-descriptions-item label="电价">{{
                              chargeDetailObj(d).ElecPrice != null ? Number(chargeDetailObj(d).ElecPrice).toFixed(4) : '—'
                            }}</el-descriptions-item>
                            <el-descriptions-item label="服务费价">{{
                              chargeDetailObj(d).SevicePrice != null ? Number(chargeDetailObj(d).SevicePrice).toFixed(4) : '—'
                            }}</el-descriptions-item>
                            <el-descriptions-item label="分时电量">{{
                              chargeDetailObj(d).DetailPower != null ? Number(chargeDetailObj(d).DetailPower).toFixed(2) : '—'
                            }}</el-descriptions-item>
                            <el-descriptions-item label="分时电费">{{
                              chargeDetailObj(d).DetailElecMoney != null ? Number(chargeDetailObj(d).DetailElecMoney).toFixed(2) : '—'
                            }}</el-descriptions-item>
                            <el-descriptions-item label="分时服务费">{{
                              chargeDetailObj(d).DetailSeviceMoney != null ? Number(chargeDetailObj(d).DetailSeviceMoney).toFixed(2) : '—'
                            }}</el-descriptions-item>
                          </el-descriptions>
                        </el-form-item>
                      </el-form>
                    </el-popover>
                  </template>
                </el-table-column>
                <el-table-column label="报文" min-width="76">
                  <template #default="{ row }">
                    <el-popover trigger="click" placement="left" width="520">
                      <template #reference>
                        <el-button link type="primary" size="small">查看</el-button>
                      </template>
                      <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-all text-[11px]">{{
                        JSON.stringify(row.payload, null, 2)
                      }}</pre>
                    </el-popover>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-dialog>

    <Teleport to="body">
      <div
        v-if="httpGuideVisible"
        class="cec-http-guide-backdrop fixed inset-0 z-[9100] bg-[var(--um-text)]/[0.22]"
        role="presentation"
        aria-hidden="true"
        @click="dismissHttpGuide"
      />
      <div
        v-if="httpGuideVisible"
        class="cec-guide-sprite-fixed pointer-events-none fixed z-[9101] -translate-x-1/2"
        :style="{
          left: `${httpGuideAnchor.left}px`,
          top: `${httpGuideAnchor.top}px`,
          width: `${httpGuideWidth}px`,
          maxWidth: `calc(100vw - 32px)`,
        }"
        role="dialog"
        aria-labelledby="cec-http-guide-title"
      >
        <div
          class="cec-guide-sprite-card pointer-events-auto rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] p-3 shadow-lg"
          @click.stop
        >
          <div class="cec-guide-sprite-arrow" :style="{ left: `${httpGuideArrowLeft}px` }" aria-hidden="true" />
          <div class="flex gap-2.5">
            <div class="cec-guide-sprite-avatar" aria-hidden="true">
              <el-icon :size="22"><Lightning /></el-icon>
            </div>
            <div class="min-w-0 flex-1">
              <div id="cec-http-guide-title" class="text-sm font-semibold text-[var(--um-text)]">操作引导</div>
              <p class="mt-1 text-xs leading-relaxed text-[var(--um-text-muted)]">
                先点右侧
                <span class="whitespace-nowrap font-medium text-[var(--um-text)]">播放</span>
                按钮启动 HTTP 服务，成功后会自动进入「启动充电」。
              </p>
              <button
                type="button"
                class="cec-guide-sprite-dismiss mt-2.5 text-xs font-medium text-[var(--um-text-muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--um-text)]"
                @click="dismissHttpGuide"
              >
                知道了，我先不启动
              </button>
            </div>
          </div>
        </div>
      </div>
      <div
        v-if="pullOverlayActive"
        class="cec-pull-block-layer"
        role="alertdialog"
        aria-modal="true"
        :aria-busy="pullUiPhase === 'fetching'"
        aria-labelledby="cec-pull-blocking-title"
      >
        <div class="cec-pull-block-panel">
          <div id="cec-pull-blocking-title" class="cec-pull-block-title">正在拉取站点</div>
          <div class="cec-pull-progress-with-text">
            <el-progress
              class="cec-pull-progress"
              :indeterminate="pullAwaitingFirstPage && pullUiPhase === 'fetching'"
              :percentage="Math.min(100, pullFillPercent)"
              :stroke-width="10"
              :show-text="false"
            />
            <div
              class="cec-pull-pct-replace"
              :class="{
                'cec-pull-pct-replace--ok': pullUiPhase === 'result' && pullOutcomeOk,
                'cec-pull-pct-replace--err': pullUiPhase === 'result' && !pullOutcomeOk,
              }"
              :aria-label="
                pullUiPhase === 'result'
                  ? pullOutcomeOk
                    ? '拉取成功'
                    : '拉取失败'
                  : undefined
              "
              aria-live="polite"
            >
              <template v-if="pullUiPhase === 'fetching'">
                <span v-if="pullAwaitingFirstPage" class="cec-pull-pct-placeholder">…</span>
                <span v-else class="cec-pull-pct-num">{{ Math.round(pullFillPercent) }}%</span>
              </template>
              <template v-else>
                <span class="cec-pull-inline-icon-wrap" aria-hidden="true">
                  <el-icon v-if="pullOutcomeOk" :size="22" class="cec-pull-inline-icon">
                    <CircleCheck />
                  </el-icon>
                  <el-icon v-else :size="22" class="cec-pull-inline-icon">
                    <CircleClose />
                  </el-icon>
                </span>
              </template>
            </div>
          </div>
          <p class="cec-pull-block-hint">
            {{
              pullProgressHint ||
              '分页请求进行中，完成前请勿操作本插件页面'
            }}
          </p>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* HTTP 未启动 → 启动充电：操作引导精灵 */
.cec-guide-sprite-card {
  position: relative;
}

.cec-guide-sprite-arrow {
  position: absolute;
  left: 50%;
  top: 0;
  width: 10px;
  height: 10px;
  margin-left: -5px;
  margin-top: -5px;
  transform: rotate(45deg);
  background: var(--um-surface);
  border-left: 1px solid var(--um-border);
  border-top: 1px solid var(--um-border);
}

.cec-guide-sprite-avatar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: linear-gradient(145deg, oklch(0.72 0.14 250 / 0.35), oklch(0.62 0.12 200 / 0.2));
  color: var(--el-color-primary);
}

.cec-http-guide-pulse {
  animation: cec-http-guide-pulse 1.1s ease-in-out infinite;
  box-shadow: 0 0 0 0 oklch(0.55 0.12 250 / 0.45);
}

@keyframes cec-http-guide-pulse {
  0% {
    box-shadow: 0 0 0 0 oklch(0.55 0.12 250 / 0.45);
  }
  70% {
    box-shadow: 0 0 0 10px oklch(0.55 0.12 250 / 0);
  }
  100% {
    box-shadow: 0 0 0 0 oklch(0.55 0.12 250 / 0);
  }
}

/* 站点列表：可排序表头（双小三角，高亮为当前正/倒序） */
.cec-st-sort-th {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 0;
  max-width: 100%;
  border: none;
  background: transparent;
  font: inherit;
  font-weight: 600;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.cec-st-sort-th:hover {
  color: var(--el-color-primary);
}

.cec-st-sort-th--center {
  justify-content: center;
  width: 100%;
}

.cec-st-sort-tris {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  flex-shrink: 0;
  line-height: 0;
}

.cec-st-sort-tri {
  display: block;
  width: 0;
  height: 0;
  border-left: 3px solid transparent;
  border-right: 3px solid transparent;
  opacity: 0.38;
}

.cec-st-sort-tri--up {
  border-bottom: 4px solid var(--um-text-muted);
}

.cec-st-sort-tri--down {
  border-top: 4px solid var(--um-text-muted);
}

.cec-st-sort-tri.is-active {
  opacity: 1;
}

.cec-st-sort-tri--up.is-active {
  border-bottom-color: var(--el-color-primary);
}

.cec-st-sort-tri--down.is-active {
  border-top-color: var(--el-color-primary);
}

.cec-left-nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--um-border);
  padding-bottom: 10px;
}

.cec-left-nav-item {
  border-radius: var(--um-radius, 8px);
  border: 1px solid var(--um-border);
  background: var(--um-surface-2);
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 500;
  color: var(--um-text-muted);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease,
    border-color 0.15s ease;
}

.cec-left-nav-item:hover {
  color: var(--um-text);
  border-color: var(--um-brand-muted);
}

.cec-left-nav-item--active {
  color: var(--um-text);
  border-color: oklch(0.55 0.08 195 / 0.55);
  background: var(--um-surface);
  font-weight: 600;
}

.cec-left-nav-item--dropdown {
  display: inline-flex;
  align-items: center;
}

.cec-biz-panel {
  min-height: 200px;
}

/* 侧栏配置/日志：内容少时随内容增高，超出窗口可用高度时在列表区滚动 */
.cec-plugin-root {
  --cec-side-panel-max-height: calc(
    100dvh - var(--um-shell-content-top) - var(--um-shell-canvas-inset) - var(--um-workspace-inner-gap) -
      var(--space-lg) - 2.75rem
  );
  --cec-side-panel-scroll-max-height: calc(var(--cec-side-panel-max-height) - 5.5rem);
}

.cec-workspace {
  display: grid;
  flex: 1;
  min-height: 0;
  gap: var(--space-lg);
  grid-template-columns: minmax(320px, 390px) minmax(560px, 1fr) auto;
  align-items: start;
}

.cec-workspace > * {
  min-height: 0;
}

.cec-pane {
  min-width: 0;
}

.cec-center-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--um-border);
  padding-bottom: 10px;
}

.cec-center-nav-item {
  border-radius: var(--um-radius, 8px);
  border: 1px solid var(--um-border);
  background: var(--um-surface-2);
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 500;
  color: var(--um-text-muted);
  cursor: pointer;
}

.cec-center-nav-item--active {
  color: var(--um-text);
  border-color: oklch(0.55 0.08 195 / 0.55);
  background: var(--um-surface);
  font-weight: 600;
}

.cec-side-shell {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  min-height: 0;
  max-height: var(--cec-side-panel-max-height);
}

.cec-side-rail {
  display: flex;
  width: 64px;
  padding: 8px 6px;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
  align-self: flex-start;
}

.cec-side-btn {
  border: 1px solid var(--um-border);
  border-radius: 10px;
  background: var(--um-surface-2);
  color: var(--um-text-muted);
  width: 48px;
  height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;
}

.cec-side-btn--active {
  color: oklch(0.13 0.03 250);
  border-color: oklch(0.72 0.14 195 / 0.92);
  background: color-mix(in oklch, var(--um-brand) 74%, white 4%);
  box-shadow:
    0 0 0 1px oklch(0.78 0.14 195 / 0.55),
    0 8px 18px oklch(0.2 0.06 250 / 0.35);
}

.cec-side-panel {
  display: flex;
  flex-direction: column;
  width: min(420px, 28vw);
  min-width: 320px;
  height: auto;
  max-height: var(--cec-side-panel-max-height);
  overflow: hidden;
  transform-origin: right center;
  animation: cec-side-open 160ms ease-out;
}

.cec-side-panel-inner {
  display: flex;
  flex-direction: column;
}

.cec-side-panel-toolbar {
  flex-shrink: 0;
}

.cec-side-panel-scroll {
  min-height: 0;
  max-height: var(--cec-side-panel-scroll-max-height);
  overflow: auto;
}

.cec-process-content {
  max-height: calc(100vh - 180px);
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 2px;
}

.cec-order-detail-tab-content {
  width: min(100%, 800px);
  margin: 0 auto;
}

:deep(.cec-process-dialog .el-dialog__body) {
  padding-top: 10px;
}

:deep(.cec-order-detail-dialog .el-dialog) {
  width: 800px !important;
  max-width: 800px;
}

.cec-order-info-desc :deep(.el-descriptions__label.el-descriptions__cell.is-bordered-label) {
  white-space: nowrap;
  width: 1%;
}

@keyframes cec-side-open {
  from {
    opacity: 0;
    transform: translateX(8px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateX(0) scale(1);
  }
}

@media (max-width: 1400px) {
  .cec-workspace {
    grid-template-columns: minmax(300px, 360px) minmax(460px, 1fr) auto;
  }

  .cec-side-panel {
    width: min(380px, 32vw);
  }
}

@media (max-width: 1100px) {
  .cec-workspace {
    grid-template-columns: 1fr;
  }

  .cec-side-shell {
    display: block;
  }

  .cec-side-rail {
    width: 100%;
    flex-direction: row;
  }

  .cec-side-btn {
    width: 44px;
    height: 44px;
  }

  .cec-side-panel {
    width: 100%;
    min-width: 0;
    max-height: var(--cec-side-panel-max-height);
    margin-top: 8px;
  }
}

.cec-cfg-nav-item {
  width: 100%;
  border-radius: var(--um-radius, 8px);
  border: 1px solid transparent;
  background: transparent;
  padding: 8px 10px;
  text-align: left;
  font-size: 13px;
  color: var(--um-text-muted);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease,
    border-color 0.15s ease;
}

.cec-cfg-nav-item:hover {
  color: var(--um-text);
  background: var(--um-surface-2);
}

.cec-cfg-nav-item--active {
  color: var(--um-text);
  font-weight: 600;
  border-color: var(--um-border);
  background: var(--um-surface-2);
}

/* 手机模拟：与宿主 --um-* 令牌一致，独立成块避免影响其它 Tab */
.cec-phone-mock-stage {
  position: relative;
  width: 100%;
  max-width: 390px;
  min-width: 0;
  margin-left: auto;
  margin-right: auto;
  min-height: min(560px, 72vh);
  isolation: isolate;
  box-sizing: border-box;
}

.cec-phone-main-screen {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.cec-phone-body-content {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/** 过渡层：绝对定位填满内容区，避免切换时高度塌陷 */
.cec-phone-panel {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  width: 100%;
}

.cec-phone-panel--fixed {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 8px 12px 12px;
}

.cec-phone-panel-head {
  flex-shrink: 0;
}

.cec-phone-panel-list-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
  -webkit-overflow-scrolling: touch;
}

/* 手机模拟：左右滑入滑出（充电↔订单、进入/退出启动充电） */
.slide-left-enter-active,
.slide-left-leave-active,
.slide-right-enter-active,
.slide-right-leave-active {
  transition: transform 0.32s cubic-bezier(0.32, 0.72, 0, 1);
  will-change: transform;
}

.slide-left-enter-from {
  transform: translateX(100%);
}
.slide-left-leave-to {
  transform: translateX(-100%);
}

.slide-right-enter-from {
  transform: translateX(-100%);
}
.slide-right-leave-to {
  transform: translateX(100%);
}

/** 充电 Tab 内布局 */
.cec-phone-charge-stage {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.cec-phone-wrap {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  min-height: 420px;
}

.cec-phone {
  position: relative;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  border-radius: 2.25rem;
  padding: 10px;
  background: linear-gradient(
    145deg,
    oklch(0.22 0.03 250) 0%,
    oklch(0.14 0.04 250) 100%
  );
  box-shadow:
    0 24px 48px oklch(0.05 0.02 250 / 0.45),
    inset 0 1px 0 oklch(0.45 0.04 250 / 0.12);
}

.cec-phone-bezel {
  position: absolute;
  inset: 6px;
  border-radius: 1.9rem;
  border: 1px solid oklch(0.35 0.03 250 / 0.35);
  pointer-events: none;
}

.cec-phone-inner {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  height: min(520px, 70vh);
  border-radius: 1.75rem;
  overflow: hidden;
  background: var(--um-bg);
}

.cec-phone-start-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: -4px -12px 12px;
  padding: 4px 4px 10px;
  border-bottom: 1px solid var(--um-border);
}

.cec-phone-back-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 6px 8px;
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--um-brand, oklch(0.72 0.14 195));
  background: transparent;
  cursor: pointer;
  transition: background 0.15s ease;
  white-space: nowrap;
  flex-shrink: 0;
}

.cec-phone-back-btn:hover {
  background: oklch(0.35 0.06 195 / 0.25);
}

.cec-phone-back-icon {
  flex-shrink: 0;
}

.cec-phone-start-toolbar-title {
  flex: 1;
  min-width: 0;
  font-family: Lexend, ui-sans-serif, system-ui, sans-serif;
  font-size: 1.125rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--um-text);
  text-align: center;
  padding-right: 56px;
  white-space: nowrap;
}

.cec-phone-start-screen .cec-phone-start-mode {
  width: 100%;
}

.cec-phone-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 6px;
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--um-text-muted);
}

.cec-phone-time {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.cec-phone-notch {
  width: 88px;
  height: 6px;
  border-radius: 999px;
  background: oklch(0.28 0.02 250);
}

.cec-phone-icons {
  font-size: 9px;
  opacity: 0.75;
}

.cec-phone-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.cec-phone-scroll {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 8px 12px 12px;
  -webkit-overflow-scrolling: touch;
}

/* 内互联插件统一滚动条：与表格滚动条风格保持一致 */
.cec-scroll-unified,
.cec-side-panel-scroll,
.cec-phone-scroll,
.cec-phone-panel-list-scroll,
.cec-station-desc {
  scrollbar-width: thin;
  scrollbar-color: color-mix(in oklch, var(--um-border) 75%, var(--um-text-muted) 25%) transparent;
}

.cec-scroll-unified::-webkit-scrollbar,
.cec-side-panel-scroll::-webkit-scrollbar,
.cec-phone-scroll::-webkit-scrollbar,
.cec-phone-panel-list-scroll::-webkit-scrollbar,
.cec-station-desc::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.cec-scroll-unified::-webkit-scrollbar-track,
.cec-side-panel-scroll::-webkit-scrollbar-track,
.cec-phone-scroll::-webkit-scrollbar-track,
.cec-phone-panel-list-scroll::-webkit-scrollbar-track,
.cec-station-desc::-webkit-scrollbar-track {
  background: transparent;
}

.cec-scroll-unified::-webkit-scrollbar-thumb,
.cec-side-panel-scroll::-webkit-scrollbar-thumb,
.cec-phone-scroll::-webkit-scrollbar-thumb,
.cec-phone-panel-list-scroll::-webkit-scrollbar-thumb,
.cec-station-desc::-webkit-scrollbar-thumb {
  background: color-mix(in oklch, var(--um-border) 75%, var(--um-text-muted) 25%);
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: padding-box;
}

.cec-scroll-unified::-webkit-scrollbar-thumb:hover,
.cec-side-panel-scroll::-webkit-scrollbar-thumb:hover,
.cec-phone-scroll::-webkit-scrollbar-thumb:hover,
.cec-phone-panel-list-scroll::-webkit-scrollbar-thumb:hover,
.cec-station-desc::-webkit-scrollbar-thumb:hover {
  background: color-mix(in oklch, var(--um-text-muted) 55%, var(--um-border) 45%);
  background-clip: padding-box;
}

.cec-phone-title {
  font-family: Lexend, ui-sans-serif, system-ui, sans-serif;
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--um-text);
  white-space: nowrap;
}

.cec-phone-sub {
  margin-top: 4px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--um-text-muted);
  white-space: nowrap;
}

.cec-station-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cec-station-card {
  border-radius: 14px;
  padding: 12px 14px;
  background: var(--um-surface);
  border: 1px solid var(--um-border);
}

.cec-station-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--um-text);
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cec-station-price-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
  min-width: 0;
}

.cec-station-price {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 1;
  font-size: 11px;
  line-height: 1.4;
  color: var(--um-text-muted);
  font-variant-numeric: tabular-nums;
}

.cec-station-price > span {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cec-station-price-icon {
  flex-shrink: 0;
  color: oklch(0.62 0.12 85);
}

.cec-station-idle-inline {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
  color: oklch(0.72 0.12 145);
}

.cec-station-idle-icon {
  flex-shrink: 0;
  color: oklch(0.72 0.12 145);
}

.cec-phone-start-mode {
  display: flex;
  width: 100%;
}

.cec-phone-start-mode :deep(.el-radio-button) {
  flex: 1;
}

.cec-phone-start-mode :deep(.el-radio-button__inner) {
  width: 100%;
  white-space: nowrap;
}

.cec-station-meta {
  margin-top: 6px;
  font-size: 12px;
  color: var(--um-brand-muted);
}

.cec-station-addr {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--um-text-muted);
}

.cec-phone-empty {
  padding: 20px 8px;
  text-align: center;
  font-size: 13px;
  color: var(--um-text-muted);
  line-height: 1.5;
  white-space: normal;
}

.cec-phone-actions {
  margin-top: 16px;
}

.cec-btn-primary,
.cec-btn-secondary {
  border-radius: 14px;
  padding: 12px 14px;
  font-size: 14px;
  font-weight: 600;
  border: none;
  cursor: pointer;
  transition: filter 0.15s ease, transform 0.1s ease;
}

.cec-btn-primary {
  background: var(--um-brand);
  color: oklch(0.14 0.04 250);
}

.cec-btn-primary:hover {
  filter: brightness(1.08);
}

.cec-btn-secondary {
  background: var(--um-surface-2);
  color: var(--um-text);
  border: 1px solid var(--um-border);
}

.cec-btn-secondary:hover {
  border-color: var(--um-brand-muted);
}

.cec-phone-manual {
  margin-top: 14px;
}

.cec-phone-manual-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--um-text-muted);
  margin-bottom: 8px;
}

.cec-phone-manual-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.cec-phone-manual-input {
  flex: 1;
  min-width: 0;
  border-radius: 12px;
  border: 1px solid var(--um-border);
  background: var(--um-surface-2);
  color: var(--um-text);
  padding: 10px 12px;
  font-size: 14px;
  outline: none;
}

.cec-phone-manual-input::placeholder {
  color: var(--um-text-muted);
  opacity: 0.85;
}

.cec-phone-manual-input:focus {
  border-color: oklch(0.55 0.08 195 / 0.65);
}

.cec-btn-manual {
  flex-shrink: 0;
  padding-left: 16px;
  padding-right: 16px;
}

.cec-phone-manual-hint {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--um-text-muted);
}

.cec-live-card {
  margin-top: 18px;
  padding: 16px;
  border-radius: 16px;
  background: linear-gradient(
    160deg,
    oklch(0.24 0.04 250 / 0.9) 0%,
    oklch(0.18 0.05 250 / 0.95) 100%
  );
  border: 1px solid oklch(0.42 0.06 195 / 0.35);
}

.cec-live-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--um-text-muted);
  white-space: nowrap;
}

.cec-live-seq {
  margin-top: 8px;
  font-size: 12px;
  color: var(--um-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cec-live-metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 14px;
}

.cec-live-num {
  font-size: 1.65rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--um-brand);
  line-height: 1.1;
}

.cec-live-unit {
  margin-top: 4px;
  font-size: 11px;
  color: var(--um-text-muted);
  white-space: nowrap;
}

.cec-btn-stop {
  margin-top: 14px;
  width: 100%;
  border-radius: 12px;
  padding: 12px;
  font-size: 14px;
  font-weight: 600;
  border: none;
  cursor: pointer;
  background: oklch(0.55 0.12 55);
  color: oklch(0.98 0.01 250);
}

.cec-btn-stop:hover {
  filter: brightness(1.08);
}

.cec-order-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.cec-phone-order-search {
  margin-top: 10px;
  margin-bottom: 8px;
}

.cec-phone-order-search-input {
  width: 100%;
  height: 34px;
  border-radius: 10px;
  border: 1px solid var(--um-border);
  background: var(--um-surface-2);
  color: var(--um-text);
  padding: 0 10px;
  font-size: 12px;
  outline: none;
}

.cec-phone-order-search-input::placeholder {
  color: var(--um-text-muted);
}

.cec-phone-order-search-input:focus {
  border-color: oklch(0.55 0.08 195 / 0.65);
}

.cec-order-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 14px 12px;
  margin-bottom: 8px;
  border-radius: 14px;
  border: 1px solid var(--um-border);
  background: var(--um-surface);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
  flex-wrap: wrap;
  row-gap: 6px;
}

.cec-order-row:hover {
  border-color: var(--um-brand-muted);
}

.cec-order-row--active {
  border-color: var(--um-brand);
  background: oklch(0.28 0.06 195 / 0.35);
}

.cec-order-seq {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--um-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cec-order-state {
  flex-shrink: 0;
  margin-top: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--um-text);
  white-space: nowrap;
}

.cec-order-state--completed {
  color: oklch(0.72 0.14 145);
}

.cec-order-meta-grid {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 10px;
  font-size: 11px;
  color: var(--um-text-muted);
}

.cec-order-meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.cec-order-meta-item span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cec-phone-tabbar {
  position: relative;
  z-index: 12;
  display: flex;
  border-top: 1px solid var(--um-border);
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0));
  gap: 8px;
  background: var(--um-surface);
}

.cec-tabbar-btn {
  flex: 1;
  border-radius: 12px;
  padding: 10px;
  font-size: 13px;
  font-weight: 600;
  border: none;
  cursor: pointer;
  color: var(--um-text-muted);
  background: transparent;
  transition: color 0.15s ease, background 0.15s ease;
  white-space: nowrap;
}

.cec-tabbar-btn--on {
  color: var(--um-text);
  background: oklch(0.28 0.06 195 / 0.35);
}

.cec-station-detail-tabs :deep(.el-tabs__content) {
  padding-top: 8px;
}

.cec-station-desc :deep(.el-descriptions__label) {
  width: 128px;
}

/** 与「详细地址」等长文本一致：换行、断行，随 descriptions 正文字号与颜色 */
.cec-station-desc-value {
  display: block;
  white-space: pre-line;
  word-break: break-all;
}

.cec-pile-stat-card {
  flex: 1;
  min-width: 140px;
  max-width: 220px;
  padding: 14px 16px;
  border-radius: var(--um-radius, 8px);
  border: 1px solid var(--um-border);
  background: var(--um-surface-2);
  text-align: center;
}

.cec-pile-stat-num {
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  color: var(--um-text);
}

.cec-pile-stat-label {
  margin-top: 6px;
  font-size: 12px;
  color: var(--um-text-muted);
}

/* 拉取站点：全屏阻塞（Teleport 至 body，z-index 低于 ElMessage 以便成功提示在上层） */
.cec-pull-block-layer {
  position: fixed;
  inset: 0;
  z-index: 2999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: oklch(0.12 0.03 250 / 0.55);
  backdrop-filter: blur(3px);
  pointer-events: auto;
}

.cec-pull-block-panel {
  width: 100%;
  max-width: 380px;
  border-radius: var(--um-radius, 12px);
  border: 1px solid var(--um-border);
  background: var(--um-surface);
  padding: 22px 20px 18px;
  box-shadow: 0 24px 48px oklch(0.05 0.02 250 / 0.35);
}

.cec-pull-block-title {
  margin-bottom: 16px;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
  color: var(--um-text);
}

.cec-pull-block-hint {
  margin-top: 14px;
  text-align: center;
  font-size: 12px;
  line-height: 1.45;
  color: var(--um-text-muted);
}

.cec-pull-progress-with-text {
  display: flex;
  align-items: center;
  gap: 10px;
}

.cec-pull-progress-with-text .cec-pull-progress {
  flex: 1;
  min-width: 0;
}

.cec-pull-pct-replace {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 3.25rem;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--um-text-muted);
}

.cec-pull-pct-placeholder {
  letter-spacing: 0.08em;
}

.cec-pull-pct-num {
  color: var(--um-text);
}

.cec-pull-pct-replace--ok .cec-pull-inline-icon {
  color: var(--el-color-success);
}

.cec-pull-pct-replace--err .cec-pull-inline-icon {
  color: var(--el-color-error);
}

.cec-pull-inline-icon-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.cec-pull-inline-icon {
  animation: cec-pull-inline-pop 1s cubic-bezier(0.34, 1.45, 0.64, 1) both;
}

/* 进度由脚本平滑插值，避免与 CSS transition 叠加导致短间隔多次更新时不顺滑 */
.cec-pull-progress :deep(.el-progress-bar__inner) {
  transition: width 0.08s linear;
}

@keyframes cec-pull-inline-pop {
  0% {
    transform: scale(0.35);
    opacity: 0;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}
</style>
