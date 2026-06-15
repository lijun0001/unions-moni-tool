<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as echarts from 'echarts'
import QRCode from 'qrcode'
import { useJxProtocolStore } from './useJxProtocolStore'
import { useJxTopologyStore } from './useJxTopologyStore'
import { useJxRuntimeLogStore } from './useJxRuntimeLogStore'
import {
  executeFlow,
  ensureTcpEventListener,
  forceStopOrderCharging,
  forceCompleteOrder,
  isLiveChargingOrder,
  pushTeleSignalOnStateChange,
  resetJxPileSessionOnDisconnect,
  runVinAuthRemoteStart,
  runCardAuthRemoteStart,
  formatVinStartFailureMessage,
  JX_VIN_AUTH_DENIED_EVENT,
  setRemoteStartConfig,
  setScanQrVinStartConfig,
  setActiveListenFlow,
} from './protocol-executor'
import { getDisconnectBlockReason } from './disconnect-guard'
import { useJxOrderStore } from './useJxOrderStore'
import { usePluginWindowStore } from '@renderer/stores/pluginWindow'
import type { JxPileOrder } from './types'
import chargePileSvg from './assets/charge-pile.svg'
import carSvg from './assets/car.svg'
import JxBoardList from './JxBoardList.vue'
import JxRatePopover from './JxRatePopover.vue'
import {
  computeRowLayout,
  pileColumnWidth,
  splitPilesIntoRowsByWidth,
} from './jx-topology-layout'

const protocolStore = useJxProtocolStore()
const topologyStore = useJxTopologyStore()
const logStore = useJxRuntimeLogStore()
const orderStore = useJxOrderStore()
const pluginWindow = usePluginWindowStore()

const PLUGIN_ID = 'jx-pile-simulator'
const route = useRoute()

const drawerTab = ref<'basic' | 'control' | 'orders' | 'logs'>('basic')
const selectedFlowId = ref<string>('')
const importing = ref(false)
const executing = ref(false)
const loginExecuting = ref(false)
/** 拓扑「链接登录」进行中时标记桩号，用于该桩按钮波纹动效 */
const loginExecutingPileId = ref<string | null>(null)
const disconnecting = ref(false)
const logKeyword = ref('')
const logViewModeById = ref<Record<string, 'raw' | 'structured'>>({})
const qrDialogVisible = ref(false)
const qrDialogImgUrl = ref<string>('')
const qrDialogText = ref<string>('')
const qrDialogLoading = ref(false)
const qrDialogPileId = ref('')
const qrDialogGunId = ref('')
const qrDialogTab = ref<'scan' | 'vin' | 'card'>('scan')
/** 启动控制弹窗主面板：启动控制 / 充电信息 */
const qrDialogPanel = ref<'start' | 'charging'>('start')
/** 为 true 时面板切换使用左右滑动过渡 */
const qrDialogPanelSlide = ref(false)
/** 充电信息面板每秒刷新时长等实时字段 */
const chargingInfoClock = ref(Date.now())
let chargingInfoClockTimer: ReturnType<typeof setInterval> | null = null
const startControlVinDraft = ref('')
const startControlVinEditing = ref(false)
const vinAuthBusy = ref(false)
const cardAuthBusy = ref(false)
const startControlCardDraft = ref('')
const qrCache = new Map<string, string>()

const flowParams = ref<Record<string, string>>({
  gunNo: '00',
  orderNo: `ORD-${Date.now()}`,
  vin: 'LFPH3A1A0R1234567',
})

const loginConfig = ref({
  allowTimeoutCount: 3,
  heartbeatIntervalSec: 30,
  teleSignalPeriodSec: 15,
  telemetryPeriodSec: 15,
  workInfoPeriodSec: 15,
  /** 登录异常模拟：空为关闭 */
  abnormalSim: '' as '' | 'time_skew_large',
})

const remoteStartConfig = ref({
  startResult: 1 as 1 | 2,
  failReason: 0,
  chargeModelId: 'builtin-default',
  stopAmountThreshold: 0,
})

const scanQrVinStartConfig = ref({
  simulate5bFail: false,
  reply5bFailReason: 6,
})

const orderKeyword = ref('')

const filterProtocol = ref('')
const filterDeviceType = ref('')
const addDialogVisible = ref(false)
const addForm = ref({
  pileId: '',
  tcpHost: '127.0.0.1',
  tcpPort: 9001,
  pilePowerKw: 120,
  gunCount: 2,
  protocolId: '',
})
const vinEdit = ref({
  visible: false,
  pileId: '',
  gunId: '',
})
const vinForm = ref({
  pileId: '',
  gunId: '',
  vin: '',
})
const basicForm = ref({
  pileId: '',
  tcpHost: '127.0.0.1',
  tcpPort: 9000,
  pilePowerKw: 120,
  protocolId: '',
})
const basicEditing = ref(false)
const orderDetailVisible = ref(false)
const orderDetailTab = ref<'info' | 'process'>('info')
const orderDetailOrderNo = ref('')
const order25ChartRef = ref<HTMLDivElement | null>(null)
const order30ChartRef = ref<HTMLDivElement | null>(null)

const flowSupportMap = computed(() => {
  const m = new Map<string, { support: 'supported' | 'partial' | 'unsupported'; reason: string }>()
  const last = protocolStore.lastImportResult
  if (!last || !last.ok) return m
  for (const x of last.compatibilityReport) {
    const reason = [...x.missingCommands, ...x.missingParams, ...x.invalidDirections].join(', ')
    m.set(x.flowId, { support: x.support, reason })
  }
  return m
})

const activeFlow = computed(() =>
  protocolStore.activeProtocol?.flowTemplates.find((x) => x.flowId === selectedFlowId.value),
)

const isRemoteStartFlowSelected = computed(
  () => selectedFlowId.value === 'remote-start' || selectedFlowId.value === 'scan-qr-remote-start',
)
const isCardStartFlowSelected = computed(() => selectedFlowId.value === 'card-start')

/** 桩控制流程下拉中隐藏（流程定义与监听逻辑保留） */
const FLOW_IDS_HIDDEN_FROM_CONTROL_SELECT = new Set(['remote-start', 'remote-start-vin-auth'])

const selectableFlowTemplates = computed(() => {
  const flows = protocolStore.activeProtocol?.flowTemplates ?? []
  return flows.filter((f) => !FLOW_IDS_HIDDEN_FROM_CONTROL_SELECT.has(f.flowId))
})

function ensureSelectableFlowSelected() {
  const list = selectableFlowTemplates.value
  if (!list.length) return
  if (!selectedFlowId.value || FLOW_IDS_HIDDEN_FROM_CONTROL_SELECT.has(selectedFlowId.value)) {
    selectedFlowId.value = list[0].flowId
  }
}

function resolveLoginFlowForPile(pile: { protocolId: string } | null | undefined) {
  if (!pile) return null
  const pid = (pile.protocolId || protocolStore.activeProtocol.protocolId).trim()
  return protocolStore.getFlowTemplate(pid, 'login-auth')
}

const activePileLogs = computed(() => {
  if (!topologyStore.activePileId) return []
  return logStore.getLogsByPile(topologyStore.activePileId)
})
const visibleLogs = computed(() => {
  const q = logKeyword.value.trim().toLowerCase()
  if (!q) return activePileLogs.value
  return activePileLogs.value.filter((x) => {
    const content = `${x.command}|${x.direction}|${x.remoteIp}|${x.rawHex}|${JSON.stringify(x.structured ?? {})}`.toLowerCase()
    return content.includes(q)
  })
})

/** 当前「协议条件」仅用于筛选展示，不删改已持久化的桩列表 */
const pilesAfterProtocolFilter = computed(() => {
  const pid = (protocolStore.activeProtocolId || '').trim()
  const base = topologyStore.filteredPiles
  if (!pid) return base
  return base.filter((p) => p.protocolId === pid)
})

const pilesAfterType = computed(() => {
  const list = pilesAfterProtocolFilter.value
  if (!filterDeviceType.value) return list
  return list.filter((p) => (p.deviceKind ?? 'dc') === filterDeviceType.value)
})

const visiblePiles = computed(() => pilesAfterType.value)

const topologyBoardRef = ref<HTMLElement | null>(null)
const topologyContainerWidth = ref(0)
let topologyResizeObserver: ResizeObserver | null = null
let topologyWindowResizeHandler: (() => void) | null = null
let topologyWidthRetryRaf: number | null = null

const isPluginPaneVisible = computed(
  () => route.name === 'plugin' && String(route.params.pluginId ?? '').trim() === PLUGIN_ID,
)

function readTopologyContainerWidth(el: HTMLElement): number {
  const client = el.clientWidth
  if (client > 0) return client
  const rectW = el.getBoundingClientRect().width
  if (rectW > 0) return rectW
  const parentW = el.parentElement?.clientWidth ?? 0
  return parentW > 0 ? parentW : 0
}

/** 仅在测得有效宽度时更新，避免隐藏/未布局时写入 0 导致整行单排 */
function updateTopologyContainerWidth() {
  const el = topologyBoardRef.value
  if (!el) return
  const width = readTopologyContainerWidth(el)
  if (width > 0) {
    topologyContainerWidth.value = width
    return
  }
  if (topologyWidthRetryRaf != null) return
  topologyWidthRetryRaf = requestAnimationFrame(() => {
    topologyWidthRetryRaf = null
    const retryEl = topologyBoardRef.value
    if (!retryEl) return
    const retryWidth = readTopologyContainerWidth(retryEl)
    if (retryWidth > 0) topologyContainerWidth.value = retryWidth
  })
}

function unbindTopologyResizeObserver() {
  topologyResizeObserver?.disconnect()
  topologyResizeObserver = null
  if (topologyWindowResizeHandler) {
    window.removeEventListener('resize', topologyWindowResizeHandler)
    topologyWindowResizeHandler = null
  }
  if (topologyWidthRetryRaf != null) {
    cancelAnimationFrame(topologyWidthRetryRaf)
    topologyWidthRetryRaf = null
  }
}

function bindTopologyResizeObserver() {
  if (boardViewMode.value !== 'topology') return
  unbindTopologyResizeObserver()
  const el = topologyBoardRef.value
  if (!el) return
  updateTopologyContainerWidth()
  if (typeof ResizeObserver !== 'undefined') {
    topologyResizeObserver = new ResizeObserver(() => updateTopologyContainerWidth())
    topologyResizeObserver.observe(el)
  }
  topologyWindowResizeHandler = () => updateTopologyContainerWidth()
  window.addEventListener('resize', topologyWindowResizeHandler, { passive: true })
}

const topologyLayoutRows = computed(() => {
  const width = topologyContainerWidth.value
  const rowGroups = splitPilesIntoRowsByWidth(visiblePiles.value, width)
  const groups = rowGroups.length ? rowGroups : [[] as typeof visiblePiles.value]
  return groups.map((piles) => {
    const columnWidths = piles.map((p) => pileColumnWidth(p.guns.length))
    const layout = computeRowLayout(columnWidths, width)
    const rowStyle = layout.needsScroll
      ? { '--jx-row-gap': `${layout.gap}px`, width: `${layout.minWidth}px` }
      : { '--jx-row-gap': `${layout.gap}px`, width: '100%' }
    return { piles, layout, rowStyle }
  })
})

const hiddenPileCount = computed(() => 0)

type BoardViewMode = 'topology' | 'list'

const boardViewMode = ref<BoardViewMode>('topology')

function setBoardViewMode(mode: BoardViewMode) {
  if (mode === 'topology' && boardViewMode.value === 'list') {
    topologyStore.activePileId = null
  }
  boardViewMode.value = mode
  if (mode === 'topology') {
    nextTick(() => bindTopologyResizeObserver())
  } else {
    unbindTopologyResizeObserver()
  }
}

const VIN_POP_WIDTH = 230
const vinPopStyle = ref<Record<string, string>>({})

function updateVinPopPosition() {
  if (!vinEdit.value.visible || boardViewMode.value !== 'topology') return
  const anchorId = `${vinEdit.value.pileId}-${vinEdit.value.gunId}`
  const el = document.querySelector(`[data-vin-anchor="${anchorId}"]`)
  if (!el) return
  const rect = el.getBoundingClientRect()
  const half = VIN_POP_WIDTH / 2
  const margin = 8
  const centerX = Math.min(
    Math.max(rect.left + rect.width / 2, half + margin),
    window.innerWidth - half - margin,
  )
  vinPopStyle.value = {
    top: `${rect.bottom + 8}px`,
    left: `${centerX}px`,
  }
}

let vinPopScrollTarget: HTMLElement | null = null

function bindVinPopScrollListener() {
  unbindVinPopScrollListener()
  const el = topologyBoardRef.value
  if (!el) return
  vinPopScrollTarget = el
  el.addEventListener('scroll', updateVinPopPosition, { passive: true })
  window.addEventListener('resize', updateVinPopPosition, { passive: true })
}

function unbindVinPopScrollListener() {
  if (vinPopScrollTarget) {
    vinPopScrollTarget.removeEventListener('scroll', updateVinPopPosition)
    vinPopScrollTarget = null
  }
  window.removeEventListener('resize', updateVinPopPosition)
}

watch(
  () => vinEdit.value.visible,
  (visible) => {
    if (visible && boardViewMode.value === 'topology') {
      nextTick(() => {
        updateVinPopPosition()
        bindVinPopScrollListener()
      })
    } else {
      unbindVinPopScrollListener()
    }
  },
)
/** 侧栏仅拓扑模式展示；列表模式在右侧详区操作，选中桩不弹框 */
const drawerVisible = computed(() => boardViewMode.value === 'topology' && !!topologyStore.activePile)
const drawerLeftStyle = computed(() => {
  const idx = visiblePiles.value.findIndex((x) => x.pileId === topologyStore.activePileId)
  const total = visiblePiles.value.length
  const ratio = idx < 0 || total <= 1 ? 50 : (idx / (total - 1)) * 100
  return `clamp(12px, ${ratio}%, calc(100% - min(560px, 94vw) - 12px))`
})
const protocolLabel = computed(
  () => `${protocolStore.activeProtocol.protocolName} (${protocolStore.activeProtocol.version})`,
)
const nowTick = ref(Date.now())
let nowTickTimer: ReturnType<typeof setInterval> | null = null

const activeTariffPeriods = computed(() => topologyStore.activePile?.tariffModel?.periods ?? [])
const activePileOnline = computed(() => topologyStore.activePile?.onlineState === 'online')
const activePileOrders = computed(() => {
  const pileId = topologyStore.activePileId
  if (!pileId) return []
  const list = orderStore.getByPile(pileId)
  const q = orderKeyword.value.trim().toLowerCase()
  if (!q) return list
  return list.filter((x) => x.orderNo.toLowerCase().includes(q))
})
const currentOrderDetail = computed(() => {
  const pileId = topologyStore.activePileId
  if (!pileId || !orderDetailOrderNo.value) return null
  return orderStore.getByPile(pileId).find((x) => x.orderNo === orderDetailOrderNo.value) ?? null
})
const currentOrder23Segments = computed(() => {
  const segs = currentOrderDetail.value?.latest23?.segments ?? []
  return segs.filter((x) => x.energyKwh > 0)
})

/** 订单详情「时段电量」：优先分段电量表；充电中末段仅更新结束时间，已结束段保留 */
const orderPeriodEnergyDisplayRows = computed(() => {
  const o = currentOrderDetail.value
  if (!o) return []
  const table = o.periodEnergySegments
  if (table?.length) {
    return table.map((seg) => ({
      modelIndex: seg.modelIndex,
      energyKwh: seg.energyKwh,
      startTime: seg.startTime,
      endTime: seg.endTime,
      electricFeeYuan: seg.electricFeeYuan,
      serviceFeeYuan: seg.serviceFeeYuan,
    }))
  }
  const live = o.latest25?.segments
  if (live?.length) {
    return live.map((seg) => ({
      modelIndex: seg.modelIndex,
      energyKwh: seg.energyKwh,
      startTime: seg.startTime,
      endTime: seg.endTime,
      electricFeeYuan: seg.electricFeeYuan,
      serviceFeeYuan: seg.serviceFeeYuan,
    }))
  }
  return currentOrder23Segments.value.map((seg) => ({
    modelIndex: seg.modelIndex,
    energyKwh: seg.energyKwh,
    startTime: '',
    endTime: '',
    electricFeeYuan: null as number | null,
    serviceFeeYuan: null as number | null,
  }))
})
const pileGunStatusSignature = computed(() =>
  topologyStore.piles
    .map((p) => `${p.pileId}:${p.guns.map((g) => `${g.gunId}-${g.status}`).join(',')}`)
    .join('|'),
)

function closeDrawer() {
  topologyStore.activePileId = null
}

function notifyVinStartFailure(message: string) {
  const text = formatVinStartFailureMessage(message)
  ElMessage.error({ message: text, duration: 6000, showClose: true })
}

function onVinAuthDeniedEvent(ev: Event) {
  const detail = (ev as CustomEvent<{ pileId?: string; gunId?: string; message?: string }>).detail
  const message = String(detail?.message ?? '').trim()
  if (message) notifyVinStartFailure(message)
}

onMounted(() => {
  filterProtocol.value = protocolStore.activeProtocolId
  ensureSelectableFlowSelected()
  window.addEventListener(JX_VIN_AUTH_DENIED_EVENT, onVinAuthDeniedEvent as EventListener)
  nowTickTimer = setInterval(() => {
    nowTick.value = Date.now()
  }, 30_000)
  nextTick(() => bindTopologyResizeObserver())
})

onActivated(() => {
  nextTick(() => bindTopologyResizeObserver())
})

onDeactivated(() => {
  unbindTopologyResizeObserver()
})

watch(isPluginPaneVisible, (visible) => {
  if (visible && boardViewMode.value === 'topology') {
    nextTick(() => bindTopologyResizeObserver())
  }
})

watch(topologyBoardRef, (el) => {
  if (el && boardViewMode.value === 'topology') {
    nextTick(() => bindTopologyResizeObserver())
  }
})

onBeforeUnmount(() => {
  window.removeEventListener(JX_VIN_AUTH_DENIED_EVENT, onVinAuthDeniedEvent as EventListener)
  unbindVinPopScrollListener()
  unbindTopologyResizeObserver()
  stopChargingInfoClock()
  // 切换路由时插件仍保留在窗口缓存中，不断开 TCP；仅菜单关闭或应用退出时清理
  if (pluginWindow.isOpen(PLUGIN_ID)) return
  for (const pile of topologyStore.piles) {
    void window.unions.jxTcpInvoke('disconnect', { pileId: pile.pileId })
  }
  if (nowTickTimer) {
    clearInterval(nowTickTimer)
    nowTickTimer = null
  }
})

async function ensureConnectedBeforeSend(): Promise<boolean> {
  const activePile = topologyStore.activePile
  if (!activePile) {
    ElMessage.warning('请先选择桩')
    return false
  }
  const status = (await window.unions.jxTcpInvoke('status', { pileId: activePile.pileId })) as {
    ok?: boolean
    connected?: boolean
  }
  if (status.ok === true && status.connected) return true

  try {
    await ElMessageBox.confirm('设备断开链接，是否重新链接？', '提示', {
      type: 'warning',
      confirmButtonText: '重新链接',
      cancelButtonText: '取消',
    })
  } catch {
    return false
  }

  await runLoginFlow()
  const retryStatus = (await window.unions.jxTcpInvoke('status', { pileId: activePile.pileId })) as {
    ok?: boolean
    connected?: boolean
  }
  return retryStatus.ok === true && retryStatus.connected === true
}

watch(
  () => protocolStore.activeProtocolId,
  (id) => {
    if (id && filterProtocol.value !== id) filterProtocol.value = id
    if (!id) return
    const cur = topologyStore.activePile
    if (cur && cur.protocolId !== id) {
      topologyStore.activePileId = null
    }
  },
)

watch(filterProtocol, (id) => {
  if (id) protocolStore.setActiveProtocol(id)
  if (id && !protocolStore.isJxProtocolSelectable(id)) {
    filterProtocol.value = protocolStore.activeProtocolId
  }
})

watch(
  () => topologyStore.activePile,
  (pile) => {
    if (!pile) return
    loginConfig.value.allowTimeoutCount = pile.allowTimeoutCount
    loginConfig.value.heartbeatIntervalSec = pile.heartbeatIntervalSec
    basicForm.value = {
      pileId: pile.pileId,
      tcpHost: pile.tcpHost ?? '127.0.0.1',
      tcpPort: pile.tcpPort ?? 9000,
      pilePowerKw: pile.pilePowerKw ?? 120,
      protocolId: pile.protocolId,
    }
    setRemoteStartConfig(pile.pileId, remoteStartConfig.value)
    setScanQrVinStartConfig(pile.pileId, scanQrVinStartConfig.value)
  },
  { immediate: true },
)

watch(
  remoteStartConfig,
  (cfg) => {
    if (cfg.startResult === 1) cfg.failReason = 0
    if (!topologyStore.activePileId) return
    setRemoteStartConfig(topologyStore.activePileId, cfg)
  },
  { deep: true },
)

watch(
  scanQrVinStartConfig,
  (cfg) => {
    if (!topologyStore.activePileId) return
    setScanQrVinStartConfig(topologyStore.activePileId, cfg)
  },
  { deep: true },
)

watch(
  [selectedFlowId, () => topologyStore.activePileId],
  ([flowId, pileId]) => {
    if (!pileId) return
    setActiveListenFlow(pileId, flowId || null)
  },
  { immediate: true },
)

watch(
  () => protocolStore.activeProtocolId,
  () => {
    ensureSelectableFlowSelected()
  },
)

