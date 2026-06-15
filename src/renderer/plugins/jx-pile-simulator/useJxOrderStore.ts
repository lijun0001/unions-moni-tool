import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { JxOrderTariffSnapshot, JxPileOrder, JxOrderStatus } from './types'

const STORAGE_KEY = 'jx-pile-orders-v1'

export const useJxOrderStore = defineStore('jx-order-store', () => {
  const ordersByPile = ref<Record<string, JxPileOrder[]>>({})

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ordersByPile.value))
    } catch {
      // ignore
    }
  }

  function hydrate() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, JxPileOrder[]>
      if (!parsed || typeof parsed !== 'object') return
      for (const [pileId, list] of Object.entries(parsed)) {
        parsed[pileId] = (list ?? []).map((x) => ({
          ...x,
          process25: Array.isArray(x.process25) ? x.process25 : [],
          process30: Array.isArray(x.process30) ? x.process30 : [],
          tariffSnapshot: x.tariffSnapshot ?? undefined,
          latest23: x.latest23 ?? undefined,
          latest25: x.latest25 ?? undefined,
          periodEnergySegments: Array.isArray(x.periodEnergySegments) ? x.periodEnergySegments : undefined,
          latestBms: x.latestBms ?? undefined,
          stoppedAt: typeof x.stoppedAt === 'number' ? x.stoppedAt : undefined,
          excludeFromOrderPush: typeof x.excludeFromOrderPush === 'boolean' ? x.excludeFromOrderPush : undefined,
          delivery: x.delivery ?? { pushed: false, status: 'undelivered' as const },
        }))
      }
      ordersByPile.value = parsed
    } catch {
      ordersByPile.value = {}
    }
  }

  function listByPile(pileId: string): JxPileOrder[] {
    return ordersByPile.value[pileId] ?? []
  }

  function upsertOrder(order: JxPileOrder) {
    const list = ordersByPile.value[order.pileId] ?? []
    const idx = list.findIndex((x) => x.orderNo === order.orderNo)
    if (idx >= 0) list[idx] = { ...list[idx], ...order, delivery: order.delivery ?? list[idx].delivery ?? { pushed: false, status: 'undelivered' } }
    else list.unshift({ ...order, delivery: order.delivery ?? { pushed: false, status: 'undelivered' } })
    ordersByPile.value[order.pileId] = list
    persist()
  }

  function updateOrderStatus(
    pileId: string,
    orderNo: string,
    patch: { status: JxOrderStatus; failReasonCode?: number; failReasonText?: string },
  ) {
    const list = ordersByPile.value[pileId] ?? []
    const idx = list.findIndex((x) => x.orderNo === orderNo)
    if (idx < 0) return
    const next = { ...list[idx], ...patch }
    if (patch.status === 'stopped' && !next.stoppedAt) next.stoppedAt = Date.now()
    list[idx] = next
    ordersByPile.value[pileId] = list
    persist()
  }

  function removeOrder(pileId: string, orderNo: string) {
    const list = ordersByPile.value[pileId] ?? []
    ordersByPile.value[pileId] = list.filter((x) => x.orderNo !== orderNo)
    persist()
  }

  function removeByPile(pileId: string) {
    delete ordersByPile.value[pileId]
    persist()
  }

  function appendProcessPoint(
    pileId: string,
    orderNo: string,
    data: {
      p25?: { t: number; voltage: number; current: number; energy: number; amount: number }
      p30?: { t: number; bclVoltageReq: number; bclCurrentReq: number; bcsVoltage: number; bcsCurrent: number; soc: number }
    },
  ) {
    const list = ordersByPile.value[pileId] ?? []
    const idx = list.findIndex((x) => x.orderNo === orderNo)
    if (idx < 0) return
    const item = list[idx]
    const p25 = item.process25 ?? []
    const p30 = item.process30 ?? []
    if (data.p25) p25.push(data.p25)
    if (data.p30) p30.push(data.p30)
    list[idx] = { ...item, process25: p25.slice(-300), process30: p30.slice(-300) }
    ordersByPile.value[pileId] = list
    persist()
  }

  function updateLatest25Snapshot(
    pileId: string,
    orderNo: string,
    latest25: NonNullable<JxPileOrder['latest25']>,
    periodEnergySegments?: JxPileOrder['periodEnergySegments'],
  ) {
    const list = ordersByPile.value[pileId] ?? []
    const idx = list.findIndex((x) => x.orderNo === orderNo)
    if (idx < 0) return
    list[idx] = {
      ...list[idx],
      latest25,
      periodEnergySegments: periodEnergySegments ?? list[idx].periodEnergySegments,
    }
    ordersByPile.value[pileId] = list
    persist()
  }

  function updateLatestBmsSnapshot(
    pileId: string,
    orderNo: string,
    latestBms: NonNullable<JxPileOrder['latestBms']>,
  ) {
    const list = ordersByPile.value[pileId] ?? []
    const idx = list.findIndex((x) => x.orderNo === orderNo)
    if (idx < 0) return
    list[idx] = { ...list[idx], latestBms }
    ordersByPile.value[pileId] = list
    persist()
  }

  function commitTariffSnapshot(pileId: string, orderNo: string, tariffSnapshot: JxOrderTariffSnapshot) {
    const list = ordersByPile.value[pileId] ?? []
    const idx = list.findIndex((x) => x.orderNo === orderNo)
    if (idx < 0) return
    const item = list[idx]
    list[idx] = {
      ...item,
      tariffSnapshot,
      request23: {
        ...item.request23,
        tariffModelVersionAtStart: tariffSnapshot.version,
      },
    }
    ordersByPile.value[pileId] = list
    persist()
  }

  function updateLatest23Snapshot(
    pileId: string,
    orderNo: string,
    latest23: NonNullable<JxPileOrder['latest23']>,
  ) {
    const list = ordersByPile.value[pileId] ?? []
    const idx = list.findIndex((x) => x.orderNo === orderNo)
    if (idx < 0) return
    list[idx] = { ...list[idx], latest23 }
    ordersByPile.value[pileId] = list
    persist()
  }

  function markOrderPushed(pileId: string, orderNo: string, cmd: '0x23' | '0x33') {
    const list = ordersByPile.value[pileId] ?? []
    const idx = list.findIndex((x) => x.orderNo === orderNo)
    if (idx < 0) return
    const item = list[idx]
    list[idx] = {
      ...item,
      delivery: {
        pushed: true,
        status: 'undelivered',
        lastPushCmd: cmd,
        lastPushedAt: Date.now(),
        lastAckCmd: item.delivery?.lastAckCmd,
        lastAckAt: item.delivery?.lastAckAt,
      },
    }
    ordersByPile.value[pileId] = list
    persist()
  }

  const DISCONNECT_FAIL_CODE = 9001

  /** 连接断开时：将未结束的充电会话订单置为已停止（不尝试再向平台发报文） */
  function markActiveOrdersStoppedByDisconnect(pileId: string) {
    const list = ordersByPile.value[pileId] ?? []
    const mustStop: JxOrderStatus[] = ['charging', 'starting', 'start-accepted']
    let changed = false
    const next = list.map((o) => {
      if (!mustStop.includes(o.status)) return o
      changed = true
      return {
        ...o,
        status: 'stopped' as const,
        stoppedAt: o.stoppedAt ?? Date.now(),
        failReasonCode: DISCONNECT_FAIL_CODE,
        failReasonText: '连接已断开',
      }
    })
    if (changed) {
      ordersByPile.value[pileId] = next
      persist()
    }
  }

  function markOrderDelivered(pileId: string, orderNo: string, ackCmd: '0x24' | '0x34', delivered: boolean) {
    const list = ordersByPile.value[pileId] ?? []
    const idx = list.findIndex((x) => x.orderNo === orderNo)
    if (idx < 0) return
    const item = list[idx]
    list[idx] = {
      ...item,
      delivery: {
        pushed: item.delivery?.pushed ?? false,
        status: delivered ? 'delivered' : 'undelivered',
        lastPushCmd: item.delivery?.lastPushCmd,
        lastPushedAt: item.delivery?.lastPushedAt,
        lastAckCmd: ackCmd,
        lastAckAt: Date.now(),
      },
    }
    ordersByPile.value[pileId] = list
    persist()
  }

  const getByPile = computed(() => (pileId: string) => ordersByPile.value[pileId] ?? [])

  hydrate()

  return {
    ordersByPile,
    listByPile,
    getByPile,
    upsertOrder,
    updateOrderStatus,
    removeOrder,
    removeByPile,
    appendProcessPoint,
    markOrderPushed,
    markOrderDelivered,
    updateLatest25Snapshot,
    updateLatestBmsSnapshot,
    updateLatest23Snapshot,
    commitTariffSnapshot,
    markActiveOrdersStoppedByDisconnect,
  }
})