watch(
  pileGunStatusSignature,
  (next, prev) => {
    if (!prev) return
    const prevMap = new Map<string, string>()
    for (const seg of prev.split('|')) {
      const [pileId, guns] = seg.split(':')
      if (!pileId) continue
      prevMap.set(pileId, guns ?? '')
    }
    for (const seg of next.split('|')) {
      const [pileId, guns] = seg.split(':')
      if (!pileId) continue
      if ((prevMap.get(pileId) ?? '') !== (guns ?? '')) {
        pushTeleSignalOnStateChange(pileId)
      }
    }
  },
)

watch(
  () => [orderDetailVisible.value, orderDetailTab.value, orderDetailOrderNo.value, currentOrderDetail.value?.process25?.length, currentOrderDetail.value?.process30?.length],
  async () => {
    await nextTick()
    void renderOrderCharts()
  },
)

function saveBasicInfo() {
  const activePile = topologyStore.activePile
  if (!activePile) return
  if (activePile.onlineState !== 'offline') {
    ElMessage.warning('仅离线状态允许修改桩基本信息')
    return
  }
  const data = basicForm.value
  if (!data.pileId.trim()) {
    ElMessage.warning('请输入桩号')
    return
  }
  if (!data.tcpHost.trim()) {
    ElMessage.warning('请输入TCP链接地址')
    return
  }
  if (data.tcpPort <= 0 || data.tcpPort > 65535) {
    ElMessage.warning('端口范围应为1-65535')
    return
  }
  if (!data.protocolId) {
    ElMessage.warning('请选择协议')
    return
  }
  if (data.pilePowerKw <= 0 || data.pilePowerKw > 2000) {
    ElMessage.warning('桩功率范围应为1-2000kW')
    return
  }
  try {
    topologyStore.updatePileBasic(activePile.pileId, {
      pileId: data.pileId.trim(),
      tcpHost: data.tcpHost.trim(),
      tcpPort: data.tcpPort,
      pilePowerKw: data.pilePowerKw,
      protocolId: data.protocolId,
    })
    basicEditing.value = false
    ElMessage.success('桩基本信息已更新')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '更新失败')
  }
}

function toggleBasicEdit() {
  const activePile = topologyStore.activePile
  if (!activePile) return
  if (!basicEditing.value) {
    if (activePile.onlineState !== 'offline') {
      ElMessage.warning('仅离线状态允许修改桩基本信息')
      return
    }
    basicForm.value = {
      pileId: activePile.pileId,
      tcpHost: activePile.tcpHost ?? '127.0.0.1',
      tcpPort: activePile.tcpPort ?? 9000,
      pilePowerKw: activePile.pilePowerKw ?? 120,
      protocolId: activePile.protocolId,
    }
    basicEditing.value = true
    return
  }
  saveBasicInfo()
}

async function importProtocol() {
  importing.value = true
  try {
    const file = await window.unions.openJsonFileDialog()
    if (!file) return
    const res = await window.unions.readTextFile(file)
    if (!res.ok) {
      ElMessage.error(res.error ?? '读取协议文件失败')
      return
    }
    const parsed = protocolStore.importFromJsonText({
      jsonText: res.content,
      onConflict: 'reject',
      dryRun: false,
    })
    if (!parsed.ok) {
      ElMessage.error(`${parsed.errorCode}: ${parsed.message}`)
      return
    }
    if (parsed.warnings.length) ElMessage.warning(parsed.warnings[0])
    else ElMessage.success(`导入成功：${parsed.protocolId}`)
    if (parsed.ok && parsed.protocol) filterProtocol.value = parsed.protocol.protocolId
  } finally {
    importing.value = false
  }
}

async function exportProtocol() {
  const json = protocolStore.exportActiveProtocol()
  const name = `${protocolStore.activeProtocol.protocolId}.json`
  const res = await window.unions.saveTextFile({ defaultFilename: name, content: json })
  if (res.ok) ElMessage.success(`已导出：${res.path}`)
  else ElMessage.error(res.error ?? '导出失败')
}

function onProtocolMenuCommand(command: 'import' | 'export') {
  if (command === 'import') void importProtocol()
  else void exportProtocol()
}

async function runFlow() {
  if (!activeFlow.value || !topologyStore.activePileId) return
  if (activeFlow.value.flowId !== 'login-auth') {
    const connected = await ensureConnectedBeforeSend()
    if (!connected) return
  }
  const support = flowSupportMap.value.get(activeFlow.value.flowId)?.support ?? 'supported'
  if (support === 'unsupported') {
    ElMessage.error('该流程不可执行（核心命令缺失或方向不一致）')
    return
  }
  executing.value = true
  try {
    const ret = await executeFlow({
      pileId: topologyStore.activePileId,
      flow: activeFlow.value,
      protocolId: protocolStore.activeProtocol.protocolId,
      params: flowParams.value,
    })
    if (!ret.ok) ElMessage.error(ret.error ?? '执行失败')
    else ElMessage.success('流程执行完成')
  } finally {
    executing.value = false
  }
}

async function onControlPanelLoginClick() {
  const pileId = topologyStore.activePileId?.trim()
  if (!pileId) {
    ElMessage.warning('请先选择桩')
    return
  }
  await runLoginFlow(pileId)
}

async function runLoginFlow(targetPileId?: string) {
  ensureTcpEventListener()
  const pileId =
    (typeof targetPileId === 'string' && targetPileId.trim()) || topologyStore.activePileId?.trim() || ''
  const activePile = pileId ? topologyStore.piles.find((x) => x.pileId === pileId) : topologyStore.activePile
  if (!activePile) {
    ElMessage.warning('请先选择桩')
    return
  }
  await window.unions.jxTcpInvoke('cancelPending', { pileId: activePile.pileId })
  loginConfig.value.allowTimeoutCount = activePile.allowTimeoutCount
  loginConfig.value.heartbeatIntervalSec = activePile.heartbeatIntervalSec
  const loginFlow = resolveLoginFlowForPile(activePile)
  if (!loginFlow) {
    ElMessage.warning('当前协议未配置登录认证流程')
    return
  }
  loginExecuting.value = true
  loginExecutingPileId.value = activePile.pileId
  try {
    topologyStore.applyStatePatch(activePile.pileId, {
      allowTimeoutCount: loginConfig.value.allowTimeoutCount,
      heartbeatIntervalSec: loginConfig.value.heartbeatIntervalSec,
    })
    const ret = await executeFlow({
      pileId: activePile.pileId,
      flow: loginFlow,
      protocolId: activePile.protocolId,
      params: {
        ...flowParams.value,
        tcpHost: activePile.tcpHost,
        tcpPort: activePile.tcpPort,
        allowTimeoutCount: loginConfig.value.allowTimeoutCount,
        heartbeatIntervalSec: loginConfig.value.heartbeatIntervalSec,
        teleSignalPeriodSec: loginConfig.value.teleSignalPeriodSec,
        telemetryPeriodSec: loginConfig.value.telemetryPeriodSec,
        workInfoPeriodSec: loginConfig.value.workInfoPeriodSec,
        ...(loginConfig.value.abnormalSim === 'time_skew_large'
          ? { loginAbnormalSim: 'time_skew_large' as const }
          : {}),
      },
    })
    if (!ret.ok) ElMessage.error(ret.error ?? '登录失败')
    else {
      for (const g of activePile.guns) {
        topologyStore.applyStatePatch(activePile.pileId, {
          gunPatch: {
            gunId: g.gunId,
            status: g.status === 'linked' ? 'linked' : 'idle',
          },
        })
      }
      pushTeleSignalOnStateChange(activePile.pileId)
      ElMessage.success('登录认证流程完成')
    }
  } finally {
    loginExecuting.value = false
    loginExecutingPileId.value = null
  }
}

async function runLoginFlowByPile(pileId: string) {
  const pile = topologyStore.piles.find((x) => x.pileId === pileId)
  if (!pile || pile.onlineState !== 'offline') return
  await runLoginFlow(pileId)
}

/** 拓扑区「断链」小圆标：离线时可点击发起登录（不切换选中桩，避免弹出侧栏） */
async function onPileLinkIndicatorClick(pileId: string) {
  if (loginExecuting.value) return
  await runLoginFlowByPile(pileId)
}

async function disconnectPileById(pileId: string) {
  const pile = topologyStore.piles.find((x) => x.pileId === pileId)
  if (!pile) return
  const blockReason = getDisconnectBlockReason(pile.onlineState, disconnecting.value)
  if (blockReason) {
    ElMessage.info(blockReason)
    return
  }
  disconnecting.value = true
  try {
    const ret = (await window.unions.jxTcpInvoke('disconnect', { pileId: pile.pileId })) as {
      ok?: boolean
      error?: string
    }
    if (ret.ok === true) {
      resetJxPileSessionOnDisconnect(pile.pileId)
      logStore.appendLog(pile.pileId, {
        t: Date.now(),
        pileId: pile.pileId,
        command: 'TCP',
        direction: 'send',
        remoteIp: `${pile.tcpHost ?? '127.0.0.1'}:${pile.tcpPort ?? 9000}`,
        rawHex: '',
        structured: { type: 'manual-disconnect', detail: '用户手动断开连接' },
      })
      ElMessage.success('连接已断开')
      return
    }
    ElMessage.error(ret.error ?? '断开失败')
  } finally {
    disconnecting.value = false
  }
}

async function disconnectActivePile() {
  const activePile = topologyStore.activePile
  if (!activePile) {
    ElMessage.warning('请先选择桩')
    return
  }
  await disconnectPileById(activePile.pileId)
}

function statusPillLabel(state?: string): string {
  if (state === 'fault') return '故障'
  if (state === 'online') return '在线'
  return '离线'
}

function linkStateLabel(state?: string): string {
  return state === 'online' ? '已连接' : '断链'
}

function gunStatusLabel(state: string): string {
  if (state === 'linked') return '链接'
  if (state === 'occupied') return '占用'
  if (state === 'charging') return '充电中'
  if (state === 'fault') return '故障'
  return '空闲'
}

function gunStatusForPile(pileOnlineState: string | undefined, gunState: string): string {
  if (pileOnlineState !== 'online') return '-'
  return gunStatusLabel(gunState)
}

function gunSocLabel(soc?: number): string {
  if (typeof soc !== 'number') return '-'
  return `${soc}%`
}

function gunHudCharging(gun: { status: string }): boolean {
  return gun.status === 'charging'
}

/** 仅充电中展示实时 SOC/电量/金额；桩或枪结束充电后 HUD 归零 */
function gunHudShowsLiveCharging(pile: { status: string }, gun: { status: string }): boolean {
  return pile.status === 'charging' && gun.status === 'charging'
}

/** 充电过程优先用订单 `latestBms.soc`，与拓扑同步 */
function gunHudSocDisplay(
  pile: { status: string; pileId: string },
  gunId: string,
  gun: { status: string; soc?: number },
): string {
  if (!gunHudShowsLiveCharging(pile, gun)) return '-'
  const o = orderStore
    .listByPile(pile.pileId)
    .find((x) => x.gunId === gunId && ['charging', 'starting', 'start-accepted'].includes(x.status))
  const s = o?.latestBms?.soc
  if (typeof s === 'number' && Number.isFinite(s)) return `${Math.round(s)}%`
  if (typeof gun.soc === 'number') return `${gun.soc}%`
  return '-'
}

function gunHudEnergyLine(pile: { status: string; pileId: string }, gunId: string, gun: { status: string }): string {
  if (!gunHudShowsLiveCharging(pile, gun)) return '-'
  const o = orderStore.listByPile(pile.pileId).find((x) => x.gunId === gunId && x.status === 'charging')
  const kwh = o?.latest25?.chargeEnergyKwh
  if (typeof kwh === 'number' && Number.isFinite(kwh)) return `${kwh.toFixed(2)}kWh`
  return '-'
}

function gunHudAmountLine(pile: { status: string; pileId: string }, gunId: string, gun: { status: string }): string {
  if (!gunHudShowsLiveCharging(pile, gun)) return '-'
  const o = orderStore.listByPile(pile.pileId).find((x) => x.gunId === gunId && x.status === 'charging')
  const y = o?.latest25?.chargeAmountYuan
  if (typeof y === 'number' && Number.isFinite(y)) return `${y.toFixed(2)}元`
  return '-'
}

function orderTariffTypeLabel(order: JxPileOrder): string {
  const src = order.tariffSnapshot?.source
  if (src === '0x1a-embedded') return '卡启动（报文内嵌费率）'
  if (src === '0x1a-local') return '卡启动（桩本地费率）'
  if (src === '0x41-vin-embedded') return 'VIN启动（报文内嵌费率）'
  if (src === '0x41-vin-local') return 'VIN启动（桩本地费率）'
  if (src === '0x1f-embedded') return '远端启动（报文内嵌费率）'
  if (src === 'pile-0x37') {
    if (order.startAuthSource === '0x1f-remote') return '远端启动（桩本地费率）'
    return '桩本地计费模型'
  }
  const billing = order.request23?.billingModelSelect1f ?? order.request23?.billingModelSelect
  if (billing === 2 && order.request23?.pendingEmbeddedTariff) return '报文内嵌费率（待启动生效）'
  if (order.status === 'charging' || order.status === 'stopped' || order.status === 'starting') {
    return '桩本地费率（待启动生效）'
  }
  if (billing === 1 || billing === undefined) return '桩本地费率（待启动生效）'
  return '-'
}

const orderTariffDialogVisible = ref(false)
const orderTariffViewOrderNo = ref('')

const orderTariffViewOrder = computed(() => {
  const pileId = topologyStore.activePileId
  if (!pileId || !orderTariffViewOrderNo.value) return null
  return orderStore.listByPile(pileId).find((x) => x.orderNo === orderTariffViewOrderNo.value) ?? null
})

const orderTariffViewSnapshot = computed(() => {
  const order = orderTariffViewOrder.value
  if (!order) return null
  if (order.tariffSnapshot) return order.tariffSnapshot
  const pending = order.request23?.pendingEmbeddedTariff
  if (!pending) return null
  const billing = order.request23?.billingModelSelect1f ?? order.request23?.billingModelSelect
  const source =
    billing === 2
      ? order.startAuthSource === '0x19-card'
        ? '0x1a-embedded'
        : order.startAuthSource === '0x40-vin' || order.startAuthSource === '0x59-scan-vin'
          ? '0x41-vin-embedded'
          : '0x1f-embedded'
      : 'pile-0x37'
  return {
    version: pending.version,
    parkingRate: pending.parkingRate,
    periods: pending.periods,
    source,
    updatedAt: pending.updatedAt,
  }
})

function orderTariffViewable(order: JxPileOrder): boolean {
  return !!(order.tariffSnapshot || order.request23?.pendingEmbeddedTariff)
}

function openOrderTariffView(orderNo: string) {
  orderTariffViewOrderNo.value = orderNo
  orderTariffDialogVisible.value = true
}

function gunLabel(pileId: string, gunId: string): string {
  const pile = topologyStore.piles.find((x) => x.pileId === pileId)
  const idx = pile?.guns.findIndex((g) => g.gunId === gunId) ?? -1
  if (idx < 0) return `${gunId}枪`
  return `${String.fromCharCode(65 + idx)}枪`
}

const startControlGunLabel = computed(() => {
  const p = qrDialogPileId.value
  const g = qrDialogGunId.value
  if (!p || !g) return '—'
  return gunLabel(p, g)
})

const qrDialogTitle = computed(() => (qrDialogPanel.value === 'charging' ? '充电信息' : '启动控制'))

const qrDialogPanelTransition = computed(() =>
  qrDialogPanelSlide.value ? 'jx-panel-slide-forward' : 'jx-panel-slide-instant',
)

const startControlChargingOrder = computed((): JxPileOrder | null => {
  const p = qrDialogPileId.value
  const g = qrDialogGunId.value
  if (!p || !g) return null
  return orderStore.listByPile(p).find((x) => x.gunId === g && x.status === 'charging') ?? null
})

function orderStartAuthMethodLabel(order: JxPileOrder | null | undefined): string {
  const src = order?.startAuthSource
  if (src === '0x19-card') return '卡启动'
  if (src === '0x59-scan-vin') return '扫码VIN启动'
  if (src === '0x40-vin') return 'VIN启动'
  if (src === '0x1f-remote') return '扫码启动'
  return '-'
}

function formatOrderTimestamp(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function parseProtocolTimeTagToMs(text?: string): number | null {
  const raw = String(text ?? '').trim()
  const m = raw.match(/^20(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/)
  if (!m) return null
  const yy = 2000 + Number.parseInt(m[1], 10)
  const mm = Number.parseInt(m[2], 10) - 1
  const dd = Number.parseInt(m[3], 10)
  const HH = Number.parseInt(m[4], 10)
  const MM = Number.parseInt(m[5], 10)
  const SS = Number.parseInt(m[6], 10)
  const t = new Date(yy, mm, dd, HH, MM, SS).getTime()
  return Number.isFinite(t) ? t : null
}

function formatChargeDurationSec(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}小时${m}分${sec}秒`
  if (m > 0) return `${m}分${sec}秒`
  return `${sec}秒`
}

function chargeSessionStartMs(order: JxPileOrder): number {
  const from23 = parseProtocolTimeTagToMs(order.latest23?.startTime)
  if (from23) return from23
  const p25 = order.process25?.[0]?.t
  if (typeof p25 === 'number' && Number.isFinite(p25)) return p25
  return order.startAt
}

const chargingInfoLive = computed(() => {
  void chargingInfoClock.value
  const order = startControlChargingOrder.value
  if (!order) {
    return {
      orderNo: '—',
      startMethod: '—',
      startTime: '—',
      vin: '—',
      isCardStart: false,
      cardNo: '—',
      durationText: '—',
      energyText: '—',
      balanceText: '—',
      powerText: '—',
    }
  }
  const pile = topologyStore.piles.find((x) => x.pileId === order.pileId)
  const gun = pile?.guns.find((x) => x.gunId === order.gunId)
  const vin =
    String(order.latest23?.vin ?? order.request23?.vin ?? gun?.vin ?? '').trim() || '—'
  const isCardStart = order.startAuthSource === '0x19-card'
  const cardNo = isCardStart
    ? String(order.request23?.userId ?? order.latest23?.userId ?? '').trim() || '—'
    : '—'
  const sessionStart = chargeSessionStartMs(order)
  const durationSec = Math.max(0, Math.floor((chargingInfoClock.value - sessionStart) / 1000))
  const energyKwh = order.latest25?.chargeEnergyKwh
  const energyText =
    typeof energyKwh === 'number' && Number.isFinite(energyKwh) ? `${energyKwh.toFixed(4)} kWh` : '—'
  const balanceYuan = order.latest25?.accountBalanceYuan
  const balanceFrom23 = order.latest23?.chargingCardBalance
  let balanceText = '—'
  if (typeof balanceYuan === 'number' && Number.isFinite(balanceYuan)) {
    balanceText = `${balanceYuan.toFixed(2)} 元`
  } else if (typeof balanceFrom23 === 'number' && Number.isFinite(balanceFrom23)) {
    balanceText = `${(balanceFrom23 / 100).toFixed(2)} 元`
  } else if (typeof order.request23?.chargingCardBalanceYuan === 'number') {
    balanceText = `${order.request23.chargingCardBalanceYuan.toFixed(2)} 元`
  }
  const last25 = order.process25?.at(-1)
  let powerText = '—'
  if (last25 && Number.isFinite(last25.voltage) && Number.isFinite(last25.current)) {
    const kw = (last25.voltage * last25.current) / 1000
    if (Number.isFinite(kw) && kw >= 0) powerText = `${kw.toFixed(2)} kW`
  }
  return {
    orderNo: order.orderNo.trim() || '—',
    startMethod: orderStartAuthMethodLabel(order),
    startTime: formatOrderTimestamp(order.startAt),
    vin,
    isCardStart,
    cardNo,
    durationText: formatChargeDurationSec(durationSec),
    energyText,
    balanceText,
    powerText,
  }
})

function syncQrDialogPanelForGun(pileId: string, gunId: string, animateToCharging = false) {
  const pile = topologyStore.piles.find((x) => x.pileId === pileId)
  const gun = pile?.guns.find((x) => x.gunId === gunId)
  if (!gun) return
  if (gun.status === 'charging') {
    if (qrDialogPanel.value !== 'charging') {
      if (animateToCharging) qrDialogPanelSlide.value = true
      qrDialogPanel.value = 'charging'
    }
  } else if (qrDialogPanel.value === 'charging') {
    qrDialogPanelSlide.value = false
    qrDialogPanel.value = 'start'
  }
}

function startChargingInfoClock() {
  if (chargingInfoClockTimer) return
  chargingInfoClock.value = Date.now()
  chargingInfoClockTimer = setInterval(() => {
    chargingInfoClock.value = Date.now()
  }, 1000)
}

function stopChargingInfoClock() {
  if (chargingInfoClockTimer) {
    clearInterval(chargingInfoClockTimer)
    chargingInfoClockTimer = null
  }
}

function hasTariffModel(pile: (typeof topologyStore.piles)[number]): boolean {
  return !!pile.tariffModel && pile.tariffModel.periods.length > 0
}

function tariffTypeLabel(type: number): string {
  if (type === 1) return '尖'
  if (type === 2) return '峰'
  if (type === 3) return '平'
  if (type === 4) return '谷'
  return `类型${type}`
}

function formatRate(v?: number): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '-'
  return v.toFixed(4)
}

function pad2(v: number): string {
  return String(Math.max(0, v)).padStart(2, '0')
}

function periodTimeText(x: {
  startHour: number
  startMinute: number
}): string {
  return `${pad2(x.startHour)}:${pad2(x.startMinute)}`
}

function periodRangeText(
  periods: Array<{
    startHour: number
    startMinute: number
  }>,
  idx: number,
): string {
  const cur = periods[idx]
  if (!cur) return '-'
  const next = periods[(idx + 1) % periods.length] ?? periods[0]
  if (!next) return `${periodTimeText(cur)}~24:00`
  return `${periodTimeText(cur)}~${periodTimeText(next)}`
}

function getCurrentTariffPeriodIndex(pile: (typeof topologyStore.piles)[number]): number {
  const periods = pile.tariffModel?.periods ?? []
  if (!periods.length) return -1
  const now = new Date(nowTick.value)
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const starts = periods
    .map((x, idx) => ({ idx, minutes: x.startHour * 60 + x.startMinute }))
    .sort((a, b) => a.minutes - b.minutes)
  if (!starts.length) return -1
  let current = starts[starts.length - 1].idx
  for (const x of starts) {
    if (nowMinutes >= x.minutes) current = x.idx
    else break
  }
  return current
}

function tcpActionLabel(entry: { command: string; structured: Record<string, unknown> | null }): string | null {
  if (entry.command !== 'TCP') return null
  const type = String(entry.structured?.type ?? '')
  if (type === 'connected') return '链接'
  if (type === 'manual-disconnect' || type === 'disconnected' || type === 'error') return '断开'
  return null
}

function tcpActionClass(entry: { command: string; structured: Record<string, unknown> | null }): string {
  const label = tcpActionLabel(entry)
  if (label === '链接') return 'is-connect'
  if (label === '断开') return 'is-disconnect'
  return ''
}

function logViewMode(id: string): 'raw' | 'structured' {
  return logViewModeById.value[id] ?? 'raw'
}

function setLogViewMode(id: string, mode: 'raw' | 'structured') {
  logViewModeById.value[id] = mode
}

async function copyLogByCurrentMode(entry: {
  id: string
  rawHex: string
  structured: Record<string, unknown> | null
}) {
  const mode = logViewMode(entry.id)
  const text = mode === 'raw'
    ? String(entry.rawHex ?? '')
    : (entry.structured ? JSON.stringify(entry.structured, null, 2) : '当前日志无结构化数据')
  const payload = text || '-'
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(payload)
    } else {
      const ta = document.createElement('textarea')
      ta.value = payload
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    ElMessage.success('日志已复制')
  } catch {
    ElMessage.error('复制失败')
  }
}

function orderStatusLabel(status: string, failReasonText?: string): string {
  if (status === 'created') return '已创建'
  if (status === 'start-accepted') return '启动受理'
  if (status === 'starting') return '启动中'
  if (status === 'charging') return '充电中'
  if (status === 'failed') return '失败'
  if (status === 'stopped') {
    if (failReasonText === '充电完成' || failReasonText === '强制完成') return '已完成'
    return '已停止'
  }
  return status
}

function orderStartTypeLabel(type: string): string {
  return type === 'scheduled' ? '定时启动' : '立即启动'
}

function amountFenLabel(v?: number): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '-'
  return (v / 100).toFixed(2)
}

function removeOrder(orderNo: string) {
  if (!topologyStore.activePileId) return
  orderStore.removeOrder(topologyStore.activePileId, orderNo)
}

function forceStopOrder(orderNo: string) {
  if (!topologyStore.activePileId) return
  const pileId = topologyStore.activePileId
  const live = isLiveChargingOrder(pileId, orderNo)
  if (live) {
    forceStopOrderCharging(pileId, orderNo, '急停按下', 1007)
    ElMessage.success('已强制停止充电订单')
  } else {
    forceCompleteOrder(pileId, orderNo)
    ElMessage.success('已强制完成订单')
  }
}

function forceOrderActionLabel(pileId: string, orderNo: string): string {
  return isLiveChargingOrder(pileId, orderNo) ? '强制停止' : '强制完成'
}

function showForceOrderAction(order: JxPileOrder): boolean {
  return order.status === 'charging' || order.status === 'starting' || order.status === 'start-accepted'
}

function openOrderDetail(orderNo: string) {
  orderDetailOrderNo.value = orderNo
  orderDetailTab.value = 'info'
  orderDetailVisible.value = true
}

async function renderOrderCharts() {
  if (!orderDetailVisible.value || orderDetailTab.value !== 'process') return
  const order = currentOrderDetail.value
  if (!order) return
  if (order25ChartRef.value) {
    const chart = echarts.getInstanceByDom(order25ChartRef.value) ?? echarts.init(order25ChartRef.value)
    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown) => {
          const arr = Array.isArray(params) ? params : []
          if (!arr.length) return ''
          const axis = (arr[0] as { axisValue?: string }).axisValue ?? ''
          const lines = [String(axis)]
          for (const raw of arr) {
            const p = raw as { seriesName?: string; value?: unknown }
            const name = String(p.seriesName ?? '')
            const v = typeof p.value === 'number' ? p.value : Number(p.value)
            if (!Number.isFinite(v)) {
              lines.push(`${name}: —`)
              continue
            }
            if (name.includes('电量')) lines.push(`${name}: ${v.toFixed(4)}`)
            else if (name.includes('金额')) lines.push(`${name}: ${v.toFixed(2)}`)
            else if (name.includes('电压') || name.includes('电流')) lines.push(`${name}: ${v.toFixed(2)}`)
            else lines.push(`${name}: ${String(p.value)}`)
          }
          return lines.join('<br/>')
        },
      },
      legend: { data: ['电压(V)', '电流(A)', '电量(kWh)', '金额(元)'], textStyle: { color: '#d8e7f2' } },
      xAxis: { type: 'category', data: (order.process25 ?? []).map((x) => new Date(x.t).toLocaleTimeString()), axisLabel: { color: '#9fb7cc' } },
      yAxis: { type: 'value', axisLabel: { color: '#9fb7cc' } },
      series: [
        { name: '电压(V)', type: 'line', smooth: true, data: (order.process25 ?? []).map((x) => x.voltage) },
        { name: '电流(A)', type: 'line', smooth: true, data: (order.process25 ?? []).map((x) => x.current) },
        { name: '电量(kWh)', type: 'line', smooth: true, data: (order.process25 ?? []).map((x) => x.energy) },
        { name: '金额(元)', type: 'line', smooth: true, data: (order.process25 ?? []).map((x) => x.amount) },
      ],
    })
  }
  if (order30ChartRef.value) {
    const chart = echarts.getInstanceByDom(order30ChartRef.value) ?? echarts.init(order30ChartRef.value)
    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown) => {
          const arr = Array.isArray(params) ? params : []
          if (!arr.length) return ''
          const axis = (arr[0] as { axisValue?: string }).axisValue ?? ''
          const lines = [String(axis)]
          for (const raw of arr) {
            const p = raw as { seriesName?: string; value?: unknown }
            const name = String(p.seriesName ?? '')
            const v = typeof p.value === 'number' ? p.value : Number(p.value)
            if (!Number.isFinite(v)) {
              lines.push(`${name}: —`)
              continue
            }
            if (name.includes('SOC')) lines.push(`${name}: ${v.toFixed(2)}`)
            else lines.push(`${name}: ${v.toFixed(2)}`)
          }
          return lines.join('<br/>')
        },
      },
      legend: { data: ['BCL电压需求', 'BCL电流需求', 'BCS电压', 'BCS电流', 'SOC'], textStyle: { color: '#d8e7f2' } },
      xAxis: { type: 'category', data: (order.process30 ?? []).map((x) => new Date(x.t).toLocaleTimeString()), axisLabel: { color: '#9fb7cc' } },
      yAxis: { type: 'value', axisLabel: { color: '#9fb7cc' } },
      series: [
        { name: 'BCL电压需求', type: 'line', smooth: true, data: (order.process30 ?? []).map((x) => x.bclVoltageReq) },
        { name: 'BCL电流需求', type: 'line', smooth: true, data: (order.process30 ?? []).map((x) => x.bclCurrentReq) },
        { name: 'BCS电压', type: 'line', smooth: true, data: (order.process30 ?? []).map((x) => x.bcsVoltage) },
        { name: 'BCS电流', type: 'line', smooth: true, data: (order.process30 ?? []).map((x) => x.bcsCurrent) },
        { name: 'SOC', type: 'line', smooth: true, data: (order.process30 ?? []).map((x) => x.soc) },
      ],
    })
  }
}

type LogFieldRow = {
  key: string
  name: string
  raw: string
  meaning: string
  desc: string
}

type FieldMeta = {
  name: string
  desc: string
  decodedKey?: string
  enumMap?: Record<number, string>
  valueType?: 'timeTag6' | 'u16le' | 'u32le' | 'rate4' | 'u8' | 'ascii'
}

const cmdFieldMeta: Record<string, Record<string, FieldMeta>> = {
  '0x01': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    keyVersion: { name: '密钥版本', desc: '1~65535', decodedKey: 'keyVersion', valueType: 'u16le' },
    checkCipher: { name: '校验密文', desc: '校验字段密文' },
    protocolVersion: { name: '协议版本', desc: '压缩BCD协议版本' },
  },
  '0x02': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    allowFlag: { name: '请求结果', desc: '1允许/2拒绝', decodedKey: 'allowFlag', enumMap: { 1: '允许', 2: '拒绝' } },
    rejectReason: { name: '拒绝连接原因', desc: '拒绝原因码', decodedKey: 'rejectReason' },
  },
  '0x03': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    pileModel: { name: '桩型号', desc: '设备型号ASCII' },
    hwVersion: { name: '硬件版本', desc: '压缩BCD版本' },
    swVersion: { name: '软件版本', desc: '压缩BCD版本' },
    subHwVersion: { name: '次级单元硬件版本', desc: '压缩BCD版本' },
    subSwVersion: { name: '次级单元软件版本', desc: '压缩BCD版本' },
    moduleType: { name: '直流模块类型', desc: '模块类型编码' },
    moduleTotal: { name: '直流模块总数', desc: '模块总数量' },
    modulePower: { name: '单模块功率', desc: '单位kW' },
    billingModelVersion: { name: '计费模型版本', desc: '费率模型版本号', valueType: 'u32le' },
    bootCount: { name: '启动次数', desc: '累计启动次数' },
    bootTime: { name: '开机时间', desc: '最近开机时间', valueType: 'timeTag6' },
    heartbeatPeriodSec: { name: '心跳周期', desc: '单位秒', decodedKey: 'heartbeatPeriodSec', valueType: 'u16le' },
    heartbeatTimeoutCount: { name: '心跳超时次数', desc: '超时阈值次数' },
    yaoXinCount: { name: '遥信周期', desc: '单位秒', valueType: 'u16le' },
    yaoCeCount: { name: '遥测周期', desc: '单位秒', valueType: 'u16le' },
    workInfoPeriodSec: { name: '工作信息周期', desc: '单位秒', valueType: 'u16le' },
    bmsInfoPeriodSec: { name: 'BMS信息周期', desc: '单位秒', valueType: 'u16le' },
    bmvPeriodSec: { name: 'BMV周期', desc: '单位秒', valueType: 'u16le' },
    bmtPeriodSec: { name: 'BMT周期', desc: '单位秒', valueType: 'u16le' },
    simNo: { name: 'SIM卡号', desc: '不足补0' },
  },
  '0x04': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    allowFlag: {
      name: '请求结果',
      desc: '1允许/2拒绝/3允许(含二维码)',
      decodedKey: 'allowFlag',
      enumMap: { 1: '允许', 2: '拒绝', 3: '允许(含二维码)' },
    },
    rejectReason: { name: '拒绝原因', desc: '拒绝原因码', decodedKey: 'rejectReason' },
    qrGunCount: { name: '二维码数量', desc: 'N', decodedKey: 'qrGunCount', valueType: 'u8' },
  },
  '0x05': {
    timeTag: { name: '时间标识', desc: '桩请求对时的报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
  },
  '0x06': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    syncTime: { name: '对时时间', desc: '平台下发校时目标时间', decodedKey: 'syncTime', valueType: 'timeTag6' },
  },
  '0x07': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    result: {
      name: '对时结果',
      desc: '1成功；2失败',
      decodedKey: 'result',
      enumMap: { 1: '成功', 2: '失败' },
    },
    failReason: {
      name: '失败原因',
      desc: '0无；1数据格式异常',
      decodedKey: 'failReason',
      enumMap: { 0: '无', 1: '数据格式异常' },
    },
  },
  '0x0b': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    pileHeartbeatTimeoutCount: { name: '桩心跳超时次数', desc: '超时计数', decodedKey: 'pileHeartbeatTimeoutCount' },
  },
  '0x0c': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    platformHeartbeatTimeoutCount: {
      name: '平台心跳超时次数',
      desc: '平台侧超时计数',
      decodedKey: 'platformHeartbeatTimeoutCount',
    },
    gunCount: { name: '枪数量', desc: '本次上送枪数量', decodedKey: 'gunCount' },
  },
  '0x09': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    fanAndHeaterCtrl: { name: '风机控制', desc: '0-关闭；1-开启' },
    reserved: { name: '预留', desc: '置0' },
    gunCount: { name: '充电枪数量N', desc: '1~30', decodedKey: 'gunCount', valueType: 'u8' },
  },
  '0x0a': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    aPhaseVoltage: { name: 'A相电压', desc: '分辨率0.1V' },
    bPhaseVoltage: { name: 'B相电压', desc: '分辨率0.1V' },
    cPhaseVoltage: { name: 'C相电压', desc: '分辨率0.1V' },
    aPhaseCurrent: { name: 'A相电流', desc: '分辨率0.01A' },
    bPhaseCurrent: { name: 'B相电流', desc: '分辨率0.01A' },
    cPhaseCurrent: { name: 'C相电流', desc: '分辨率0.01A' },
    totalMeterEnergy: { name: '总电表电量', desc: '分辨率0.0001kWh' },
    cabinetTemp: { name: '柜内温度', desc: '偏移量-50℃' },
    gunCount: { name: '充电枪数量N', desc: '1~30', decodedKey: 'gunCount', valueType: 'u8' },
  },
  '0x1f': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    gunNo: { name: '枪号', desc: '0~29', decodedKey: 'gunNo' },
    orderNo: { name: '订单号', desc: '全00H表示桩自主生成，ASCII 32字节', decodedKey: 'orderNo', valueType: 'ascii' },
    userId: { name: '用户ID', desc: '不足32字节补0', decodedKey: 'userId', valueType: 'ascii' },
    userType: { name: '用户类型', desc: '见表1.8', decodedKey: 'userType', valueType: 'u16le' },
    orgCode: { name: '组织机构代码', desc: '机构编码，ASCII 9字节', decodedKey: 'orgCode', valueType: 'ascii' },
    controlMode: {
      name: '控制方式',
      desc: '1定时长充 2定电量充 3定金额充 4自动充满 5设定SOC',
      decodedKey: 'controlMode',
      enumMap: { 1: '定时长充', 2: '定电量充', 3: '定金额充', 4: '自动充满', 5: '设定SOC' },
    },
    controlParam: { name: '控制参数', desc: '控制参数，HEX 4字节', decodedKey: 'controlParam', valueType: 'u32le' },
    accountBalance: { name: '账户余额', desc: '0.01元/单位', decodedKey: 'accountBalanceFen', valueType: 'u32le' },
    chargeMode: {
      name: '充电模式',
      desc: '1普通 2轮充 3大功率 4超级充 5电池维护 6柔性充',
      decodedKey: 'chargeMode',
      enumMap: { 1: '普通', 2: '轮充', 3: '大功率', 4: '超级充', 5: '电池维护', 6: '柔性充' },
    },
    startMode: { name: '启动方式', desc: '1立即启动 2定时启动', decodedKey: 'startMode', enumMap: { 1: '立即启动', 2: '定时启动' } },
    scheduleStartTime: { name: '定时启动时间', desc: '时间格式', decodedKey: 'scheduleStartTime' },
    userOpCode: { name: '用户操作码', desc: '数字，用于停止充电', decodedKey: 'userOpCode', valueType: 'ascii' },
    billingModelSelect: {
      name: '计费模型选择',
      desc: '1本地 2本报文费率',
      decodedKey: 'billingModelSelect',
      enumMap: { 1: '本地计费模型', 2: '本报文附带' },
    },
    tariffModelVersion: {
      name: '计费模型版本',
      desc: '计费模型选择=2 时存在',
      decodedKey: 'tariffModelVersion',
      valueType: 'u32le',
    },
    parkingRate: {
      name: '停车费费率',
      desc: '计费模型选择=2 时存在；分辨率0.0001',
      decodedKey: 'parkingRate',
      valueType: 'rate4',
    },
    periodCount: {
      name: '时段数 N',
      desc: '计费模型选择=2 时存在；1~12',
      decodedKey: 'periodCount',
      valueType: 'u8',
    },
  },
  '0x20': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    gunNo: { name: '枪号', desc: '0~29', decodedKey: 'gunNo' },
    orderNo: { name: '订单号', desc: '全00H表示桩自主生成，ASCII 32字节', decodedKey: 'orderNo', valueType: 'ascii' },
    userId: { name: '用户ID', desc: '不足32字节补0', decodedKey: 'userId', valueType: 'ascii' },
    userType: { name: '用户类型', desc: '见表1.8', decodedKey: 'userType', valueType: 'u16le' },
    orgCode: { name: '组织机构代码', desc: '机构编码，ASCII 9字节', decodedKey: 'orgCode', valueType: 'ascii' },
    controlMode: {
      name: '控制方式',
      desc: '1定时长充 2定电量充 3定金额充 4自动充满 5设定SOC（对应 CM20 chargingMode）',
      decodedKey: 'controlMode',
      enumMap: { 1: '定时长充', 2: '定电量充', 3: '定金额充', 4: '自动充满', 5: '设定SOC' },
    },
    controlParam: {
      name: '控制参数',
      desc: '小端 u32；与下行0x1F控制参数同语义（modeValue）。平台按控制方式换算：定时长→÷60 分钟等',
      decodedKey: 'controlParam',
      valueType: 'u32le',
    },
    chargeMode: {
      name: '充电模式',
      desc: '1普通 2轮充 3大功率 4超级充 5电池维护 6柔性充（对应 CM20 modeType）',
      decodedKey: 'chargeMode',
      enumMap: { 1: '普通', 2: '轮充', 3: '大功率', 4: '超级充', 5: '电池维护', 6: '柔性充' },
    },
    startMode: {
      name: '启动方式',
      desc: '1立即启动 2定时启动（对应 CM20 startType）',
      decodedKey: 'startMode',
      enumMap: { 1: '立即启动', 2: '定时启动' },
    },
    scheduleStartTime: { name: '定时启动时间', desc: '时间格式（对应 CM20 startDate）', decodedKey: 'scheduleStartTime' },
    userOpCode: {
      name: '用户操作码',
      desc: 'ASCII 6 字节（对应 CM20 ocCode）',
      decodedKey: 'userOpCode',
      valueType: 'ascii',
    },
    billingModelSelect: {
      name: '计费模型选择',
      desc: '1本地 2本报文费率（对应 CM20 rateType）；选2时后续可附带费率扩展块',
      decodedKey: 'billingModelSelect',
      enumMap: { 1: '本地计费模型', 2: '本报文附带' },
    },
    tariffModelVersion: {
      name: '计费模型版本',
      desc: '计费模型选择=2 时存在',
      decodedKey: 'tariffModelVersion',
      valueType: 'u32le',
    },
    parkingRate: {
      name: '停车费费率',
      desc: '计费模型选择=2 时存在；分辨率0.0001',
      decodedKey: 'parkingRate',
      valueType: 'rate4',
    },
    periodCount: {
      name: '时段数 N',
      desc: '计费模型选择=2 时存在；1~12',
      decodedKey: 'periodCount',
      valueType: 'u8',
    },
    executeResult: { name: '执行结果', desc: '1成功；2失败（对应 CM20 ret）', decodedKey: 'executeResult', enumMap: { 1: '成功', 2: '失败' } },
    failReason: {
      name: '失败原因',
      desc: '失败时有效（对应 CM20 reason）',
      decodedKey: 'failReason',
      enumMap: {
        1: '设备故障',
        2: '充电枪使用中',
        3: '与预约用户不一致',
        4: '定时失败',
        5: '参数不支持',
        6: '其它',
      },
    },
  },
  '0x21': {
    timeTag: { name: '时间标识', desc: '桩时钟', decodedKey: 'timeTag', valueType: 'timeTag6' },
    gunNo: { name: '枪号', desc: '0~29', decodedKey: 'gunNo' },
    orderNo: { name: '订单号', desc: 'ASCII 32', decodedKey: 'orderNo', valueType: 'ascii' },
    userId: { name: '用户ID', desc: 'ASCII 32', decodedKey: 'userId', valueType: 'ascii' },
    userType: { name: '用户类型', desc: '表1.8', decodedKey: 'userType', valueType: 'u16le' },
    orgCode: { name: '机构代码', desc: 'ASCII 9', decodedKey: 'orgCode', valueType: 'ascii' },
    licensePlate: { name: '车牌', desc: 'ASCII 9', decodedKey: 'licensePlate', valueType: 'ascii' },
    controlMode: { name: '控制方式', desc: '定长/定电量/定金额/充满/SOC', decodedKey: 'controlMode' },
    controlParam: { name: '控制参数', desc: '小端 u32', decodedKey: 'controlParam', valueType: 'u32le' },
    chargeMode: { name: '充电模式', desc: '普通/轮充等', decodedKey: 'chargeMode' },
    pileType: { name: '桩类型', desc: '1交流 2直流', decodedKey: 'pileType' },
    startResult: { name: '启动结果', desc: '1成功 2失败', decodedKey: 'startResult' },
    failReason: { name: '失败原因', desc: '小端 u16', decodedKey: 'failReason', valueType: 'u16le' },
    chargeStartTime: { name: '起始时间', desc: '成功后有', decodedKey: 'chargeStartTime', valueType: 'timeTag6' },
    chargeStartEnergy: { name: '起始电量', desc: 'FOUR_POINT kWh', decodedKey: 'chargeStartEnergyKwh' },
    insDeVoltage: { name: '绝缘检测电压', desc: '0.1V', decodedKey: 'insulationVoltage01V' },
    dcAddIns: { name: 'DC+绝缘', desc: '1Ω/V', decodedKey: 'dcPlusInsulation' },
    dcSubtractIns: { name: 'DC-绝缘', desc: '1Ω/V', decodedKey: 'dcMinusInsulation' },
    brmVer: { name: 'BRM版本', desc: '3B HEX', decodedKey: 'brmVerHex' },
    brmVin: { name: 'VIN', desc: 'ASCII 17', decodedKey: 'brmVin', valueType: 'ascii' },
    bcpSoc: { name: 'BCP-SOC', desc: '原始×0.1→%', decodedKey: 'bcpSoc' },
    bcpBatteryVoltage: { name: '电池电压', desc: '0.1V', decodedKey: 'bcpBatteryVoltage01V' },
  },
  '0x22': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    gunNo: { name: '枪号', desc: '0~29', decodedKey: 'gunNo' },
    orderNo: { name: '订单号', desc: 'ASCII 32字节', decodedKey: 'orderNo', valueType: 'ascii' },
  },
  '0x19': {
    timeTag: { name: '时间标识', desc: '报文时间戳（6字节）', decodedKey: 'timeTag', valueType: 'timeTag6' },
    cardNo: { name: '卡号', desc: '16字节ASCII，不足补0', decodedKey: 'cardNo', valueType: 'ascii' },
    gunNo: { name: '枪号', desc: '0~29', decodedKey: 'gunNo', valueType: 'u8' },
  },
  '0x1a': {
    timeTag: { name: '时间标识', desc: '报文时间戳（6字节）', decodedKey: 'timeTag', valueType: 'timeTag6' },
    cardNo: { name: '卡号', desc: '与0x19对应', decodedKey: 'cardNo', valueType: 'ascii' },
    accountBalance: { name: '卡余额', desc: '分辨率0.01元', decodedKey: 'accountBalanceFen', valueType: 'u32le' },
    allowChargeFlag: {
      name: '允许充电标志',
      desc: '1可充电 2禁止',
      decodedKey: 'allowChargeFlag',
      enumMap: { 1: '可充电', 2: '禁止充电' },
    },
    prohibitReason: { name: '不可充电原因', desc: '禁止时有效', decodedKey: 'prohibitReason', valueType: 'u8' },
    billingModelSelect: {
      name: '计费模型选择',
      desc: '1本地 2本报文附带',
      decodedKey: 'billingModelSelect',
      enumMap: { 1: '本地计费模型', 2: '本报文附带' },
    },
    orderNo: { name: '充电订单号', desc: '32字节ASCII', decodedKey: 'orderNo', valueType: 'ascii' },
  },
  /** 上行 VIN 鉴权，与 `CM40Data224` 字段顺序一致 */
  '0x40': {
    timeTag: { name: '时间标识', desc: '报文时间戳（6字节时间格式）', decodedKey: 'timeTag', valueType: 'timeTag6' },
    vin: { name: '车辆VIN', desc: '17字节ASCII，不足补0', decodedKey: 'vin', valueType: 'ascii' },
    gunNo: { name: '充电枪号', desc: '单字节无符号，桩内枪位0~29', decodedKey: 'gunNo', valueType: 'u8' },
    orderNo: {
      name: '充电订单号',
      desc: '32字节ASCII；全0表示空（VIN启动默认），非全0与后续流程一致',
      decodedKey: 'orderNo',
      valueType: 'ascii',
    },
  },
  /** 下行 0x41 回复 VIN 鉴权（41H），见《玖行桩协议2.24》§8.6.2 / 表3.8.4 */
  '0x59': {
    timeTag: { name: '时间标识', desc: '报文时间戳（6字节）', decodedKey: 'timeTag', valueType: 'timeTag6' },
    gunNo: { name: '枪号', desc: '0~29', decodedKey: 'gunNo', valueType: 'u8' },
    orderNo: { name: '充电订单号', desc: '32字节ASCII，平台扫码后下发', decodedKey: 'orderNo', valueType: 'ascii' },
  },
  '0x5b': {
    timeTag: { name: '时间标识', desc: '报文时间戳（6字节）', decodedKey: 'timeTag', valueType: 'timeTag6' },
    gunNo: { name: '枪号', desc: '0~29', decodedKey: 'gunNo', valueType: 'u8' },
    orderNo: { name: '充电订单号', desc: '32字节ASCII，与0x59一致', decodedKey: 'orderNo', valueType: 'ascii' },
    result: { name: '结果', desc: '1成功 2失败', decodedKey: 'result', enumMap: { 1: '成功', 2: '失败' } },
    failReason: { name: '失败原因', desc: '失败时有效', decodedKey: 'failReason', valueType: 'u8' },
  },
  '0x41': {
    timeTag: { name: '时间标识', desc: '字节0~5，时间格式', decodedKey: 'timeTag', valueType: 'timeTag6' },
    vin: { name: 'VIN', desc: '字节6~22，17字节ASCII，不足补0', decodedKey: 'vin', valueType: 'ascii' },
    accountBalance: {
      name: '账户余额',
      desc: '字节23~26，4字节小端；分辨率0.01元（与0x1F「账户余额」同语义）',
      decodedKey: 'accountBalanceFen',
      valueType: 'u32le',
    },
    allowChargeFlag: {
      name: '允许充电标志',
      desc: '字节27；1允许 2禁止',
      decodedKey: 'allowChargeFlag',
      enumMap: { 1: '允许充电', 2: '禁止充电' },
    },
    prohibitReason: {
      name: '不可充电原因',
      desc: '字节28；禁止充电时有效',
      decodedKey: 'prohibitReason',
      enumMap: {
        1: '余额不足（≤0）',
        2: '充电枪使用中',
        3: '黑名单',
        4: '未登记VIN',
        5: '其它',
        6: '余额低于最低启动金额',
        7: 'VIN启动金额冻结失败',
        8: '车辆或站点信息获取失败',
        9: '无本站充电权限',
        10: '支付/扣款账户获取失败',
        11: '支付/扣款账户未配置',
        12: '支付/扣款账户状态异常',
        13: '上报VIN非法（空或乱码）',
      },
    },
    billingModelSelect: {
      name: '计费模型选择',
      desc: '字节29；=1时数据域总长30字节；=2时续费率头+时段+末尾订单号（总长71+11×N）',
      decodedKey: 'billingModelSelect',
      enumMap: { 1: '使用桩本地计费模型', 2: '使用本报文内嵌计费模型' },
    },
    tariffModelVersion: {
      name: '计费模型版本',
      desc: '字节30~33（仅序号6=2）；4字节小端 HEX，1~65535',
      decodedKey: 'tariffModelVersion',
      valueType: 'u32le',
    },
    parkingRate: {
      name: '停车费费率',
      desc: '字节34~37（仅序号6=2）；4字节小端，分辨率0.0001',
      decodedKey: 'parkingRate',
      valueType: 'rate4',
    },
    periodCount: {
      name: '时段数 N',
      desc: '字节38（仅序号6=2）；1~12',
      decodedKey: 'periodCount',
      valueType: 'u8',
    },
    orderNo: {
      name: '充电订单号',
      desc: '仅序号6=2：紧接N段时段后共32字节ASCII；起始字节=39+11×N；与0x21/0x25一致，不足补0',
      decodedKey: 'orderNo',
      valueType: 'ascii',
    },
  },
  '0x26': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    gunNo: { name: '枪号', desc: '0~29', decodedKey: 'gunNo' },
    orderNo: { name: '充电订单号', desc: '全0表示仅按枪号停止', decodedKey: 'orderNo', valueType: 'ascii' },
    orderNoFieldAllZero: { name: '订单号是否全0', desc: 'true=仅校验枪号', decodedKey: 'orderNoFieldAllZero' },
  },
  '0x27': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    gunNo: { name: '枪号', desc: '0~29', decodedKey: 'gunNo' },
    orderNo: { name: '充电订单号', desc: '与0x26回显一致', decodedKey: 'orderNo', valueType: 'ascii' },
    stopResult: {
      name: '停止结果',
      desc: '0成功 1订单号不一致',
      decodedKey: 'stopResult',
      enumMap: { 0: '成功', 1: '订单号不一致' },
    },
  },
  '0x23': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    gunNo: { name: '枪号', desc: '0~29', decodedKey: 'gunNo' },
    recordIndex: { name: '记录索引号', desc: '订单记录索引', decodedKey: 'recordIndex', valueType: 'u32le' },
    orderNo: { name: '充电订单号', desc: 'ASCII 32字节', decodedKey: 'orderNo', valueType: 'ascii' },
    userId: { name: '用户ID', desc: '不足32字节补0', decodedKey: 'userId', valueType: 'ascii' },
    userType: { name: '用户类型', desc: '见表1.8', decodedKey: 'userType', valueType: 'u16le' },
    orgCode: { name: '组织机构代码', desc: 'ASCII 9字节', decodedKey: 'orgCode', valueType: 'ascii' },
    vin: { name: 'VIN', desc: '车辆VIN', decodedKey: 'vin', valueType: 'ascii' },
    startTime: { name: '开始充电时间', desc: '时间格式', decodedKey: 'startTime', valueType: 'timeTag6' },
    endTime: { name: '结束充电时间', desc: '时间格式', decodedKey: 'endTime', valueType: 'timeTag6' },
    startEnergy: { name: '开始充电电量', desc: '分辨率0.0001kWh', decodedKey: 'startEnergy' },
    endEnergy: { name: '结束充电电量', desc: '分辨率0.0001kWh', decodedKey: 'endEnergy' },
    startSoc: { name: '开始充电SOC', desc: 'SOC百分比', decodedKey: 'startSoc' },
    endSoc: { name: '结束充电SOC', desc: 'SOC百分比', decodedKey: 'endSoc' },
    controlMode: { name: '控制方式', desc: '定时长充/定电量充/定金额充/自动充满/设定SOC', decodedKey: 'controlMode' },
    controlParam: {
      name: '控制参数',
      desc: '小端u32；定金额/定电量等为0.01元或0.01kWh单位，与起止/段电量(0.0001kWh)不同',
      decodedKey: 'controlParam',
      valueType: 'u32le',
    },
    startMode: { name: '启动类型', desc: '立即启动/定时启动', decodedKey: 'startMode' },
    scheduleStartTime: { name: '定时启动时间', desc: '启动类型=定时时有效', decodedKey: 'scheduleStartTime', valueType: 'timeTag6' },
    chargeMode: { name: '充电模式', desc: '普通/轮充/大功率/超级充/电池维护/柔性充', decodedKey: 'chargeMode' },
    stopReason: { name: '停止充电原因', desc: '原因码', decodedKey: 'stopReason', valueType: 'u16le' },
    billingModelSelect: {
      name: '计费模型选择',
      desc: '含4=订单本报文费率',
      decodedKey: 'billingModelSelect',
      enumMap: { 1: '本地', 2: '卡', 3: 'VIN', 4: '本报文费率订单' },
    },
    modelVersion: { name: '计费模型版本', desc: '1~65535', decodedKey: 'modelVersion', valueType: 'u32le' },
    electricFee: { name: '电能费用', desc: '分辨率0.01元', decodedKey: 'electricFee' },
    serviceFee: { name: '服务费费用', desc: '分辨率0.01元', decodedKey: 'serviceFee' },
    parkFee: { name: '停车费费用', desc: '分辨率0.01元', decodedKey: 'parkFee' },
    segmentCount: { name: '时间段数量N', desc: '1~20', decodedKey: 'segmentCount' },
    batterySn: { name: '电池SN', desc: 'V2.24 为 27 字节；V2.25 为 17 字节（与 protocolId 相关）', decodedKey: 'batterySn', valueType: 'ascii' },
  },
  '0x25': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    gunNo: { name: '枪号', desc: '0~29', decodedKey: 'gunNo' },
    chargeVoltage: { name: '充电电压', desc: '分辨率0.1V' },
    chargeCurrent: { name: '充电电流', desc: '分辨率0.1A' },
    chargeEnergy: { name: '充电电量', desc: '分辨率0.0001kWh' },
    chargeDuration: { name: '充电时长', desc: '分辨率1s' },
    chargeAmount: { name: '充电金额', desc: '分辨率0.01元' },
    moduleCount: { name: '充电模块接入数量', desc: '模块数量', decodedKey: 'moduleCount' },
    electricAmount: { name: '充电电费金额', desc: '分辨率0.01元', decodedKey: 'electricAmount' },
    serviceAmount: { name: '充电服务费金额', desc: '分辨率0.01元', decodedKey: 'serviceAmount' },
    orderNo: { name: '充电订单号', desc: 'ASCII 32字节', decodedKey: 'orderNo', valueType: 'ascii' },
    accountBalance: { name: '账户余额', desc: '分辨率0.01元', decodedKey: 'accountBalance' },
    segmentCount: { name: '时间段数量N', desc: '循环时段数量', decodedKey: 'segmentCount' },
  },
  '0x30': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    gunNo: { name: '枪号', desc: '0~29', decodedKey: 'gunNo' },
    bclVoltageReq: { name: 'BCL电压需求', desc: '分辨率0.1V', decodedKey: 'bclVoltageReq' },
    bclCurrentReq: { name: 'BCL电流需求', desc: '分辨率0.1A', decodedKey: 'bclCurrentReq' },
    bcsVoltage: { name: 'BCS充电电压', desc: '分辨率0.1V', decodedKey: 'bcsVoltage' },
    bcsCurrent: { name: 'BCS充电电流', desc: '分辨率0.1A', decodedKey: 'bcsCurrent' },
    soc: { name: 'BCS-SOC', desc: '0~100%', decodedKey: 'soc' },
  },
  '0x37': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    modelVersion: { name: '计费模型版本', desc: '1~65535', decodedKey: 'modelVersion', valueType: 'u32le' },
    parkingRate: { name: '停车费费率', desc: '分辨率0.0001', decodedKey: 'parkingRate', valueType: 'rate4' },
    periodCount: { name: '时段数N', desc: '1~12', decodedKey: 'periodCount' },
  },
  '0x38': {
    timeTag: { name: '时间标识', desc: '报文时间戳', decodedKey: 'timeTag', valueType: 'timeTag6' },
    modelVersion: { name: '计费模型版本', desc: '对应设置版本', decodedKey: 'modelVersion', valueType: 'u32le' },
    result: { name: '费率模型设置结果', desc: '1成功/2失败', decodedKey: 'result', enumMap: { 1: '成功', 2: '失败' } },
    failReason: { name: '失败原因', desc: '时间段穿插/数量错误/格式错误/其他', decodedKey: 'failReason' },
  },
}

function decodeU16LeFromHex(hex: string): number {
  const h = hex.replace(/[^0-9a-f]/gi, '')
  if (h.length < 4) return 0
  return Number.parseInt(h.slice(0, 2), 16) | (Number.parseInt(h.slice(2, 4), 16) << 8)
}

function decodeU32LeFromHex(hex: string): number {
  const h = hex.replace(/[^0-9a-f]/gi, '')
  if (h.length < 8) return 0
  const b0 = Number.parseInt(h.slice(0, 2), 16)
  const b1 = Number.parseInt(h.slice(2, 4), 16)
  const b2 = Number.parseInt(h.slice(4, 6), 16)
  const b3 = Number.parseInt(h.slice(6, 8), 16)
  return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0
}

function decodeTimeTag6FromHex(hex: string): string {
  const h = hex.replace(/[^0-9a-f]/gi, '').toUpperCase()
  if (h.length !== 12) return '-'
  const yy = Number.parseInt(h.slice(0, 2), 16)
  const mm = Number.parseInt(h.slice(2, 4), 16)
  const dd = Number.parseInt(h.slice(4, 6), 16)
  const HH = Number.parseInt(h.slice(6, 8), 16)
  const MM = Number.parseInt(h.slice(8, 10), 16)
  const SS = Number.parseInt(h.slice(10, 12), 16)
  return `20${pad2(yy)}-${pad2(mm)}-${pad2(dd)} ${pad2(HH)}:${pad2(MM)}:${pad2(SS)}`
}

function decodeAsciiFromHex(hex: string): string {
  const h = (hex ?? '').replace(/[^0-9a-f]/gi, '')
  let out = ''
  for (let i = 0; i + 2 <= h.length; i += 2) {
    const byte = Number.parseInt(h.slice(i, i + 2), 16)
    if (byte === 0x00) break
    out += String.fromCharCode(byte)
  }
  return out
}

function toHexPairs(hex: string): string {
  return (hex || '')
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase()
    .replace(/(.{2})/g, '$1 ')
    .trim()
}

function explainValue(meta: FieldMeta | undefined, rawHex: string, decodedValue: unknown): string {
  if (decodedValue !== undefined && decodedValue !== null && decodedValue !== '') {
    if (typeof decodedValue === 'number' && meta?.enumMap?.[decodedValue]) {
      return `${decodedValue} (${meta.enumMap[decodedValue]})`
    }
    return String(decodedValue)
  }
  if (!meta) return rawHex || '-'
  if (meta.valueType === 'timeTag6') return decodeTimeTag6FromHex(rawHex)
  if (meta.valueType === 'u16le') return String(decodeU16LeFromHex(rawHex))
  if (meta.valueType === 'u32le') return String(decodeU32LeFromHex(rawHex))
  if (meta.valueType === 'rate4') return (decodeU32LeFromHex(rawHex) / 10000).toFixed(4)
  if (meta.valueType === 'u8') return String(Number.parseInt(rawHex || '0', 16))
  if (meta.valueType === 'ascii') return decodeAsciiFromHex(rawHex)
  const num = Number.parseInt(rawHex || '0', 16)
  if (meta.enumMap?.[num]) return `${num} (${meta.enumMap[num]})`
  return rawHex || '-'
}

function logFieldRows(entry: { command: string; structured: Record<string, unknown> | null }): LogFieldRow[] {
  const decoded = entry.structured?.decoded as
    | {
        cmd?: string
        segments?: Array<{ name?: string; hex?: string }>
        [k: string]: unknown
      }
    | undefined
  if (!decoded?.segments?.length) return []
  const cmd = String(decoded.cmd ?? entry.command ?? '').toLowerCase()
  const cmdMeta = cmdFieldMeta[cmd] ?? {}
  return decoded.segments.map((seg, idx) => {
    const key = String(seg.name ?? `field_${idx + 1}`)
    const rawHex = String(seg.hex ?? '')
    const meta = cmdMeta[key]
    const decodedValue = meta?.decodedKey ? decoded[meta.decodedKey] : decoded[key]
    const dynamicMeta = (() => {
      if (!meta && key === 'qrFixedAscii') {
        return {
          name: '二维码固定段',
          desc: 'ASCII 100字节',
          decodedKey: 'qrFixedAscii',
          valueType: 'ascii' as const,
        }
      }
      if (!meta && key === 'qrGunCount') {
        return { name: '二维码数量', desc: 'N', decodedKey: 'qrGunCount', valueType: 'u8' as const }
      }
      const mGun = key.match(/^qrGun(\d+)Ascii$/)
      if (!meta && mGun) {
        const idx = Number.parseInt(mGun[1], 10)
        const gunChar = String.fromCharCode(64 + idx)
        return {
          name: `二维码${gunChar}枪`,
          desc: 'ASCII 100字节，对应充电枪二维码',
          decodedKey: `qrGunCode${idx}`,
          valueType: 'ascii' as const,
        }
      }
      if (!meta && /^period\d+/.test(key)) {
        return {
          name: key
            .replace(/StartHour$/, ' 起始时')
            .replace(/StartMinute$/, ' 起始分')
            .replace(/ElectricRate$/, ' 电价费率')
            .replace(/ServiceRate$/, ' 服务费率')
            .replace(/Type$/, ' 类型'),
          desc: '时段字段',
          valueType: key.endsWith('Rate') ? ('rate4' as const) : undefined,
          enumMap: key.endsWith('Type')
            ? ({
                1: '尖',
                2: '峰',
                3: '平',
                4: '谷',
              } as Record<number, string>)
            : undefined,
        }
      }
      const m25Segment = key.match(/^segment(\d+)(StartTime|EndTime|ElePrice|SvcPrice|Energy|EleFee|SvcFee)$/)
      if (!meta && m25Segment) {
        const segIdx = Number.parseInt(m25Segment[1], 10)
        const suffix = m25Segment[2]
        const segFieldNameMap: Record<string, string> = {
          StartTime: '开始时间',
          EndTime: '结束时间',
          ElePrice: '电价',
          SvcPrice: '服务费价格',
          Energy: '电量',
          EleFee: '电费',
          SvcFee: '服务费',
        }
        return {
          name: `时段${segIdx} ${segFieldNameMap[suffix] ?? suffix}`,
          desc: '0x25 时段循环字段',
          valueType: suffix === 'StartTime' || suffix === 'EndTime' ? ('timeTag6' as const) : undefined,
        }
      }
      const m23Segment = key.match(/^segment(\d+)(ModelIndex|Energy)$/)
      if (!meta && m23Segment) {
        const segIdx = Number.parseInt(m23Segment[1], 10)
        const suffix = m23Segment[2]
        return {
          name: suffix === 'ModelIndex' ? `时段${segIdx} 计费模型索引` : `时段${segIdx} 电量`,
          desc: suffix === 'ModelIndex' ? '按计费模型时段顺序从0开始' : '分辨率0.0001kWh',
        }
      }
      const mGunStatus = key.match(/^gun(\d+)Status$/)
      if (!meta && mGunStatus) {
        return {
          name: `${mGunStatus[1]}#充电枪状态`,
          desc: '1-待机 2-等待连接 3-启动中 4-充电中 5-停止中 6-预约中 7-占用中 8-测试中 9-故障中 10-定时充电中 11-充电完成 12-升级中',
          enumMap: {
            1: '待机',
            2: '等待连接',
            3: '启动中',
            4: '充电中',
            5: '停止中',
            6: '预约中',
            7: '占用中',
            8: '测试中',
            9: '故障中',
            10: '定时充电中',
            11: '充电完成',
            12: '升级中',
          } as Record<number, string>,
        }
      }
      const mGunMode = key.match(/^gun(\d+)WorkMode$/)
      if (!meta && mGunMode) {
        return {
          name: `${mGunMode[1]}#工作模式`,
          desc: '1-普通 2-经济 3-大功率 4-同车充 5-电池维护 6-柔性充',
          enumMap: { 1: '普通', 2: '经济', 3: '大功率', 4: '同车充', 5: '电池维护', 6: '柔性充' } as Record<number, string>,
        }
      }
      const mStateBits = key.match(/^gun(\d+)StateBits$/)
      if (!meta && mStateBits) {
        return { name: `${mStateBits[1]}#状态位11`, desc: '车辆连接/输出接触器/枪进入/电子锁/辅助电源/BMS通信/CP反放电' }
      }
      const mFeedbackBits = key.match(/^gun(\d+)FeedbackBits$/)
      if (!meta && mFeedbackBits) {
        return { name: `${mFeedbackBits[1]}#状态位12`, desc: '反馈回路/CC2(CAN)连接状态' }
      }
      const mCpCcBits = key.match(/^gun(\d+)CpCcBits$/)
      if (!meta && mCpCcBits) {
        return { name: `${mCpCcBits[1]}#状态位13`, desc: 'CP/CC状态' }
      }
      return undefined
    })()
    const useMeta = meta ?? dynamicMeta
    return {
      key: `${cmd}-${key}-${idx}`,
      name: useMeta?.name ?? key,
      raw: rawHex ? toHexPairs(rawHex) : '-',
      meaning: explainValue(useMeta, rawHex, decodedValue),
      desc: useMeta?.desc ?? '协议字段',
    }
  })
}

function truncateLogFieldValue(value: string, maxLen = 100): string {
  if ((value ?? '').length <= maxLen) return value
  return `${value.slice(0, maxLen)}...`
}

function truncateLogMeaningValue(value: string, maxLen = 200): string {
  if ((value ?? '').length <= maxLen) return value
  return `${value.slice(0, maxLen)}...`
}

function randomVin(): string {
  const chars = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'
  let out = ''
  for (let i = 0; i < 17; i += 1) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

function isVirtualCar(pileId: string, gunId: string): boolean {
  const pile = topologyStore.piles.find((x) => x.pileId === pileId)
  const gun = pile?.guns.find((x) => x.gunId === gunId)
  if (!pile || !gun) return false
  if (pile.onlineState !== 'online') return true
  return !gun.vin
}

function openVinDialog(pileId: string, gunId: string) {
  if (!isVirtualCar(pileId, gunId)) return
  const pile = topologyStore.piles.find((x) => x.pileId === pileId)
  const gun = pile?.guns.find((x) => x.gunId === gunId)
  const remembered = String(gun?.lastVin ?? '').trim().toUpperCase()
  const initialVin = remembered.length >= 8 ? remembered : randomVin()
  vinForm.value = {
    pileId,
    gunId,
    vin: initialVin,
  }
  vinEdit.value = {
    visible: true,
    pileId,
    gunId,
  }
  if (boardViewMode.value === 'topology') {
    nextTick(() => {
      updateVinPopPosition()
      bindVinPopScrollListener()
    })
  }
}

function closeVinEditor() {
  vinEdit.value.visible = false
  unbindVinPopScrollListener()
}

/** 根据二维码文本生成/读取缓存图片（无内容则清空图） */
async function loadStartControlQrImage(qrText: string) {
  const text = String(qrText ?? '').trim()
  qrDialogText.value = text
  qrDialogImgUrl.value = ''
  if (!text) {
    qrDialogLoading.value = false
    return
  }
  qrDialogLoading.value = true
  try {
    const cached = qrCache.get(text)
    if (cached) {
      qrDialogImgUrl.value = cached
      return
    }
    const url = await QRCode.toDataURL(text, { margin: 1, width: 220, errorCorrectionLevel: 'M' })
    qrCache.set(text, url)
    qrDialogImgUrl.value = url
  } finally {
    qrDialogLoading.value = false
  }
}

function openStartControlDialog(pileId: string, gunId: string) {
  const pile = topologyStore.piles.find((x) => x.pileId === pileId)
  const gun = pile?.guns.find((g) => g.gunId === gunId)
  if (!pile || !gun) return
  qrDialogPileId.value = pileId
  qrDialogGunId.value = gunId
  qrDialogPanelSlide.value = false
  if (gun.status === 'charging') {
    qrDialogPanel.value = 'charging'
  } else {
    qrDialogPanel.value = 'start'
    qrDialogTab.value = 'scan'
    startControlVinEditing.value = false
    startControlVinDraft.value = String(gun.vin ?? '').trim().toUpperCase()
    startControlCardDraft.value = ''
    void loadStartControlQrImage(String(gun.qrCode ?? ''))
  }
  qrDialogVisible.value = true
}

function reloadStartControlVinDraftFromGun() {
  const pile = topologyStore.piles.find((x) => x.pileId === qrDialogPileId.value)
  const gun = pile?.guns.find((g) => g.gunId === qrDialogGunId.value)
  startControlVinDraft.value = String(gun?.vin ?? '').trim().toUpperCase()
}

function cancelStartControlVinEdit() {
  reloadStartControlVinDraftFromGun()
  startControlVinEditing.value = false
}

function saveStartControlVinFromDialog() {
  const pid = qrDialogPileId.value
  const gid = qrDialogGunId.value
  const v = startControlVinDraft.value.trim().toUpperCase()
  if (!pid || !gid) return
  if (v.length < 8) {
    ElMessage.warning('VIN长度不合法（至少8位）')
    return
  }
  topologyStore.applyStatePatch(pid, { gunPatch: { gunId: gid, vin: v, lastVin: v } })
  pushTeleSignalOnStateChange(pid)
  startControlVinEditing.value = false
  ElMessage.success('VIN已保存')
}

watch(qrDialogTab, (t) => {
  if (t === 'vin' && qrDialogVisible.value && !startControlVinEditing.value) {
    reloadStartControlVinDraftFromGun()
  }
})

watch(
  () => {
    const pid = qrDialogPileId.value
    const gid = qrDialogGunId.value
    if (!pid || !gid) return 'idle'
    const pile = topologyStore.piles.find((x) => x.pileId === pid)
    const gun = pile?.guns.find((x) => x.gunId === gid)
    return gun?.status ?? 'idle'
  },
  (status, prev) => {
    if (!qrDialogVisible.value) return
    if (status === 'charging' && prev !== 'charging' && qrDialogPanel.value === 'start') {
      syncQrDialogPanelForGun(qrDialogPileId.value, qrDialogGunId.value, true)
    } else if (status !== 'charging' && prev === 'charging' && qrDialogPanel.value === 'charging') {
      qrDialogPanelSlide.value = false
      qrDialogPanel.value = 'start'
      const pile = topologyStore.piles.find((x) => x.pileId === qrDialogPileId.value)
      const gun = pile?.guns.find((x) => x.gunId === qrDialogGunId.value)
      if (gun && gun.status !== 'charging') {
        startControlVinDraft.value = String(gun.vin ?? '').trim().toUpperCase()
        void loadStartControlQrImage(String(gun.qrCode ?? ''))
      }
    }
  },
)

watch(
  [qrDialogVisible, qrDialogPanel],
  ([visible, panel]) => {
    if (visible && panel === 'charging') startChargingInfoClock()
    else stopChargingInfoClock()
  },
  { immediate: true },
)

function onQrDialogClosed() {
  startControlVinEditing.value = false
  qrDialogPanelSlide.value = false
  qrDialogPanel.value = 'start'
  stopChargingInfoClock()
}

function disconnectGunLink(pileId: string, gunId: string) {
  const pile = topologyStore.piles.find((x) => x.pileId === pileId)
  const gun = pile?.guns.find((x) => x.gunId === gunId)
  if (!pile || !gun) return
  if (gun.status === 'charging') {
    ElMessage.warning('充电中车辆不可直接断开')
    return
  }
  topologyStore.applyStatePatch(pileId, {
    gunPatch: {
      gunId,
      status: 'idle',
      vin: undefined,
      soc: undefined,
    },
  })
  pushTeleSignalOnStateChange(pileId)
  ElMessage.success(`${gunLabel(pileId, gunId)}已断开车辆链接`)
}

function handleCarClick(pileId: string, gunId: string) {
  const pile = topologyStore.piles.find((x) => x.pileId === pileId)
  const gun = pile?.guns.find((x) => x.gunId === gunId)
  if (!pile || !gun) return
  if (pile.onlineState !== 'online') {
    ElMessage.warning('请先登录链接桩与平台建立连接后，再连接车辆')
    return
  }
  if (isVirtualCar(pileId, gunId)) {
    openVinDialog(pileId, gunId)
    return
  }
  openStartControlDialog(pileId, gunId)
}

function disconnectFromQrDialog() {
  if (!qrDialogPileId.value || !qrDialogGunId.value) return
  disconnectGunLink(qrDialogPileId.value, qrDialogGunId.value)
  qrDialogVisible.value = false
}

/** 与订单列表「强制停止」一致：急停原因码 1007 */
function forceStopFromQrDialog() {
  const pid = qrDialogPileId.value
  const gid = qrDialogGunId.value
  if (!pid || !gid) return
  const order = orderStore.listByPile(pid).find((x) => x.gunId === gid && x.status === 'charging')
  if (!order) {
    ElMessage.warning('未找到充电中的订单')
    return
  }
  forceStopOrderCharging(pid, order.orderNo, '急停按下', 1007)
  ElMessage.success('已强制停止充电订单')
}

async function onVinAuthStartFromQr() {
  const pid = qrDialogPileId.value
  const gid = qrDialogGunId.value
  if (!pid || !gid) return
  vinAuthBusy.value = true
  try {
    const r = await runVinAuthRemoteStart(pid, gid)
    if (r.ok) ElMessage.success('VIN 启动已通过鉴权，已发起充电（0x21）')
    else notifyVinStartFailure(r.error ?? '未知原因')
  } finally {
    vinAuthBusy.value = false
  }
}

async function onCardAuthStartFromDialog() {
  const pid = qrDialogPileId.value
  const gid = qrDialogGunId.value
  if (!pid || !gid) return
  const card = startControlCardDraft.value.trim()
  if (!card) {
    ElMessage.warning('请输入卡号')
    return
  }
  cardAuthBusy.value = true
  try {
    const r = await runCardAuthRemoteStart(pid, gid, card)
    if (r.ok) ElMessage.success('卡鉴权通过，已上送 0x21 启动结果')
    else ElMessage.error(r.error ?? '卡启动失败')
  } finally {
    cardAuthBusy.value = false
  }
}

async function removePile(pileId: string) {
  const pile = topologyStore.piles.find((x) => x.pileId === pileId)
  if (!pile) return
  if (pile.onlineState !== 'offline') {
    ElMessage.warning('仅离线状态桩可删除')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确认删除桩 ${pileId} 及其枪/车/VIN/状态等关联信息吗？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    topologyStore.removePile(pileId)
    orderStore.removeByPile(pileId)
    ElMessage.success(`桩 ${pileId} 已删除`)
  } catch {
    // 用户取消
  }
}

function confirmLinkCar() {
  const vin = vinForm.value.vin.trim().toUpperCase()
  if (vin.length < 8) {
    ElMessage.warning('VIN长度不合法')
    return
  }
  topologyStore.applyStatePatch(vinForm.value.pileId, {
    gunPatch: {
      gunId: vinForm.value.gunId,
      status: 'linked',
      vin,
      lastVin: vin,
      soc: undefined,
    },
  })
  pushTeleSignalOnStateChange(vinForm.value.pileId)
  vinEdit.value.visible = false
  ElMessage.success(`${gunLabel(vinForm.value.pileId, vinForm.value.gunId)}已连接车辆`)
}

function openAddDialog() {
  addForm.value = {
    pileId: String(topologyStore.piles.length + 1).padStart(3, '0'),
    tcpHost: '127.0.0.1',
    tcpPort: 9000 + topologyStore.piles.length + 1,
    pilePowerKw: 120,
    gunCount: 2,
    protocolId: protocolStore.activeProtocol.protocolId,
  }
  addDialogVisible.value = true
}

function confirmAddPile() {
  const data = addForm.value
  if (!data.pileId.trim()) {
    ElMessage.warning('请输入桩号')
    return
  }
  if (!data.tcpHost.trim()) {
    ElMessage.warning('请输入TCP链接地址')
    return
  }
  if (data.tcpPort <= 0 || data.tcpPort > 65535) {
    ElMessage.warning('端口范围应为1-65535')
    return
  }
  if (data.gunCount < 1 || data.gunCount > 4) {
    ElMessage.warning('枪数量范围为1-4')
    return
  }
  if (data.pilePowerKw <= 0 || data.pilePowerKw > 2000) {
    ElMessage.warning('桩功率范围为1-2000kW')
    return
  }
  try {
    topologyStore.addPile({
      protocolId: data.protocolId || protocolStore.activeProtocol.protocolId,
      pileId: data.pileId.trim(),
      tcpHost: data.tcpHost.trim(),
      tcpPort: data.tcpPort,
      pilePowerKw: data.pilePowerKw,
      gunCount: data.gunCount,
    })
    addDialogVisible.value = false
    ElMessage.success('桩创建成功，默认离线')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '创建失败')
  }
}
</script>

<template>
  <div class="jx-scope">
    <div class="jx-page">
      <header class="jx-toolbar">
        <div class="jx-toolbar-field">
          <span class="jx-ico" aria-hidden="true">协议</span>
          <el-select v-model="filterProtocol" class="jx-select" placeholder="按协议筛选显示的桩（全部桩仍保存在本地）">
            <el-option
              v-for="p in protocolStore.protocols"
              :key="p.protocolId"
              :label="`${p.protocolName}`"
              :value="p.protocolId"
              :disabled="!protocolStore.isJxProtocolSelectable(p.protocolId)"
            />
          </el-select>
        </div>
        <div class="jx-toolbar-field jx-toolbar-grow">
          <span class="jx-ico" aria-hidden="true">搜</span>
          <el-input v-model="topologyStore.keyword" class="jx-search" placeholder="设备搜索条件" clearable />
        </div>
        <div class="jx-toolbar-actions">
          <el-dropdown trigger="click" @command="onProtocolMenuCommand">
            <button type="button" class="jx-protocol-menu-btn" :disabled="importing">
              协议
              <svg class="jx-protocol-menu-caret" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="import" :disabled="importing">导入协议</el-dropdown-item>
                <el-dropdown-item command="export">导出协议</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <div class="jx-board-view-bar">
        <div class="jx-view-toggle" role="group" aria-label="视图切换">
          <button
            type="button"
            class="jx-view-toggle-btn"
            :class="{ 'is-on': boardViewMode === 'topology' }"
            @click="setBoardViewMode('topology')"
          >
            拓扑
          </button>
          <button
            type="button"
            class="jx-view-toggle-btn"
            :class="{ 'is-on': boardViewMode === 'list' }"
            @click="setBoardViewMode('list')"
          >
            列表
          </button>
        </div>
      </div>

      <section v-if="boardViewMode === 'topology'" class="jx-board">
        <el-tooltip content="添加桩" placement="left">
          <button
            type="button"
            class="jx-add-plus jx-add-plus--float"
            aria-label="添加桩"
            @click="openAddDialog"
          >
            +
          </button>
        </el-tooltip>
        <div ref="topologyBoardRef" class="jx-board-topology-scroll">
        <div class="jx-board-topology-inner">
        <div class="jx-hub-wrap">
          <div class="jx-hub" aria-label="协议根节点">
            <span class="jx-hub-cap">{{ protocolLabel }}</span>
          </div>
        </div>

        <div class="jx-main-link" aria-hidden="true" />

        <div class="jx-topology-stack">
          <div
            v-for="(row, rowIndex) in topologyLayoutRows"
            :key="`topology-row-${rowIndex}`"
            class="jx-topology-row-block"
            :class="{ 'is-scroll': row.layout.needsScroll }"
            :style="row.rowStyle"
          >
          <div class="jx-topology">
            <div class="jx-bus-line" aria-hidden="true" />
            <div class="jx-pile-row">
          <div
            v-for="pile in row.piles"
            :key="pile.pileId"
            class="jx-pile-col"
            :style="{ width: `${pileColumnWidth(pile.guns.length)}px` }"
          >
            <div class="jx-drop-up" aria-hidden="true" />
            <div class="jx-pile-id-top">{{ pile.pileId }}</div>
            <div class="jx-pile-wrap">
              <div class="jx-pile-left-info">
              <JxRatePopover
                :pile="pile"
                :has-tariff-model="hasTariffModel"
                :format-rate="formatRate"
                :period-range-text="periodRangeText"
                :get-current-tariff-period-index="getCurrentTariffPeriodIndex"
                :tariff-type-label="tariffTypeLabel"
              />
              <button
                v-if="pile.onlineState === 'offline'"
                type="button"
                class="jx-link-indicator jx-link-indicator--click"
                :class="[
                  `is-${pile.onlineState ?? 'offline'}`,
                  { 'jx-link-indicator--busy': loginExecuting && loginExecutingPileId === pile.pileId },
                ]"
                :disabled="loginExecuting"
                title="点击发起链接登录"
                aria-label="点击发起链接登录"
                @click.stop="onPileLinkIndicatorClick(pile.pileId)"
              >
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                  <path d="M10 14 7.5 16.5a3 3 0 1 1-4.2-4.2L6 9.6M14 10l2.5-2.5a3 3 0 0 1 4.2 4.2L18 14.4M4 4l16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
              </button>
              <span
                v-else
                class="jx-link-indicator"
                :class="`is-${pile.onlineState ?? 'offline'}`"
                :title="linkStateLabel(pile.onlineState)"
              >
                <svg v-if="pile.onlineState === 'online'" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                  <path d="M10 14 7.5 16.5a3 3 0 1 1-4.2-4.2L6 9.6M14 10l2.5-2.5a3 3 0 0 1 4.2 4.2L18 14.4M8.5 15.5l7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
                <svg v-else viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                  <path d="M10 14 7.5 16.5a3 3 0 1 1-4.2-4.2L6 9.6M14 10l2.5-2.5a3 3 0 0 1 4.2 4.2L18 14.4M4 4l16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
              </span>
            </div>
              <el-tooltip content="删除桩" placement="top">
                <button
                  type="button"
                  class="jx-pile-remove"
                  :class="{ 'is-disabled': pile.onlineState !== 'offline' }"
                  aria-label="删除桩"
                  @click.stop="removePile(pile.pileId)"
                >
                  -
                </button>
              </el-tooltip>
              <button
                type="button"
                class="jx-pile-btn"
                :class="{ 'is-active': topologyStore.activePileId === pile.pileId }"
                :title="pile.onlineState === 'offline' ? '双击发起链接登录' : '当前已连接'"
                @click="topologyStore.setActivePile(pile.pileId)"
                @dblclick="runLoginFlowByPile(pile.pileId)"
              >
                <img class="jx-pile-art" :src="chargePileSvg" alt="充电桩" />
              </button>
            </div>
          </div>
            </div>
          </div>

        <div class="jx-car-strip">
          <div
            v-for="pile in row.piles"
            :key="`car-${pile.pileId}`"
            class="jx-car-slot"
            :style="{ width: `${pileColumnWidth(pile.guns.length)}px` }"
          >
            <div class="jx-gun-cluster" :class="`is-gun-count-${Math.min(pile.guns.length, 4)}`">
              <div class="jx-car-bus-wrap" aria-hidden="true">
                <div class="jx-car-bus-drop" />
              </div>
              <div class="jx-gun-list">
                <div v-if="pile.guns.length > 1" class="jx-car-bus-line" aria-hidden="true" />
                <div v-for="gun in pile.guns" :key="`${pile.pileId}-${gun.gunId}`" class="jx-gun-row">
                  <div class="jx-car-line" aria-hidden="true" />
                  <div class="jx-gun-item">
                    <span class="jx-gun-id">{{ gunLabel(pile.pileId, gun.gunId) }}</span>
                    <span class="jx-gun-status" :class="[pile.onlineState === 'online' ? `is-${gun.status}` : 'is-unknown']">{{ gunStatusForPile(pile.onlineState, gun.status) }}</span>
                  </div>
                  <button
                    type="button"
                    class="jx-car-btn"
                    :class="{ 'is-virtual': isVirtualCar(pile.pileId, gun.gunId) }"
                    :data-vin-anchor="`${pile.pileId}-${gun.gunId}`"
                    @click="handleCarClick(pile.pileId, gun.gunId)"
                  >
                    <svg
                      v-if="isVirtualCar(pile.pileId, gun.gunId)"
                      class="jx-car-art jx-car-art-dashed"
                      viewBox="0 0 420 160"
                      aria-hidden="true"
                    >
                      <path
                        d="M15 120c4-4 6-10 8-16 7-25 35-34 76-34h37c20 0 30-4 42-14l12-10c15-12 31-18 52-18h57c28 0 44 5 63 16l45 24c9 5 13 11 13 20v23c0 6-5 11-11 11h-17"
                      />
                      <path d="M130 56 162 32c10-8 23-12 36-12h68c13 0 26 3 38 9l34 18c6 3 4 12-3 12H133c-6 0-8-6-3-9Z" />
                      <path d="M108 118h166" />
                      <circle cx="90" cy="118" r="30" />
                      <circle cx="315" cy="118" r="30" />
                    </svg>
                    <img v-else class="jx-car-art" :src="carSvg" alt="车辆" />
                    <span
                      v-if="pile.onlineState === 'online' && gun.status !== 'idle' && !isVirtualCar(pile.pileId, gun.gunId)"
                      class="jx-car-qr-icon"
                      title="启动控制"
                      aria-label="启动控制"
                      @click.stop="openStartControlDialog(pile.pileId, gun.gunId)"
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                        <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z" fill="currentColor" />
                      </svg>
                    </span>
                  </button>
                  <div
                    v-if="pile.onlineState === 'online' && gun.status !== 'idle'"
                    class="jx-car-hud"
                    :class="{ 'is-charging': gunHudCharging(gun) }"
                  >
                    <div class="jx-hud-cell">
                      <svg class="jx-hud-ico" viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M13 2L4 14h7l-1 8 10-14h-7l0-6z"
                          fill="currentColor"
                        />
                      </svg>
                      <span class="jx-hud-val jx-hud-val--soc">{{ gunHudSocDisplay(pile, gun.gunId, gun) }}</span>
                    </div>
                    <div class="jx-hud-cell">
                      <svg class="jx-hud-ico" viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="6" y="7" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6" />
                        <path d="M9 18v2h6v-2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                        <path d="M11 5h2v3h-2z" fill="currentColor" />
                      </svg>
                      <span class="jx-hud-val">{{ gunHudEnergyLine(pile, gun.gunId, gun) }}</span>
                    </div>
                    <div class="jx-hud-cell">
                      <svg class="jx-hud-ico" viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M12 5v14M9 8h4.5a2.5 2.5 0 0 1 0 5H9m6-5H14a2.5 2.5 0 0 0 0 5h1"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.5"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        />
                      </svg>
                      <span class="jx-hud-val">{{ gunHudAmountLine(pile, gun.gunId, gun) }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        </div>
        </div>

        <div v-if="hiddenPileCount > 0" class="jx-hidden-tip">已折叠 {{ hiddenPileCount }} 个桩</div>
        </div>
        </div>

      </section>

      <section v-else class="jx-board jx-board--list">
        <JxBoardList
          :piles="visiblePiles"
          :active-pile-id="topologyStore.activePileId"
          :hidden-pile-count="hiddenPileCount"
          :login-executing="loginExecuting"
          :login-executing-pile-id="loginExecutingPileId"
          :disconnecting="disconnecting"
          :vin-visible="vinEdit.visible"
          :vin-pile-id="vinEdit.pileId"
          :vin-gun-id="vinEdit.gunId"
          :vin-draft="vinForm.vin"
          :has-tariff-model="hasTariffModel"
          :link-state-label="linkStateLabel"
          :format-rate="formatRate"
          :period-range-text="periodRangeText"
          :get-current-tariff-period-index="getCurrentTariffPeriodIndex"
          :tariff-type-label="tariffTypeLabel"
          @select-pile="topologyStore.setActivePile"
          @dblclick-pile="runLoginFlowByPile"
          @add-pile="openAddDialog"
          @link-login="onPileLinkIndicatorClick"
          @link-disconnect="disconnectPileById"
          @car-click="handleCarClick"
          @start-control="openStartControlDialog"
          @vin-close="closeVinEditor"
          @vin-confirm="confirmLinkCar"
          @update:vin-draft="(v) => (vinForm.vin = v)"
        />
      </section>

      <aside
        v-if="drawerVisible"
        class="jx-panel"
        :class="{ 'jx-panel--list-mode': boardViewMode === 'list' }"
        :style="boardViewMode === 'topology' ? { left: drawerLeftStyle } : undefined"
      >
        <div class="jx-panel-tabs">
          <button type="button" class="jx-tab" :class="{ 'is-on': drawerTab === 'basic' }" @click="drawerTab = 'basic'">桩基本信息</button>
          <button type="button" class="jx-tab" :class="{ 'is-on': drawerTab === 'control' }" @click="drawerTab = 'control'">桩控制</button>
          <button type="button" class="jx-tab" :class="{ 'is-on': drawerTab === 'orders' }" @click="drawerTab = 'orders'">桩订单</button>
          <button type="button" class="jx-tab" :class="{ 'is-on': drawerTab === 'logs' }" @click="drawerTab = 'logs'">日志</button>
          <button type="button" class="jx-panel-close" aria-label="关闭" @click="closeDrawer">×</button>
        </div>

        <div v-show="drawerTab === 'basic'" class="jx-panel-body">
          <el-descriptions :column="1" border size="small" class="jx-basic-desc">
            <template #extra>
              <button
                type="button"
                class="jx-inline-edit-btn"
                :disabled="!basicEditing && topologyStore.activePile?.onlineState !== 'offline'"
                :aria-label="basicEditing ? '保存基本信息' : '编辑基本信息'"
                @click="toggleBasicEdit"
              >
                <svg v-if="!basicEditing" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                  <path
                    d="M4 20h4l10-10-4-4L4 16v4Zm13.7-11.3a1 1 0 0 0 0-1.4l-1-1a1 1 0 0 0-1.4 0l-.9.9 4 4 .3-.3Z"
                    fill="currentColor"
                  />
                </svg>
                <svg v-else viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </template>
            <el-descriptions-item label="桩号">
              <el-input
                v-if="basicEditing"
                v-model="basicForm.pileId"
                size="small"
                class="jx-basic-inline-input"
                @keyup.enter="saveBasicInfo"
              />
              <span v-else>{{ topologyStore.activePile?.pileId }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="在线状态">{{ statusPillLabel(topologyStore.activePile?.onlineState) }}</el-descriptions-item>
            <el-descriptions-item label="TCP地址">
              <el-input
                v-if="basicEditing"
                v-model="basicForm.tcpHost"
                size="small"
                class="jx-basic-inline-input"
                @keyup.enter="saveBasicInfo"
              />
              <span v-else>{{ topologyStore.activePile?.tcpHost }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="TCP端口">
              <el-input-number
                v-if="basicEditing"
                v-model="basicForm.tcpPort"
                :min="1"
                :max="65535"
                size="small"
                controls-position="right"
                class="jx-basic-inline-input"
              />
              <span v-else>{{ topologyStore.activePile?.tcpPort }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="桩功率(kW)">
              <el-input-number
                v-if="basicEditing"
                v-model="basicForm.pilePowerKw"
                :min="1"
                :max="2000"
                size="small"
                controls-position="right"
                class="jx-basic-inline-input"
              />
              <span v-else>{{ topologyStore.activePile?.pilePowerKw ?? '-' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="枪数量">{{ topologyStore.activePile?.guns.length }}</el-descriptions-item>
            <el-descriptions-item label="协议">{{ topologyStore.activePile?.protocolId }}</el-descriptions-item>
          </el-descriptions>
          <div class="jx-gun-detail">
            <div class="jx-gun-detail-title">枪信息</div>
            <table class="jx-gun-table">
              <thead>
                <tr>
                  <th>编号</th>
                  <th>状态</th>
                  <th>链接车辆(VIN)</th>
                  <th>车辆SOC</th>
                  <th>启动控制</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="g in topologyStore.activePile?.guns ?? []" :key="g.gunId">
                  <td>{{ gunLabel(topologyStore.activePile?.pileId ?? '', g.gunId) }}</td>
                  <td>{{ gunStatusForPile(topologyStore.activePile?.onlineState, g.status) }}</td>
                  <td>{{ g.vin || '-' }}</td>
                  <td>{{ gunSocLabel(g.soc) }}</td>
                  <td>
                    <button
                      v-if="topologyStore.activePileId && topologyStore.activePile?.onlineState === 'online'"
                      type="button"
                      class="jx-qr-view-btn"
                      @click="openStartControlDialog(topologyStore.activePileId, g.gunId)"
                      title="启动控制"
                    >
                      启动控制
                    </button>
                    <span v-else class="jx-qr-none">-</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="jx-gun-detail">
            <div class="jx-gun-detail-title">当前费率信息</div>
            <table class="jx-gun-table">
              <thead>
                <tr>
                  <th>时段</th>
                  <th>类型</th>
                  <th>电价费率</th>
                  <th>服务费率</th>
                </tr>
              </thead>
              <tbody v-if="activeTariffPeriods.length > 0">
                <tr v-for="(tp, idx) in activeTariffPeriods" :key="`active-rate-${idx}`">
                  <td class="jx-rate-time-cell">
                    {{ periodRangeText(activeTariffPeriods, idx) }}
                    <span
                      v-if="topologyStore.activePile && idx === getCurrentTariffPeriodIndex(topologyStore.activePile)"
                      class="jx-current-tag"
                    >
                      当前
                    </span>
                  </td>
                  <td>{{ tariffTypeLabel(tp.type) }}</td>
                  <td>{{ formatRate(tp.electricRate) }}</td>
                  <td>{{ formatRate(tp.serviceRate) }}</td>
                </tr>
              </tbody>
              <tbody v-else>
                <tr>
                  <td colspan="4">暂无费率数据</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-show="drawerTab === 'control'" class="jx-panel-body jx-control-only">
          <el-select v-model="selectedFlowId" class="!w-full" placeholder="选择流程" size="small">
            <el-option v-for="f in selectableFlowTemplates" :key="f.flowId" :label="`${f.name}`" :value="f.flowId" />
          </el-select>
          <div v-if="activeFlow" class="jx-hint-box">
            <div class="jx-hint-title">
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4" />
                <path d="M8 7.2v3.8M8 5.2v.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              </svg>
              <span>说明</span>
            </div>
            <div>依赖：{{ activeFlow.requiresCommands.join(' ') }}</div>
            <div>
              可用性：{{ flowSupportMap.get(activeFlow.flowId)?.support ?? 'supported' }}
              <span class="jx-err">{{ flowSupportMap.get(activeFlow.flowId)?.reason ?? '' }}</span>
            </div>
          </div>

          <div v-if="selectedFlowId === 'login-auth'" class="jx-control-form jx-login-grid">
            <div class="jx-form-row">
              <span class="jx-form-label">心跳超时次数</span>
              <el-input-number
                v-model="loginConfig.allowTimeoutCount"
                :min="1"
                :max="20"
                size="small"
                controls-position="right"
                class="jx-form-control"
              />
            </div>
            <div class="jx-form-row">
              <span class="jx-form-label">心跳周期(s)</span>
              <el-input-number
                v-model="loginConfig.heartbeatIntervalSec"
                :min="1"
                :max="300"
                size="small"
                controls-position="right"
                class="jx-form-control"
              />
            </div>
            <div class="jx-form-row">
              <span class="jx-form-label">遥信(0x09)周期(s)</span>
              <el-input-number
                v-model="loginConfig.teleSignalPeriodSec"
                :min="1"
                :max="300"
                size="small"
                controls-position="right"
                class="jx-form-control"
              />
            </div>
            <div class="jx-form-row">
              <span class="jx-form-label">遥测(0x0A)周期(s)</span>
              <el-input-number
                v-model="loginConfig.telemetryPeriodSec"
                :min="1"
                :max="300"
                size="small"
                controls-position="right"
                class="jx-form-control"
              />
            </div>
            <div class="jx-form-row">
              <span class="jx-form-label">工作信息(0x25)周期(s)</span>
              <el-input-number
                v-model="loginConfig.workInfoPeriodSec"
                :min="1"
                :max="300"
                size="small"
                controls-position="right"
                class="jx-form-control"
              />
            </div>
            <div class="jx-form-row jx-form-row-abnormal-sim">
              <span class="jx-form-label">异常模拟配置</span>
              <el-select
                v-model="loginConfig.abnormalSim"
                class="jx-form-control"
                size="small"
                clearable
                placeholder="无"
              >
                <el-option label="无" value="" />
                <el-option label="时差过大" value="time_skew_large" />
              </el-select>
            </div>
            <div class="jx-login-actions">
              <el-button
                v-if="!activePileOnline"
                type="success"
                class="jx-run"
                :loading="loginExecuting"
                @click="onControlPanelLoginClick"
              >
                {{ loginExecuting ? '登录中...' : '登录' }}
              </el-button>
              <el-button v-else class="jx-run" :loading="disconnecting" @click="disconnectActivePile">断开链接</el-button>
            </div>
          </div>

          <div v-else-if="selectedFlowId === 'scan-qr-vin-start'" class="jx-control-form">
            <p class="jx-flow-hint">
              用户扫码后平台下发 <code>0x59</code>，模拟器回复 <code>0x5B</code> 并创建订单；成功后自动发送带订单号的
              <code>0x40</code>，鉴权通过后与 VIN 启动一致（<code>0x21</code>→<code>0x22</code>）。与「扫码远程启动流程」（<code>0x1F</code>）互斥：请在本流程与远程扫码流程中二选一。
            </p>
            <div class="jx-form-row">
              <span class="jx-form-label">0x5B 回复失败</span>
              <el-checkbox v-model="scanQrVinStartConfig.simulate5bFail">模拟 0x5B 失败（订单标记启动失败并结束）</el-checkbox>
            </div>
            <div class="jx-form-row">
              <span class="jx-form-label">0x5B 失败原因</span>
              <el-select
                v-model="scanQrVinStartConfig.reply5bFailReason"
                size="small"
                class="jx-form-control"
                :disabled="!scanQrVinStartConfig.simulate5bFail"
              >
                <el-option :value="1" label="设备故障" />
                <el-option :value="2" label="充电枪使用中" />
                <el-option :value="3" label="枪未连接车辆" />
                <el-option :value="4" label="枪口超范围" />
                <el-option :value="5" label="参数不支持" />
                <el-option :value="6" label="其它" />
              </el-select>
            </div>
          </div>

          <div v-else-if="isCardStartFlowSelected" class="jx-control-form">
            <p class="jx-flow-hint">
              桩上送 <code>0x19</code> 卡鉴权，平台回复 <code>0x1A</code>；允许充电（标志=1）时以
              <code>0x1A</code> 订单号创建卡启动订单，随后上送 <code>0x21</code> 并等待 <code>0x22</code>。可在车辆「启动控制」中手动输入卡号触发
              <code>0x19</code>。
            </p>
            <div class="jx-form-row">
              <span class="jx-form-label">0x21 启动结果</span>
              <el-select v-model="remoteStartConfig.startResult" size="small" class="jx-form-control">
                <el-option :value="1" label="成功" />
                <el-option :value="2" label="失败" />
              </el-select>
            </div>
            <div class="jx-form-row">
              <span class="jx-form-label">0x21 失败原因</span>
              <el-select
                v-model="remoteStartConfig.failReason"
                size="small"
                class="jx-form-control"
                :disabled="remoteStartConfig.startResult === 1"
              >
                <el-option :value="0" label="无" />
                <el-option :value="1" label="设备故障" />
                <el-option :value="2" label="充电枪使用中" />
                <el-option :value="3" label="枪未连接车辆" />
                <el-option :value="4" label="枪口超范围" />
                <el-option :value="5" label="参数不支持" />
                <el-option :value="6" label="其它" />
              </el-select>
            </div>
          </div>

          <div v-else-if="isRemoteStartFlowSelected" class="jx-control-form">
            <p v-if="selectedFlowId === 'scan-qr-remote-start'" class="jx-flow-hint">
              用户扫描登录下发的枪二维码后，平台下发 <code>0x1F</code>；模拟器自动回复 <code>0x20</code>、上送 <code>0x21</code> 并等待 <code>0x22</code>。下方配置影响 <code>0x21</code> 启动结果。
            </p>
            <p v-else class="jx-flow-hint">
              平台主动下发 <code>0x1F</code> 时走本流程；若由 APP 扫码触发，也可选用「扫码远程启动流程」以便与 <code>0x59</code> VIN 扫码区分。
            </p>
            <div class="jx-form-row">
              <span class="jx-form-label">启动结果</span>
              <el-select v-model="remoteStartConfig.startResult" size="small" class="jx-form-control">
                <el-option :value="1" label="成功" />
                <el-option :value="2" label="失败" />
              </el-select>
            </div>
            <div class="jx-form-row">
              <span class="jx-form-label">失败原因</span>
              <el-select v-model="remoteStartConfig.failReason" size="small" class="jx-form-control" :disabled="remoteStartConfig.startResult === 1">
                <el-option :value="0" label="无" />
                <el-option :value="1" label="设备故障" />
                <el-option :value="2" label="充电枪使用中" />
                <el-option :value="3" label="枪未连接车辆" />
                <el-option :value="4" label="枪口超范围" />
                <el-option :value="5" label="参数不支持" />
                <el-option :value="6" label="其它" />
              </el-select>
            </div>
            <div class="jx-form-row">
              <span class="jx-form-label">充电模型选择</span>
              <el-select v-model="remoteStartConfig.chargeModelId" size="small" class="jx-form-control">
                <el-option value="builtin-default" label="内置充电模型（默认）" />
              </el-select>
            </div>
            <div class="jx-form-row">
              <span class="jx-form-label">停充金额阈值(元)</span>
              <el-input-number
                v-model="remoteStartConfig.stopAmountThreshold"
                :min="0"
                :max="100000"
                :step="0.1"
                size="small"
                controls-position="right"
                class="jx-form-control"
              />
            </div>
          </div>

          <div v-else class="jx-control-form">
            <div class="jx-form-row">
              <span class="jx-form-label">枪号</span>
              <el-input v-model="flowParams.gunNo" size="small" placeholder="00" class="jx-form-control" />
            </div>
            <div class="jx-form-row">
              <span class="jx-form-label">订单号</span>
              <el-input v-model="flowParams.orderNo" size="small" placeholder="订单号" class="jx-form-control" />
            </div>
            <div class="jx-form-row">
              <span class="jx-form-label">VIN</span>
              <el-input v-model="flowParams.vin" size="small" placeholder="VIN，可为空" class="jx-form-control" />
            </div>
            <el-button type="primary" class="jx-run" :loading="executing" @click="runFlow">开始模拟</el-button>
          </div>

        </div>

        <div v-show="drawerTab === 'orders'" class="jx-panel-body jx-orders-body">
          <div class="jx-log-bar">
            <el-input v-model="orderKeyword" size="small" placeholder="按订单号查询" clearable class="jx-log-search" />
          </div>
          <div class="jx-orders-scroll">
            <table class="jx-gun-table jx-order-table">
              <thead>
                <tr>
                  <th>订单号</th>
                  <th>用户类型</th>
                  <th>枪号</th>
                  <th>启动类型</th>
                  <th>启动参数</th>
                  <th>启动时间</th>
                  <th>状态</th>
                <th>推送状态</th>
                  <th>费率类型</th>
                  <th>订单费率</th>
                  <th>失败原因</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="o in activePileOrders" :key="o.orderNo">
                  <td>{{ o.orderNo }}</td>
                  <td>{{ o.request23?.userType != null ? o.request23.userType : '-' }}</td>
                  <td>{{ gunLabel(o.pileId, o.gunId) }}</td>
                  <td>{{ orderStartTypeLabel(o.startType) }}</td>
                  <td>{{ o.startParam }}</td>
                  <td>{{ new Date(o.startAt).toLocaleString() }}</td>
                  <td>{{ orderStatusLabel(o.status, o.failReasonText) }}</td>
                  <td>{{ o.delivery?.status === 'delivered' ? '已送达' : (o.delivery?.pushed ? '未送达' : '未推送') }}</td>
                  <td>{{ orderTariffTypeLabel(o) }}</td>
                  <td>
                    <el-button
                      v-if="orderTariffViewable(o)"
                      link
                      type="primary"
                      size="small"
                      @click="openOrderTariffView(o.orderNo)"
                    >
                      查看
                    </el-button>
                    <span v-else>—</span>
                  </td>
                  <td>{{ o.failReasonText || '-' }}</td>
                  <td>
                    <el-button link type="primary" size="small" @click="openOrderDetail(o.orderNo)">详情</el-button>
                    <el-button link type="danger" size="small" @click="removeOrder(o.orderNo)">删除</el-button>
                    <el-button
                      v-if="showForceOrderAction(o) && topologyStore.activePileId"
                      link
                      type="warning"
                      size="small"
                      @click="forceStopOrder(o.orderNo)"
                    >
                      {{ forceOrderActionLabel(topologyStore.activePileId, o.orderNo) }}
                    </el-button>
                  </td>
                </tr>
                <tr v-if="activePileOrders.length === 0">
                  <td colspan="12">暂无订单</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-show="drawerTab === 'logs'" class="jx-panel-body jx-logs-body">
          <div class="jx-log-bar">
            <el-input v-model="logKeyword" size="small" placeholder="搜索日志内容" clearable class="jx-log-search" />
            <el-select v-model="logStore.directionFilter" size="small" class="!w-[76px]">
              <el-option value="all" label="全部" />
              <el-option value="send" label="发送" />
              <el-option value="receive" label="接收" />
            </el-select>
          </div>
          <div class="jx-log-scroll">
            <details v-for="x in visibleLogs" :key="x.id" class="jx-log-item">
              <summary>
                <span class="jx-log-summary-main">
                  {{ new Date(x.t).toLocaleTimeString() }} · {{ x.command }} ·
                  <span class="jx-log-direction" :class="`is-${x.direction}`">
                    {{ x.direction === 'send' ? '发送' : '接收' }}
                  </span>
                </span>
                <span v-if="tcpActionLabel(x)" class="jx-tcp-tag" :class="tcpActionClass(x)">{{ tcpActionLabel(x) }}</span>
                <span class="jx-log-summary-right" @click.stop>
                  <button
                    type="button"
                    class="jx-log-copy-icon"
                    title="复制当前格式日志"
                    aria-label="复制当前格式日志"
                    @click.stop="copyLogByCurrentMode(x)"
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                      <path d="M9 9h10v12H9zM5 3h10v4H9v10H5z" fill="currentColor" />
                    </svg>
                  </button>
                  <el-radio-group
                    :model-value="logViewMode(x.id)"
                    size="small"
                    @update:model-value="(v: 'raw' | 'structured') => setLogViewMode(x.id, v)"
                    @click.stop
                  >
                    <el-radio-button value="raw">原数据</el-radio-button>
                    <el-radio-button value="structured">结构数据</el-radio-button>
                  </el-radio-group>
                </span>
              </summary>
              <div class="jx-log-ip">远端IP：{{ x.remoteIp }}</div>
              <pre v-if="logViewMode(x.id) === 'raw'" class="jx-log-pre">{{ x.rawHex }}</pre>
              <template v-else>
                <table v-if="logFieldRows(x).length > 0" class="jx-log-field-table">
                  <thead>
                    <tr>
                      <th>字段名</th>
                      <th>字段值</th>
                      <th>值解释</th>
                      <th>字段说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in logFieldRows(x)" :key="row.key">
                      <td>{{ row.name }}</td>
                      <td>
                        <el-tooltip
                          v-if="row.raw.length > 100"
                          :content="row.raw"
                          placement="top"
                          effect="dark"
                        >
                          <span class="jx-log-field-value">{{ truncateLogFieldValue(row.raw, 100) }}</span>
                        </el-tooltip>
                        <span v-else class="jx-log-field-value">{{ row.raw }}</span>
                      </td>
                      <td>
                        <el-tooltip
                          v-if="row.meaning.length > 200"
                          :content="row.meaning"
                          placement="top"
                          effect="dark"
                        >
                          <span class="jx-log-field-meaning">{{ truncateLogMeaningValue(row.meaning, 200) }}</span>
                        </el-tooltip>
                        <span v-else class="jx-log-field-meaning">{{ row.meaning }}</span>
                      </td>
                      <td>{{ row.desc }}</td>
                    </tr>
                  </tbody>
                </table>
                <pre v-else class="jx-log-pre">{{ x.structured ? JSON.stringify(x.structured, null, 2) : '当前日志无结构化数据' }}</pre>
              </template>
            </details>
          </div>
        </div>
      </aside>

      <el-dialog v-model="addDialogVisible" title="创建充电桩" width="460px" destroy-on-close>
        <el-form label-width="110px">
          <el-form-item label="桩号">
            <el-input v-model="addForm.pileId" placeholder="例如 001" />
          </el-form-item>
          <el-form-item label="TCP链接地址">
            <el-input v-model="addForm.tcpHost" placeholder="127.0.0.1" />
          </el-form-item>
          <el-form-item label="端口">
            <el-input-number v-model="addForm.tcpPort" :min="1" :max="65535" controls-position="right" />
          </el-form-item>
          <el-form-item label="桩功率(kW)">
            <el-input-number v-model="addForm.pilePowerKw" :min="1" :max="2000" controls-position="right" />
          </el-form-item>
          <el-form-item label="枪数量(最大4)">
            <el-input-number v-model="addForm.gunCount" :min="1" :max="4" controls-position="right" />
          </el-form-item>
          <el-form-item label="协议">
            <el-select v-model="addForm.protocolId" class="!w-full">
              <el-option
                v-for="p in protocolStore.protocols"
                :key="p.protocolId"
                :label="`${p.protocolName} (${p.version})`"
                :value="p.protocolId"
                :disabled="!protocolStore.isJxProtocolSelectable(p.protocolId)"
              />
            </el-select>
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="addDialogVisible = false">取消</el-button>
          <el-button type="primary" @click="confirmAddPile">创建</el-button>
        </template>
      </el-dialog>

      <el-dialog
        v-model="qrDialogVisible"
        :title="qrDialogTitle"
        width="420px"
        class="jx-start-control-dialog"
        destroy-on-close
        @closed="onQrDialogClosed"
      >
        <div v-if="qrDialogPileId && qrDialogGunId" class="jx-start-control-inner">
          <div class="jx-start-panel-viewport">
            <Transition :name="qrDialogPanelTransition">
              <div v-if="qrDialogPanel === 'start'" key="start-panel" class="jx-start-panel-stack">
          <el-tabs v-model="qrDialogTab" class="jx-start-tabs">
            <el-tab-pane label="扫码启动" name="scan">
              <div class="jx-start-pane">
                <div class="jx-start-meta-line">
                  <span class="jx-start-meta-k">枪号</span>
                  <span class="jx-start-meta-v">{{ startControlGunLabel }}</span>
                </div>
                <div v-if="qrDialogImgUrl" class="jx-start-qr-preview">
                  <img class="jx-start-qr-img" :src="qrDialogImgUrl" alt="充电枪二维码" />
                </div>
                <div v-else class="jx-start-qr-placeholder">
                  {{ qrDialogLoading ? '正在生成二维码…' : qrDialogText ? '未生成' : '暂无二维码，请确认登录后已下发枪二维码' }}
                </div>
                <p class="jx-start-scan-hint">
                  扫码后平台通常下发 <code>0x1F</code>（账户/卡启动）或 <code>0x59</code>（VIN 启动）。请在侧栏流程控制中选择
                  <strong>「扫码远程启动流程」</strong>或 <strong>「扫码VIN启动流程」</strong> 之一，并配置对应应答。
                </p>
              </div>
            </el-tab-pane>
            <el-tab-pane label="VIN启动" name="vin">
              <div class="jx-start-pane">
                <div class="jx-start-meta-line">
                  <span class="jx-start-meta-k">枪号</span>
                  <span class="jx-start-meta-v">{{ startControlGunLabel }}</span>
                </div>
                <div class="jx-start-vin-block">
                  <span class="jx-start-meta-k">车辆VIN</span>
                  <template v-if="!startControlVinEditing">
                    <span class="jx-start-vin-text">{{ startControlVinDraft || '—' }}</span>
                    <button
                      type="button"
                      class="jx-start-vin-edit-btn"
                      title="编辑VIN"
                      aria-label="编辑VIN"
                      @click="startControlVinEditing = true"
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                        <path
                          d="M4 16.5V20h3.5L17.5 10 14 6.5 4 16.5zm14-9-3-3 1.5-1.5a1 1 0 0 1 1.4 0l1.1 1.1a1 1 0 0 1 0 1.4L18 7.5z"
                          fill="currentColor"
                        />
                      </svg>
                    </button>
                  </template>
                  <template v-else>
                    <el-input
                      v-model="startControlVinDraft"
                      size="small"
                      class="jx-start-vin-input"
                      maxlength="17"
                      placeholder="输入VIN"
                      @keyup.enter="saveStartControlVinFromDialog"
                    />
                    <button
                      type="button"
                      class="jx-start-vin-save-btn"
                      title="保存"
                      aria-label="保存VIN"
                      @click="saveStartControlVinFromDialog"
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                        <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z" fill="currentColor" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="jx-start-vin-cancel-btn"
                      title="取消"
                      aria-label="取消编辑"
                      @click="cancelStartControlVinEdit"
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                        <path d="M18 6 6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                      </svg>
                    </button>
                  </template>
                </div>
                <el-button
                  type="primary"
                  class="jx-start-vin-launch-btn"
                  :loading="vinAuthBusy"
                  :disabled="vinAuthBusy"
                  @click="onVinAuthStartFromQr"
                >
                  {{ vinAuthBusy ? '启动中…' : 'VIN启动' }}
                </el-button>
              </div>
            </el-tab-pane>
            <el-tab-pane label="卡启动" name="card">
              <div class="jx-start-pane">
                <div class="jx-start-meta-line">
                  <span class="jx-start-meta-k">枪号</span>
                  <span class="jx-start-meta-v">{{ startControlGunLabel }}</span>
                </div>
                <div class="jx-start-vin-block">
                  <span class="jx-start-meta-k">卡号</span>
                  <el-input
                    v-model="startControlCardDraft"
                    size="small"
                    class="jx-start-vin-input"
                    maxlength="16"
                    placeholder="输入刷卡号（最多16位）"
                    @keyup.enter="onCardAuthStartFromDialog"
                  />
                </div>
                <p class="jx-start-scan-hint">
                  将上送 <code>0x19</code> 并等待平台 <code>0x1A</code>；允许充电后创建订单并上送
                  <code>0x21</code>。请在侧栏选择「卡启动流程」并配置 <code>0x21</code> 启动结果。
                </p>
                <el-button
                  type="primary"
                  class="jx-start-vin-launch-btn"
                  :loading="cardAuthBusy"
                  :disabled="cardAuthBusy"
                  @click="onCardAuthStartFromDialog"
                >
                  {{ cardAuthBusy ? '鉴权中…' : '卡启动' }}
                </el-button>
              </div>
            </el-tab-pane>
          </el-tabs>
          <div class="jx-start-disconnect-wrap">
            <el-tooltip content="断开车辆链接" placement="top">
              <button type="button" class="jx-start-disconnect-icon" aria-label="断开车辆链接" @click="disconnectFromQrDialog">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path
                    d="M10 14 7.5 16.5a3 3 0 1 1-4.2-4.2L6 9.6M14 10l2.5-2.5a3 3 0 0 1 4.2 4.2L18 14.4M4 4l16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </el-tooltip>
          </div>
              </div>
              <div v-else key="charging-panel" class="jx-start-panel-stack jx-charging-info-pane">
                <div class="jx-start-meta-line">
                  <span class="jx-start-meta-k">枪号</span>
                  <span class="jx-start-meta-v">{{ startControlGunLabel }}</span>
                </div>
                <div class="jx-charging-info-grid">
                  <div class="jx-charging-info-row">
                    <span class="jx-charging-info-k">充电订单号</span>
                    <span class="jx-charging-info-v jx-charging-info-mono">{{ chargingInfoLive.orderNo }}</span>
                  </div>
                  <div class="jx-charging-info-row">
                    <span class="jx-charging-info-k">启动方式</span>
                    <span class="jx-charging-info-v">{{ chargingInfoLive.startMethod }}</span>
                  </div>
                  <div class="jx-charging-info-row">
                    <span class="jx-charging-info-k">启动时间</span>
                    <span class="jx-charging-info-v">{{ chargingInfoLive.startTime }}</span>
                  </div>
                  <div class="jx-charging-info-row">
                    <span class="jx-charging-info-k">车辆 VIN</span>
                    <span class="jx-charging-info-v jx-charging-info-mono">{{ chargingInfoLive.vin }}</span>
                  </div>
                  <div v-if="chargingInfoLive.isCardStart" class="jx-charging-info-row">
                    <span class="jx-charging-info-k">卡号</span>
                    <span class="jx-charging-info-v jx-charging-info-mono">{{ chargingInfoLive.cardNo }}</span>
                  </div>
                </div>
                <div class="jx-charging-info-live-grid">
                  <div class="jx-charging-info-live-cell">
                    <span class="jx-charging-info-k">充电时长</span>
                    <span class="jx-charging-info-v jx-charging-info-live">{{ chargingInfoLive.durationText }}</span>
                  </div>
                  <div class="jx-charging-info-live-cell">
                    <span class="jx-charging-info-k">充电电量</span>
                    <span class="jx-charging-info-v jx-charging-info-live">{{ chargingInfoLive.energyText }}</span>
                  </div>
                  <div class="jx-charging-info-live-cell">
                    <span class="jx-charging-info-k">当前余额</span>
                    <span class="jx-charging-info-v jx-charging-info-live">{{ chargingInfoLive.balanceText }}</span>
                  </div>
                  <div class="jx-charging-info-live-cell">
                    <span class="jx-charging-info-k">当前功率</span>
                    <span class="jx-charging-info-v jx-charging-info-live">{{ chargingInfoLive.powerText }}</span>
                  </div>
                </div>
                <el-button
                  type="danger"
                  class="jx-charging-stop-btn"
                  :disabled="!startControlChargingOrder"
                  @click="forceStopFromQrDialog"
                >
                  停止充电
                </el-button>
              </div>
            </Transition>
          </div>
        </div>
      </el-dialog>

      <el-dialog v-model="orderDetailVisible" title="订单详情" width="920px" destroy-on-close>
        <el-tabs v-model="orderDetailTab">
          <el-tab-pane label="订单信息" name="info">
            <el-descriptions v-if="currentOrderDetail" :column="2" border size="small">
              <el-descriptions-item label="订单号">{{ currentOrderDetail.orderNo }}</el-descriptions-item>
              <el-descriptions-item label="枪号">{{ gunLabel(currentOrderDetail.pileId, currentOrderDetail.gunId) }}</el-descriptions-item>
              <el-descriptions-item label="状态">{{ orderStatusLabel(currentOrderDetail.status, currentOrderDetail.failReasonText) }}</el-descriptions-item>
              <el-descriptions-item label="启动类型">{{ orderStartTypeLabel(currentOrderDetail.startType) }}</el-descriptions-item>
              <el-descriptions-item label="用户ID">{{ currentOrderDetail.latest23?.userId || currentOrderDetail.request23?.userId || '-' }}</el-descriptions-item>
              <el-descriptions-item
                v-if="currentOrderDetail.startAuthSource === '0x19-card'"
                label="卡号"
              >
                {{ currentOrderDetail.request23?.userId || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="用户类型">{{ currentOrderDetail.latest23?.userType ?? currentOrderDetail.request23?.userType ?? '-' }}</el-descriptions-item>
              <el-descriptions-item label="组织机构">{{ currentOrderDetail.latest23?.orgCode || currentOrderDetail.request23?.orgCode || '-' }}</el-descriptions-item>
              <el-descriptions-item label="VIN">{{ currentOrderDetail.latest23?.vin || '-' }}</el-descriptions-item>
              <el-descriptions-item label="开始充电时间">{{ currentOrderDetail.latest23?.startTime || '-' }}</el-descriptions-item>
              <el-descriptions-item label="结束充电时间">{{ currentOrderDetail.latest23?.endTime || '-' }}</el-descriptions-item>
              <el-descriptions-item label="控制方式">{{ currentOrderDetail.latest23?.controlMode ?? currentOrderDetail.request23?.controlMode ?? '-' }}</el-descriptions-item>
              <el-descriptions-item label="控制参数">{{ currentOrderDetail.latest23?.controlParam ?? currentOrderDetail.request23?.controlParam ?? '-' }}</el-descriptions-item>
              <el-descriptions-item label="启动方式">{{ currentOrderDetail.latest23?.startMode ?? currentOrderDetail.request23?.startMode ?? '-' }}</el-descriptions-item>
              <el-descriptions-item label="定时启动时间">{{ currentOrderDetail.latest23?.scheduleStartTime || currentOrderDetail.request23?.scheduleStartTime || '-' }}</el-descriptions-item>
              <el-descriptions-item label="充电模式">{{ currentOrderDetail.latest23?.chargeMode ?? currentOrderDetail.request23?.chargeMode ?? '-' }}</el-descriptions-item>
              <el-descriptions-item label="停止充电原因">{{ currentOrderDetail.latest23?.stopReason ?? '-' }}</el-descriptions-item>
              <el-descriptions-item label="费率类型">{{ orderTariffTypeLabel(currentOrderDetail) }}</el-descriptions-item>
              <el-descriptions-item label="计费模型选择">{{ currentOrderDetail.latest23?.billingModelSelect ?? currentOrderDetail.request23?.billingModelSelect ?? '-' }}</el-descriptions-item>
              <el-descriptions-item label="计费模型版本">{{ currentOrderDetail.latest23?.modelVersion ?? '-' }}</el-descriptions-item>
              <el-descriptions-item label="电能费用(元)">{{ amountFenLabel(currentOrderDetail.latest23?.electricFee) }}</el-descriptions-item>
              <el-descriptions-item label="服务费费用(元)">{{ amountFenLabel(currentOrderDetail.latest23?.serviceFee) }}</el-descriptions-item>
              <el-descriptions-item label="停车费费用(元)">{{ amountFenLabel(currentOrderDetail.latest23?.parkFee) }}</el-descriptions-item>
            </el-descriptions>
            <div v-if="orderPeriodEnergyDisplayRows.length > 0" class="jx-gun-detail">
              <div class="jx-gun-detail-title">时段电量</div>
              <table class="jx-gun-table">
                <thead>
                  <tr>
                    <th>时段索引</th>
                    <th>时段电量(kWh)</th>
                    <th>起止时间</th>
                    <th>电费(元)</th>
                    <th>服务费(元)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(seg, idx) in orderPeriodEnergyDisplayRows" :key="`period-energy-${idx}`">
                    <td>{{ seg.modelIndex }}</td>
                    <td>{{ seg.energyKwh.toFixed(4) }}</td>
                    <td>
                      <template v-if="seg.startTime && seg.endTime">{{ seg.startTime }} ~ {{ seg.endTime }}</template>
                      <template v-else>—</template>
                    </td>
                    <td>{{ typeof seg.electricFeeYuan === 'number' ? seg.electricFeeYuan.toFixed(2) : '—' }}</td>
                    <td>{{ typeof seg.serviceFeeYuan === 'number' ? seg.serviceFeeYuan.toFixed(2) : '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else-if="currentOrderDetail" class="jx-rate-empty">暂无时段电量数据</div>
            <div v-else class="jx-rate-empty">暂无订单信息</div>
          </el-tab-pane>
          <el-tab-pane label="过程数据" name="process">
            <div class="jx-order-chart-title">0x25 充电关键信息趋势</div>
            <div ref="order25ChartRef" class="jx-order-chart" />
            <div class="jx-order-chart-title">0x30 BMS关键信息趋势</div>
            <div ref="order30ChartRef" class="jx-order-chart" />
          </el-tab-pane>
        </el-tabs>
      </el-dialog>

      <el-dialog v-model="orderTariffDialogVisible" title="订单费率" width="480px" destroy-on-close>
        <template v-if="orderTariffViewSnapshot">
          <div class="jx-rate-panel-head" style="margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 12px;">
            <span>费率类型：{{ orderTariffViewOrder ? orderTariffTypeLabel(orderTariffViewOrder) : '-' }}</span>
            <span>计费模型版本：{{ orderTariffViewSnapshot.version }}</span>
            <span>停车费率：{{ formatRate(orderTariffViewSnapshot.parkingRate) }}</span>
          </div>
          <table v-if="orderTariffViewSnapshot.periods.length > 0" class="jx-gun-table">
            <thead>
              <tr>
                <th>时段</th>
                <th>类型</th>
                <th>电价</th>
                <th>服务费</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(tp, idx) in orderTariffViewSnapshot.periods" :key="`order-tp-${idx}`">
                <td>{{ periodRangeText(orderTariffViewSnapshot.periods, idx) }}</td>
                <td>{{ tariffTypeLabel(tp.type) }}</td>
                <td>{{ formatRate(tp.electricRate) }}</td>
                <td>{{ formatRate(tp.serviceRate) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="jx-rate-empty">暂无时段数据</div>
          <p v-if="orderTariffViewOrder && !orderTariffViewOrder.tariffSnapshot" class="jx-rate-empty" style="margin-top: 8px;">
            费率副本将在枪启动成功（0x22）后生效
          </p>
        </template>
        <div v-else class="jx-rate-empty">暂无订单费率数据</div>
      </el-dialog>

    </div>

    <Teleport to="body">
      <div
        v-if="boardViewMode === 'topology' && vinEdit.visible"
        class="jx-vin-pop jx-vin-pop--fixed"
        :style="vinPopStyle"
      >
        <button type="button" class="jx-vin-close" aria-label="关闭" @click="closeVinEditor">×</button>
        <el-input
          v-model="vinForm.vin"
          size="small"
          placeholder="输入VIN"
          maxlength="20"
          @keyup.enter="confirmLinkCar"
        />
        <button
          type="button"
          class="jx-vin-icon-btn"
          aria-label="连接车辆"
          @click="confirmLinkCar"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M8 3v6M12 3v6M6 9h8v3a4 4 0 0 1-4 4H9v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style src="./jx-plugin-theme.css"></style>

<style scoped>
.jx-scope {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  font-family: system-ui, 'Segoe UI', sans-serif;
  color: var(--jx-text);
}

.jx-page { position: relative; display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 12px; overflow: hidden; }
.jx-toolbar { flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; border-radius: 8px; border: 1px solid var(--jx-border); background: var(--jx-chrome-bg); padding: 10px 12px; }
.jx-toolbar-field { display: flex; align-items: center; gap: 8px; }
.jx-toolbar-grow { flex: 1; min-width: 220px; }
.jx-ico { width: 32px; text-align: center; color: var(--jx-teal); font-size: 12px; }
.jx-select { width: 200px; }
.jx-search { flex: 1; }
.jx-toolbar-actions { margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.jx-board-view-bar {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-start;
  align-items: center;
  padding: 0 2px;
}
.jx-view-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px;
  border-radius: 999px;
  border: 1px solid var(--jx-accent-border);
  background: var(--jx-toggle-track);
}

.jx-view-toggle-btn {
  border: none;
  border-radius: 999px;
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--jx-muted);
  background: transparent;
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
}

.jx-view-toggle-btn:hover:not(.is-on) {
  color: var(--jx-text);
  background: var(--jx-accent-soft);
}

.jx-view-toggle-btn.is-on {
  color: var(--jx-toggle-active-fg);
  background: linear-gradient(180deg, color-mix(in oklab, var(--jx-brand) 92%, white 8%), color-mix(in oklab, var(--jx-brand) 72%, var(--um-brand-muted) 28%));
  box-shadow: 0 2px 8px color-mix(in oklab, var(--jx-brand) 28%, transparent);
}

.jx-view-toggle-btn:active {
  transform: scale(0.97);
}

.jx-protocol-menu-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--jx-muted);
  background: var(--jx-toggle-track);
  border: 1px solid var(--jx-accent-border);
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
}

.jx-protocol-menu-btn:hover:not(:disabled) {
  color: var(--jx-text);
  background: var(--jx-accent-soft);
}

.jx-protocol-menu-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.jx-protocol-menu-caret {
  opacity: 0.75;
}

.jx-mini-select { width: 112px; }

.jx-board {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border-radius: 10px;
  border: 1px solid var(--jx-border);
  background: radial-gradient(circle at 50% -20%, color-mix(in oklab, var(--jx-teal) 20%, transparent), transparent 60%), var(--jx-board-bg);
  padding: 20px 16px 16px;
}
.jx-board-topology-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  width: 100%;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.jx-board-topology-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
.jx-board-topology-inner { width: 100%; padding-bottom: 72px; box-sizing: border-box; }
.jx-topology-stack { width: 100%; }
.jx-topology-row-block {
  position: relative;
  margin-top: 4px;
  box-sizing: border-box;
}
.jx-topology-row-block + .jx-topology-row-block {
  margin-top: 28px;
}
.jx-topology-row-block.is-scroll {
  max-width: 100%;
}
.jx-board--list { padding: 12px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.jx-board--list :deep(.jx-board-list) { flex: 1; min-height: 0; height: 100%; }
.jx-hub-wrap { display: flex; justify-content: center; }
.jx-hub { display: flex; flex-direction: column; align-items: center; gap: 8px; padding-top: 8px; }
.jx-hub-cap { border-radius: 999px; background: var(--jx-surface); border: 1px solid var(--jx-border); padding: 4px 14px; font-size: 12px; color: var(--jx-muted); }
.jx-main-link { width: 2px; height: 28px; margin: 6px auto 0; border-radius: 999px; background: var(--jx-teal); }

.jx-topology { position: relative; width: 100%; box-sizing: border-box; }
.jx-bus-line { width: 100%; height: 2px; margin-bottom: 6px; border-radius: 999px; background: linear-gradient(to right, transparent 0, var(--jx-teal) 4%, var(--jx-teal) 96%, transparent 100%); }
.jx-pile-row {
  display: flex;
  flex-wrap: nowrap;
  align-items: flex-start;
  gap: var(--jx-row-gap, 5px);
  width: 100%;
  box-sizing: border-box;
}
.jx-topology-row-block.is-scroll .jx-pile-row {
  width: max-content;
}
.jx-add-plus {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: #22c55e;
  font-size: 28px;
  font-weight: 800;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.15s ease, filter 0.15s ease;
}

.jx-add-plus--float {
  position: absolute;
  right: 10px;
  top: 10px;
  z-index: 1;
  border-radius: 999px;
  background: color-mix(in oklab, var(--jx-surface) 82%, transparent);
  backdrop-filter: blur(4px);
}

.jx-add-plus--float:hover {
  transform: scale(1.08);
  filter: brightness(1.1);
}

.jx-add-plus.is-disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.jx-pile-col { display: flex; flex-direction: column; align-items: center; position: relative; flex-shrink: 0; }
.jx-drop-up { width: 2px; height: 22px; margin-bottom: 6px; background: var(--jx-teal); }
.jx-pile-id-top {
  font-size: 11px;
  font-weight: 700;
  text-align: center;
  line-height: 1.3;
  word-break: break-all;
  max-width: min(140px, 100%);
  margin-bottom: 4px;
}
.jx-pile-left-info {
  position: absolute;
  right: calc(50% + 34px);
  top: 6px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
}
.jx-link-indicator {
  width: 20px;
  height: 20px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}
.jx-link-indicator.is-offline { background: #7b8794; }
.jx-link-indicator.is-online { background: #22c55e; }
.jx-link-indicator.is-fault { background: #eab308; color: #1f2937; }
.jx-link-indicator--click {
  border: none;
  padding: 0;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease;
}
.jx-link-indicator--click:hover:not(:disabled) {
  transform: scale(1.1);
  box-shadow: 0 0 0 2px color-mix(in oklab, #fff 35%, transparent);
  filter: brightness(1.08);
}
.jx-link-indicator--click:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}
.jx-link-indicator--click.jx-link-indicator--busy {
  position: relative;
  overflow: visible;
}
.jx-link-indicator--click.jx-link-indicator--busy::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 100%;
  height: 100%;
  border-radius: 999px;
  border: 2px solid color-mix(in oklab, #38bdf8 55%, transparent);
  box-sizing: border-box;
  pointer-events: none;
  animation: jx-link-ripple-out 1.25s ease-out infinite;
}
@keyframes jx-link-ripple-out {
  0% {
    transform: translate(-50%, -50%) scale(1);
    opacity: 0.85;
  }
  100% {
    transform: translate(-50%, -50%) scale(2.35);
    opacity: 0;
  }
}

.jx-pile-btn { border: none; padding: 0; background: transparent; cursor: pointer; border-radius: 12px; transition: transform 0.18s ease-out; }
.jx-pile-btn:hover, .jx-pile-btn.is-active { transform: translateY(-3px); }
.jx-pile-btn.is-active .jx-pile-art { filter: drop-shadow(0 0 0 2px #07131d) drop-shadow(0 0 0 4px var(--jx-teal)); }
.jx-pile-art { width: 54px; height: 92px; object-fit: contain; display: block; }
.jx-pile-wrap { position: relative; width: fit-content; }
.jx-pile-remove {
  position: absolute;
  top: 2px;
  right: -8px;
  width: 10px;
  height: 10px;
  border: none;
  background: transparent;
  color: #ef4444;
  line-height: 1;
  font-size: 20px;
  font-weight: 800;
  cursor: pointer;
}
.jx-pile-remove.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.jx-car-strip {
  display: flex;
  flex-wrap: nowrap;
  gap: var(--jx-row-gap, 5px);
  margin: 6px 0 0;
  width: 100%;
  box-sizing: border-box;
}
.jx-topology-row-block.is-scroll .jx-car-strip {
  width: max-content;
}
.jx-car-slot { display: flex; flex-direction: column; align-items: center; gap: 4px; flex-shrink: 0; }
.jx-gun-cluster {
  --jx-gun-node-width: 100px;
  --jx-gun-gap: 0;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  width: fit-content;
}
/* 多枪时列宽贴合内容，去掉列内留白，组间间距最小 */
.jx-gun-cluster.is-gun-count-2,
.jx-gun-cluster.is-gun-count-3,
.jx-gun-cluster.is-gun-count-4 {
  --jx-gun-node-width: 82px;
}
.jx-car-bus-wrap { width: 100%; min-width: 0; display: flex; flex-direction: column; align-items: center; }
.jx-car-bus-drop { width: 2px; height: 16px; background: var(--jx-teal); }
.jx-car-bus-line {
  position: absolute;
  top: 0;
  height: 2px;
  left: calc(var(--jx-gun-node-width) / 2);
  right: calc(var(--jx-gun-node-width) / 2);
  background: var(--jx-teal);
}
.jx-car-line { width: 2px; height: 24px; background: linear-gradient(to bottom, var(--jx-teal), color-mix(in oklab, var(--jx-teal) 40%, transparent)); }
.jx-gun-list {
  display: flex;
  flex-direction: row;
  gap: var(--jx-gun-gap);
  align-items: flex-start;
  justify-content: center;
  min-height: 34px;
  width: fit-content;
  position: relative;
  padding-top: 2px;
}
.jx-gun-row { display: flex; flex-direction: column; align-items: center; gap: 3px; width: var(--jx-gun-node-width); position: relative; }
.jx-gun-item { display: flex; align-items: center; gap: 5px; font-size: 10px; }
.jx-gun-id { color: var(--jx-text); font-weight: 700; }
.jx-gun-status { border-radius: 999px; padding: 0 6px; line-height: 1.4; color: #fff; }
.jx-gun-status.is-idle { background: #22c55e; }
.jx-gun-status.is-linked { background: #3b82f6; }
.jx-gun-status.is-occupied { background: #64748b; }
.jx-gun-status.is-charging { background: #0ea5e9; }
.jx-gun-status.is-fault { background: #f59e0b; color: #1f2937; }
.jx-gun-status.is-unknown { background: #64748b; color: #dbe4ef; }
.jx-car-btn { border: 0; background: transparent; padding: 0; cursor: default; border-radius: 8px; }
.jx-car-btn.is-virtual { cursor: pointer; }
.jx-car-btn.is-virtual { padding: 2px 2px; }
.jx-car-btn { position: relative; }
.jx-car-qr-icon {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 28px;
  height: 28px;
  color: #fbbf24;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
  cursor: pointer;
  opacity: 0.5;
}
.jx-car-qr-icon:hover { opacity: 0.75; }
.jx-car-art { width: 74px; height: 28px; object-fit: contain; opacity: 0.92; transition: opacity 0.2s ease; }
.jx-car-art-dashed {
  width: 74px;
  height: 28px;
}
.jx-car-art-dashed path,
.jx-car-art-dashed circle {
  fill: none;
  stroke: color-mix(in oklab, var(--jx-teal) 70%, #93a7b8 30%);
  stroke-width: 4;
  stroke-dasharray: 8 6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.jx-car-pct { font-size: 11px; font-weight: 700; color: color-mix(in oklab, var(--jx-muted) 92%, #64748b 8%); }
.jx-car-pct.is-live {
  color: #22c55e;
}
/* 车辆下实时数据：单列、与车图左缘对齐 */
.jx-car-hud {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  align-self: center;
  width: 74px;
  margin-top: 4px;
  gap: 3px;
  line-height: 1.2;
}
.jx-hud-cell {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 4px;
  width: 100%;
  min-width: 0;
  color: color-mix(in oklab, var(--jx-muted) 90%, #64748b 10%);
}
.jx-car-hud.is-charging .jx-hud-cell {
  color: #22c55e;
}
.jx-hud-ico {
  width: 11px;
  height: 11px;
  flex-shrink: 0;
  color: currentColor;
}
.jx-hud-val {
  min-width: 0;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.jx-hud-val--soc {
  font-size: 11px;
  font-weight: 700;
}
.jx-vin-pop {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 230px;
  padding: 8px 8px 8px 28px;
  border-radius: 10px;
  border: 1px solid var(--jx-border);
  background: color-mix(in oklab, #132e44 90%, black 10%);
  box-shadow: 0 8px 14px color-mix(in oklab, black 25%, transparent);
}

.jx-vin-pop--fixed {
  position: fixed;
  z-index: 4000;
  transform: translateX(-50%);
}
.jx-vin-close {
  position: absolute;
  left: 4px;
  top: 2px;
  border: none;
  background: transparent;
  color: var(--jx-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.jx-vin-icon-btn {
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  color: #3b82f6;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.jx-hidden-tip { text-align: center; margin-top: 6px; font-size: 11px; color: var(--jx-muted); }

.jx-panel { position: absolute; left: 20px; bottom: 16px; z-index: 30; display: flex; width: min(560px, 94vw); height: min(72vh, 560px); flex-direction: column; overflow: hidden; border-radius: 10px; border: 1px solid var(--jx-border); background: var(--jx-panel-bg); }
.jx-panel--list-mode { left: auto; right: 12px; }
.jx-panel-tabs { position: relative; display: flex; align-items: center; border-bottom: 1px solid var(--jx-border); background: color-mix(in oklab, #133147 88%, black 12%); }
.jx-tab { flex: 1; border: none; background: transparent; padding: 10px 12px; font-size: 13px; font-weight: 600; color: var(--jx-muted); cursor: pointer; }
.jx-tab.is-on { color: var(--jx-teal); box-shadow: inset 0 -2px 0 var(--jx-teal); }
.jx-panel-close { position: absolute; right: 4px; top: 4px; border: none; background: transparent; color: var(--jx-muted); font-size: 18px; cursor: pointer; }
.jx-panel-body { padding: 10px 12px; overflow: auto; flex: 1 1 auto; min-height: 0; }
.jx-control-only { display: flex; flex-direction: column; gap: 10px; }
.jx-param-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.jx-span2 { grid-column: span 2; }
.jx-control-form { display: flex; flex-direction: column; gap: 8px; }
.jx-login-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; }
.jx-form-row-abnormal-sim { grid-column: 1 / -1; }
.jx-form-row { display: flex; align-items: center; gap: 8px; }
.jx-form-label { width: 98px; flex-shrink: 0; color: var(--jx-muted); font-size: 12px; }
.jx-form-control { flex: 1; }
.jx-login-actions { grid-column: 1 / -1; }
.jx-hint-box { border-radius: 6px; border: 1px solid var(--jx-border); background: color-mix(in oklab, #122a3d 86%, black 14%); padding: 8px; font-size: 11px; color: var(--jx-muted); }
.jx-hint-title { margin-bottom: 4px; font-weight: 600; color: var(--jx-text); }
.jx-hint-title { display: inline-flex; align-items: center; gap: 6px; }
.jx-err { color: #f59e0b; }
.jx-run { width: 100%; }
.jx-basic-desc { position: relative; }
.jx-inline-edit-btn {
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--jx-teal);
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.jx-inline-edit-btn:hover { background: color-mix(in oklab, var(--jx-teal) 18%, transparent); }
.jx-inline-edit-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.jx-basic-inline-input { width: min(100%, 280px); }
.jx-gun-detail { margin-top: 10px; }
.jx-gun-detail-title { margin-bottom: 6px; font-size: 12px; font-weight: 600; color: var(--jx-muted); }
.jx-gun-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.jx-gun-table th,
.jx-gun-table td { border: 1px solid var(--jx-border); padding: 6px 8px; text-align: left; }
.jx-gun-table th { color: var(--jx-muted); font-weight: 600; background: color-mix(in oklab, #1d3b53 80%, black 20%); }
.jx-rate-time-cell { position: relative; }
.jx-current-tag {
  position: absolute;
  top: 0;
  right: 0;
  border-radius: 0 0 0 8px;
  background: linear-gradient(135deg, #fde68a, #f59e0b);
  color: #1f2937;
  font-size: 10px;
  line-height: 1;
  padding: 2px 6px;
  font-weight: 700;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}
.jx-rate-empty { color: #9fb7cc; font-size: 11px; }

.jx-log-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.jx-log-search { flex: 1; min-width: 120px; }
.jx-logs-body { display: flex; flex-direction: column; gap: 6px; overflow: hidden; }
.jx-log-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.jx-orders-body { display: flex; flex-direction: column; gap: 6px; overflow: hidden; }
.jx-orders-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
.jx-order-table { min-width: 1080px; }
.jx-order-chart-title { margin: 6px 0 4px; font-size: 12px; color: var(--jx-muted); font-weight: 600; }
.jx-order-chart { width: 100%; height: 240px; border: 1px solid var(--jx-border); border-radius: 8px; margin-bottom: 8px; }
.jx-log-item { border-radius: 6px; border: 1px solid var(--jx-border); background: color-mix(in oklab, #132e44 88%, black 12%); padding: 6px 8px; font-size: 11px; }
.jx-log-item summary { cursor: pointer; font-weight: 600; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.jx-log-summary-main { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.jx-log-direction.is-send { color: #22c55e; }
.jx-log-direction.is-receive { color: #60a5fa; }
.jx-log-summary-right { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }
.jx-log-copy-icon {
  border: none;
  background: transparent;
  color: var(--jx-muted);
  width: 18px;
  height: 18px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.jx-log-copy-icon:hover { color: var(--jx-teal); }
.jx-log-summary-right :deep(.el-radio-button__inner) {
  font-size: 11px;
  padding: 3px 8px;
}
.jx-tcp-tag { padding: 1px 7px; border-radius: 999px; font-size: 10px; line-height: 1.4; color: #fff; }
.jx-tcp-tag.is-connect { background: #22c55e; }
.jx-tcp-tag.is-disconnect { background: #ef4444; }
.jx-log-ip { margin-top: 4px; color: var(--jx-muted); }
.jx-log-pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; font-size: 10px; color: var(--jx-text); }
.jx-log-field-table { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 11px; }
.jx-log-field-table th,
.jx-log-field-table td { border: 1px solid var(--jx-border); padding: 4px 6px; text-align: left; vertical-align: top; }
.jx-log-field-table th { color: var(--jx-muted); font-weight: 600; background: color-mix(in oklab, #1d3b53 80%, black 20%); }
.jx-log-field-value { display: inline-block; max-width: 100%; word-break: break-all; }
.jx-log-field-meaning { display: inline-block; max-width: 100%; word-break: break-all; }

.jx-qr-view-btn {
  border: none;
  background: transparent;
  color: #fbbf24;
  cursor: pointer;
  padding: 0;
  font-weight: 700;
}
.jx-qr-view-btn:hover {
  text-decoration: underline;
}
.jx-qr-none {
  color: #94a3b8;
}
.jx-start-control-inner {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
}
.jx-start-panel-viewport {
  position: relative;
  overflow: hidden;
  min-height: 300px;
}
.jx-start-panel-stack {
  width: 100%;
}
.jx-panel-slide-forward-enter-active,
.jx-panel-slide-forward-leave-active {
  transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.28s ease;
}
.jx-panel-slide-forward-leave-active {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  z-index: 1;
}
.jx-panel-slide-forward-leave-to {
  transform: translateX(-100%);
  opacity: 0.35;
}
.jx-panel-slide-forward-enter-from {
  transform: translateX(100%);
  opacity: 0.35;
}
.jx-panel-slide-forward-enter-to,
.jx-panel-slide-forward-leave-from {
  transform: translateX(0);
  opacity: 1;
}
.jx-panel-slide-instant-enter-active,
.jx-panel-slide-instant-leave-active {
  transition: none;
}
.jx-charging-info-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 300px;
  padding-top: 4px;
}
.jx-charging-info-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.jx-charging-info-live-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 14px;
  flex: 1;
  align-content: start;
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--jx-border);
}
.jx-charging-info-live-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.jx-charging-info-row {
  display: grid;
  grid-template-columns: 6.5em 1fr;
  gap: 8px;
  align-items: start;
  font-size: 13px;
  line-height: 1.45;
}
.jx-charging-info-k {
  color: var(--jx-muted);
  font-weight: 600;
}
.jx-charging-info-v {
  color: var(--jx-text);
  font-weight: 500;
  word-break: break-all;
}
.jx-charging-info-mono {
  font-family: ui-monospace, 'Cascadia Mono', monospace;
  font-size: 12px;
  letter-spacing: 0.02em;
}
.jx-charging-info-live {
  color: var(--jx-teal);
  font-weight: 700;
}
.jx-charging-stop-btn {
  width: 100%;
  margin-top: auto;
}
.jx-start-tabs :deep(.el-tabs__content) {
  padding-top: 10px;
}
.jx-start-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 248px;
}
.jx-start-meta-line,
.jx-start-vin-block {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
}
.jx-start-meta-k {
  color: var(--jx-muted);
  font-weight: 600;
  min-width: 3.5em;
}
.jx-start-meta-v {
  color: var(--jx-text);
  font-weight: 700;
}
.jx-start-qr-preview {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 4px 0 8px;
}
.jx-start-qr-img {
  width: 220px;
  height: 220px;
  object-fit: contain;
}
.jx-start-qr-placeholder {
  flex: 1;
  min-height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--jx-muted);
  font-size: 12px;
  padding: 12px;
  border: 1px dashed color-mix(in oklab, var(--jx-border) 70%, transparent);
  border-radius: 8px;
}
.jx-flow-hint,
.jx-start-scan-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--jx-muted);
}
.jx-flow-hint code,
.jx-start-scan-hint code {
  font-size: 11px;
}
.jx-start-vin-text {
  font-family: ui-monospace, 'Cascadia Mono', monospace;
  letter-spacing: 0.03em;
  color: var(--jx-text);
  word-break: break-all;
  flex: 1;
  min-width: 0;
  font-size: 12px;
}
.jx-start-vin-edit-btn,
.jx-start-vin-save-btn,
.jx-start-vin-cancel-btn {
  border: none;
  background: transparent;
  padding: 2px;
  cursor: pointer;
  color: var(--jx-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  flex-shrink: 0;
}
.jx-start-vin-edit-btn:hover,
.jx-start-vin-save-btn:hover {
  color: var(--jx-teal);
}
.jx-start-vin-cancel-btn:hover {
  color: #fb923c;
}
.jx-start-vin-input {
  flex: 1;
  min-width: 120px;
  max-width: 240px;
}
.jx-start-vin-launch-btn {
  width: 100%;
  margin-top: auto;
}
.jx-start-disconnect-wrap {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 14px;
  padding-top: 10px;
  margin-top: 4px;
  border-top: 1px solid var(--jx-border);
}
.jx-start-forcestop-icon {
  border: none;
  background: transparent;
  color: #f59e0b;
  cursor: pointer;
  padding: 6px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
}
.jx-start-forcestop-icon:hover {
  color: #fbbf24;
  background: color-mix(in oklab, #f59e0b 18%, transparent);
}
.jx-start-disconnect-icon {
  border: none;
  background: transparent;
  color: var(--jx-muted);
  cursor: pointer;
  padding: 6px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
}
.jx-start-disconnect-icon:hover {
  color: #fb923c;
  background: color-mix(in oklab, #fb923c 14%, transparent);
}

:deep(.el-input__wrapper),
:deep(.el-select__wrapper) {
  border-radius: 6px;
  background-color: var(--jx-input-bg);
  box-shadow: 0 0 0 1px var(--jx-border) inset;
}

:deep(.el-input__wrapper:hover),
:deep(.el-select__wrapper:hover) {
  box-shadow: 0 0 0 1px var(--jx-accent-border) inset;
}

:deep(.el-input__wrapper.is-focus),
:deep(.el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 1px var(--jx-brand) inset;
}

:deep(.el-input__inner),
:deep(.el-select__placeholder),
:deep(.el-select__selected-item),
:deep(.el-radio-button__inner),
:deep(.el-descriptions__label),
:deep(.el-descriptions__content) {
  color: var(--jx-text);
}

:deep(.el-input__inner::placeholder) {
  color: var(--jx-muted);
}

:deep(.el-input__clear),
:deep(.el-select__caret),
:deep(.el-select__icon) {
  color: var(--jx-muted);
}
</style>
