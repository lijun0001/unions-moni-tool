<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import chargePileSvg from './assets/charge-pile.svg'
import carSvg from './assets/car.svg'
import type { JxPileOrder, JxTopologyPile } from './types'
import {
  gunLabelFromPile,
  gunStatusForPile,
  isVirtualCarForPile,
  pileChargingGunCount,
} from './jx-gun-display'
import { useJxOrderStore } from './useJxOrderStore'
import JxRatePopover from './JxRatePopover.vue'

const props = defineProps<{
  piles: JxTopologyPile[]
  activePileId: string | null | undefined
  hiddenPileCount: number
  loginExecuting: boolean
  loginExecutingPileId: string | null
  disconnecting: boolean
  vinVisible: boolean
  vinPileId: string
  vinGunId: string
  vinDraft: string
  hasTariffModel: (pile: JxTopologyPile) => boolean
  linkStateLabel: (state?: string) => string
  formatRate: (v?: number) => string
  periodRangeText: (
    periods: NonNullable<JxTopologyPile['tariffModel']>['periods'],
    idx: number,
  ) => string
  getCurrentTariffPeriodIndex: (pile: JxTopologyPile) => number
  tariffTypeLabel: (type: number) => string
}>()

const emit = defineEmits<{
  selectPile: [pileId: string]
  dblclickPile: [pileId: string]
  addPile: []
  linkLogin: [pileId: string]
  linkDisconnect: [pileId: string]
  carClick: [pileId: string, gunId: string]
  startControl: [pileId: string, gunId: string]
  vinClose: []
  vinConfirm: []
  'update:vinDraft': [value: string]
}>()

const orderStore = useJxOrderStore()
const liveClock = ref(Date.now())
let liveClockTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  liveClockTimer = setInterval(() => {
    liveClock.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  if (liveClockTimer) clearInterval(liveClockTimer)
})

const activePile = computed(() => props.piles.find((p) => p.pileId === props.activePileId))

function deviceKindLabel(kind?: string): string {
  if (kind === 'ac') return '交流桩'
  return '直流桩'
}

function gunRatedPowerKw(pile: JxTopologyPile): string {
  const total = pile.pilePowerKw
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return '—'
  const per = Math.round(total / Math.max(1, pile.guns.length))
  return `${deviceKindLabel(pile.deviceKind)} ${per}kW`
}

function activeChargingOrder(pileId: string, gunId: string): JxPileOrder | undefined {
  return orderStore
    .listByPile(pileId)
    .find((o) => o.gunId === gunId && ['charging', 'starting', 'start-accepted'].includes(o.status))
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function gunLiveMetrics(pile: JxTopologyPile, gunId: string) {
  void liveClock.value
  const gun = pile.guns.find((g) => g.gunId === gunId)
  const order = activeChargingOrder(pile.pileId, gunId)
  const charging = pile.onlineState === 'online' && gun?.status === 'charging' && !!order

  if (!charging || !order) {
    return {
      voltage: '— V',
      current: '— A',
      power: '— kW',
      energy: '— kWh',
      duration: '—:—:—',
    }
  }

  const bms = order.latestBms
  const last25 = order.process25?.at(-1)
  const voltage = bms?.bcsVoltage ?? last25?.voltage
  const current = bms?.bcsCurrent ?? last25?.current
  let powerKw: number | undefined
  if (typeof voltage === 'number' && typeof current === 'number') {
    powerKw = (voltage * current) / 1000
  }
  const energy = order.latest25?.chargeEnergyKwh
  const startMs = order.process25?.[0]?.t ?? order.startAt
  const durationSec = Math.max(0, Math.floor((liveClock.value - startMs) / 1000))

  return {
    voltage: typeof voltage === 'number' && Number.isFinite(voltage) ? `${voltage.toFixed(1)} V` : '— V',
    current: typeof current === 'number' && Number.isFinite(current) ? `${current.toFixed(1)} A` : '— A',
    power: typeof powerKw === 'number' && Number.isFinite(powerKw) ? `${powerKw.toFixed(2)} kW` : '— kW',
    energy: typeof energy === 'number' && Number.isFinite(energy) ? `${energy.toFixed(2)} kWh` : '— kWh',
    duration: formatDuration(durationSec),
  }
}

function gunVinText(pile: JxTopologyPile, gunId: string): string {
  const gun = pile.guns.find((g) => g.gunId === gunId)
  const vin = String(gun?.vin ?? '').trim()
  return vin || '—'
}

function onDetailLinkCommand(command: string) {
  const pile = activePile.value
  if (!pile) return
  if (command === 'login') emit('linkLogin', pile.pileId)
  if (command === 'disconnect') emit('linkDisconnect', pile.pileId)
}

function statusDotClass(state?: string): string {
  if (state === 'online') return 'is-online'
  if (state === 'fault') return 'is-fault'
  return 'is-offline'
}

function gunStatusDotClass(pile: JxTopologyPile, gunId: string): string {
  const gun = pile.guns.find((g) => g.gunId === gunId)
  if (pile.onlineState !== 'online' || !gun) return 'is-unknown'
  if (gun.status === 'charging') return 'is-charging'
  if (gun.status === 'linked' || gun.status === 'occupied') return 'is-busy'
  if (gun.status === 'fault') return 'is-fault'
  return 'is-idle'
}
</script>

<template>
  <div class="jx-board-list">
    <aside class="jx-list-rail">
      <div class="jx-list-rail-title">充电桩列表</div>
      <div v-if="piles.length === 0" class="jx-list-empty">
        <p>暂无匹配的桩</p>
        <p class="jx-list-empty-hint">调整筛选条件，或点击下方添加桩</p>
      </div>
      <button
        v-for="pile in piles"
        :key="pile.pileId"
        type="button"
        class="jx-list-card"
        :class="{ 'is-active': activePileId === pile.pileId }"
        @click="emit('selectPile', pile.pileId)"
        @dblclick="emit('dblclickPile', pile.pileId)"
      >
        <span class="jx-list-card-badge">{{ pile.guns.length }}枪</span>
        <img class="jx-list-card-icon" :src="chargePileSvg" alt="" aria-hidden="true" />
        <div class="jx-list-card-body">
          <div class="jx-list-card-id">{{ pile.pileId }}</div>
          <div class="jx-list-card-meta">
            <span class="jx-list-card-dot" :class="statusDotClass(pile.onlineState)" />
            <span>{{ linkStateLabel(pile.onlineState) }}</span>
            <span v-if="pileChargingGunCount(pile) > 0" class="jx-list-card-charging">
              · {{ pileChargingGunCount(pile) }}枪充电
            </span>
          </div>
        </div>
      </button>
      <button type="button" class="jx-list-add" @click="emit('addPile')">+ 添加桩</button>
      <div v-if="hiddenPileCount > 0" class="jx-list-fold-tip">已折叠 {{ hiddenPileCount }} 个桩</div>
    </aside>

    <main class="jx-list-detail">
      <div v-if="!activePile" class="jx-list-detail-empty">
        <p v-if="piles.length === 0">添加桩后即可在此查看枪位详情</p>
        <p v-else>请从左侧选择一台桩</p>
      </div>
      <template v-else>
        <header class="jx-list-detail-head">
          <h2 class="jx-list-detail-title">
            <span class="jx-list-detail-pile-id">{{ activePile.pileId }}</span>
            <span class="jx-list-detail-title-suffix">详情</span>
          </h2>
          <el-dropdown trigger="contextmenu" @command="onDetailLinkCommand">
            <button
              type="button"
              class="jx-list-link-btn"
              :class="[
                statusDotClass(activePile.onlineState),
                { 'jx-list-link-btn--busy': loginExecuting && loginExecutingPileId === activePile.pileId },
              ]"
              :title="activePile.onlineState === 'online' ? '右击选择链接断开' : '右击选择链接登录'"
            >
              <span class="jx-list-card-dot" :class="statusDotClass(activePile.onlineState)" />
              {{ linkStateLabel(activePile.onlineState) }}
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  command="login"
                  :disabled="activePile.onlineState === 'online' || loginExecuting"
                >
                  链接登录
                </el-dropdown-item>
                <el-dropdown-item
                  command="disconnect"
                  :disabled="activePile.onlineState !== 'online' || disconnecting"
                >
                  链接断开
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </header>

        <section class="jx-list-pile-overview">
          <div class="jx-list-pile-visual">
            <img class="jx-list-pile-art" :src="chargePileSvg" alt="充电桩" />
          </div>
          <dl class="jx-list-pile-kv">
            <div class="jx-list-kv-row">
              <dt>桩体编号</dt>
              <dd>{{ activePile.pileId }}</dd>
            </div>
            <div class="jx-list-kv-row">
              <dt>连接地址</dt>
              <dd>{{ activePile.tcpHost ? `${activePile.tcpHost}:${activePile.tcpPort ?? '-'}` : '—' }}</dd>
            </div>
            <div class="jx-list-kv-row">
              <dt>桩体类型</dt>
              <dd>{{ deviceKindLabel(activePile.deviceKind) }}</dd>
            </div>
            <div class="jx-list-kv-row">
              <dt>额定功率</dt>
              <dd>{{ typeof activePile.pilePowerKw === 'number' ? `${activePile.pilePowerKw}kW` : '—' }}</dd>
            </div>
            <div class="jx-list-kv-row">
              <dt>枪口总数</dt>
              <dd>{{ activePile.guns.length }}枪</dd>
            </div>
            <div class="jx-list-kv-row">
              <dt>当前状态</dt>
              <dd>{{ linkStateLabel(activePile.onlineState) }}</dd>
            </div>
            <div class="jx-list-kv-row">
              <dt>费率</dt>
              <dd class="jx-list-kv-rate">
                <JxRatePopover
                  :pile="activePile"
                  :has-tariff-model="hasTariffModel"
                  :format-rate="formatRate"
                  :period-range-text="periodRangeText"
                  :get-current-tariff-period-index="getCurrentTariffPeriodIndex"
                  :tariff-type-label="tariffTypeLabel"
                  placement="left"
                />
              </dd>
            </div>
          </dl>
        </section>

        <section class="jx-list-gun-section">
          <div class="jx-list-gun-grid">
            <article
              v-for="gun in activePile.guns"
              :key="`${activePile.pileId}-${gun.gunId}`"
              class="jx-list-gun-card"
            >
              <header class="jx-list-gun-card-head">
                <span class="jx-list-gun-no">{{ gunLabelFromPile(activePile, gun.gunId) }}</span>
                <span class="jx-list-gun-status" :class="gunStatusDotClass(activePile, gun.gunId)">
                  <span class="jx-list-card-dot" :class="gunStatusDotClass(activePile, gun.gunId)" />
                  {{ gunStatusForPile(activePile.onlineState, gun.status) }}
                </span>
                <span class="jx-list-gun-power">{{ gunRatedPowerKw(activePile) }}</span>
              </header>
              <div class="jx-list-gun-card-body">
                <div class="jx-list-gun-connector" aria-hidden="true">
                  <svg viewBox="0 0 48 64" width="36" height="48">
                    <rect x="14" y="4" width="20" height="36" rx="4" fill="none" stroke="currentColor" stroke-width="2" />
                    <path d="M18 44h12v8H18z" fill="none" stroke="currentColor" stroke-width="2" />
                    <circle cx="24" cy="56" r="3" fill="currentColor" />
                  </svg>
                </div>
                <dl class="jx-list-gun-metrics">
                  <div><dt>电压</dt><dd>{{ gunLiveMetrics(activePile, gun.gunId).voltage }}</dd></div>
                  <div><dt>电流</dt><dd>{{ gunLiveMetrics(activePile, gun.gunId).current }}</dd></div>
                  <div><dt>功率</dt><dd>{{ gunLiveMetrics(activePile, gun.gunId).power }}</dd></div>
                  <div><dt>电量</dt><dd>{{ gunLiveMetrics(activePile, gun.gunId).energy }}</dd></div>
                  <div class="is-wide"><dt>时长</dt><dd>{{ gunLiveMetrics(activePile, gun.gunId).duration }}</dd></div>
                </dl>
                <button
                  type="button"
                  class="jx-list-gun-car"
                  :class="{ 'is-virtual': isVirtualCarForPile(activePile, gun.gunId) }"
                  @click="emit('carClick', activePile.pileId, gun.gunId)"
                >
                  <img class="jx-list-gun-car-art" :src="carSvg" alt="车辆" />
                  <span class="jx-list-gun-vin">VIN：{{ gunVinText(activePile, gun.gunId) }}</span>
                  <span
                    v-if="activePile.onlineState === 'online' && gun.status !== 'idle' && !isVirtualCarForPile(activePile, gun.gunId)"
                    class="jx-list-gun-ctrl"
                    title="启动控制"
                    @click.stop="emit('startControl', activePile.pileId, gun.gunId)"
                  >
                    控制
                  </span>
                </button>
              </div>
              <div
                v-if="vinVisible && vinPileId === activePile.pileId && vinGunId === gun.gunId"
                class="jx-list-vin-pop"
              >
                <button type="button" class="jx-vin-close" aria-label="关闭" @click="emit('vinClose')">×</button>
                <el-input
                  :model-value="vinDraft"
                  size="small"
                  placeholder="输入VIN"
                  maxlength="20"
                  @update:model-value="emit('update:vinDraft', $event)"
                  @keyup.enter="emit('vinConfirm')"
                />
                <button type="button" class="jx-vin-icon-btn" aria-label="连接车辆" @click="emit('vinConfirm')">
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path
                      d="M8 3v6M12 3v6M6 9h8v3a4 4 0 0 1-4 4H9v4"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>
              </div>
            </article>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.jx-board-list {
  display: flex;
  gap: 14px;
  flex: 1;
  min-height: 0;
  height: 100%;
  background: transparent;
  color: var(--jx-text);
}

.jx-list-rail {
  flex: 0 0 240px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  padding: 12px 10px;
  border: 1px solid var(--jx-border);
  border-radius: 8px;
  background: var(--jx-surface);
}

.jx-list-rail-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--jx-brand);
  letter-spacing: 0.04em;
  padding: 0 4px 4px;
}

.jx-list-card {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  border: 1px solid var(--jx-border);
  border-radius: 8px;
  background: var(--jx-surface-2);
  padding: 10px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.jx-list-card:hover,
.jx-list-card.is-active {
  border-color: var(--jx-brand);
  box-shadow: 0 0 0 1px var(--jx-accent-soft);
}

.jx-list-card-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--jx-accent-border);
  color: var(--jx-muted);
}

.jx-list-card-icon {
  width: 28px;
  height: 48px;
  object-fit: contain;
  flex-shrink: 0;
  opacity: 0.9;
}

.jx-list-card-body { min-width: 0; flex: 1; padding-right: 28px; }
.jx-list-card-id { font-size: 12px; font-weight: 700; word-break: break-all; line-height: 1.3; }
.jx-list-card-meta {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--jx-muted);
}

.jx-list-card-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex-shrink: 0;
}
.jx-list-card-dot.is-online { background: #22c55e; }
.jx-list-card-dot.is-offline { background: #64748b; }
.jx-list-card-dot.is-fault { background: #eab308; }
.jx-list-card-dot.is-idle { background: #22c55e; }
.jx-list-card-dot.is-charging { background: #38bdf8; }
.jx-list-card-dot.is-busy { background: #3b82f6; }
.jx-list-card-dot.is-unknown { background: #64748b; }

.jx-list-card-charging { color: #38bdf8; }

.jx-list-add {
  border: 1px dashed var(--jx-accent-border);
  border-radius: 8px;
  background: transparent;
  color: var(--jx-brand);
  padding: 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.jx-list-fold-tip,
.jx-list-empty-hint { font-size: 11px; color: var(--jx-muted); text-align: center; }

.jx-list-empty,
.jx-list-detail-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
  font-size: 12px;
  color: var(--jx-muted);
  padding: 24px 12px;
}

.jx-list-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
  border: 1px solid var(--jx-border);
  border-radius: 8px;
  background: var(--jx-surface);
}

.jx-list-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--jx-border);
  flex-wrap: wrap;
}

.jx-list-detail-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.jx-list-detail-pile-id { color: var(--jx-pile-id); }
.jx-list-detail-title-suffix { color: var(--jx-text); font-weight: 600; }

.jx-list-link-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--jx-accent-border);
  background: var(--jx-surface-2);
  color: var(--jx-muted);
  cursor: context-menu;
}

.jx-list-link-btn.is-online { color: #22c55e; }
.jx-list-link-btn.is-offline { color: var(--jx-muted); }
.jx-list-link-btn--busy {
  animation: jx-list-link-pulse 1.2s ease-in-out infinite;
}

@keyframes jx-list-link-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, #38bdf8 35%, transparent); }
  50% { box-shadow: 0 0 0 3px color-mix(in oklab, #38bdf8 25%, transparent); }
}

.jx-list-pile-overview {
  display: grid;
  grid-template-columns: minmax(120px, 180px) 1fr;
  gap: 20px;
  padding: 18px;
  border-bottom: 1px solid var(--jx-border);
}

.jx-list-pile-visual {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  border: 1px solid var(--jx-accent-border);
  border-radius: 10px;
  background: var(--jx-surface-2);
}

.jx-list-pile-art { width: 72px; height: 120px; object-fit: contain; }

.jx-list-pile-kv {
  margin: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 18px;
  align-content: start;
}

.jx-list-kv-row {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 8px;
  font-size: 12px;
  align-items: baseline;
}

.jx-list-kv-row dt { margin: 0; color: var(--jx-muted); }
.jx-list-kv-row dd { margin: 0; color: var(--jx-text); font-weight: 600; word-break: break-all; }
.jx-list-kv-rate { display: flex; align-items: center; gap: 6px; }

.jx-list-gun-section { padding: 16px 18px 20px; }
.jx-list-gun-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.jx-list-gun-card {
  position: relative;
  border: 1px solid var(--jx-border);
  border-radius: 10px;
  background: var(--jx-surface-2);
  overflow: hidden;
}

.jx-list-gun-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--jx-border);
  font-size: 11px;
  flex-wrap: wrap;
}

.jx-list-gun-no { font-weight: 700; color: var(--jx-text); }
.jx-list-gun-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--jx-muted);
}
.jx-list-gun-status.is-charging { color: #38bdf8; }
.jx-list-gun-status.is-idle { color: #22c55e; }
.jx-list-gun-status.is-busy { color: #3b82f6; }
.jx-list-gun-power { margin-left: auto; color: var(--jx-muted); font-size: 10px; }

.jx-list-gun-card-body {
  display: grid;
  grid-template-columns: 44px 1fr 88px;
  gap: 10px;
  padding: 12px;
  align-items: center;
}

.jx-list-gun-connector { color: var(--jx-brand); display: flex; justify-content: center; }

.jx-list-gun-metrics {
  margin: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 10px;
  font-size: 10px;
}

.jx-list-gun-metrics div { display: flex; gap: 4px; min-width: 0; }
.jx-list-gun-metrics div.is-wide { grid-column: 1 / -1; }
.jx-list-gun-metrics dt { margin: 0; color: var(--jx-muted); flex-shrink: 0; }
.jx-list-gun-metrics dd { margin: 0; color: var(--jx-text); font-weight: 600; }

.jx-list-gun-car {
  position: relative;
  border: 1px dashed var(--jx-accent-border);
  border-radius: 8px;
  background: var(--jx-surface);
  padding: 8px 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  cursor: default;
}

.jx-list-gun-car.is-virtual { cursor: pointer; }
.jx-list-gun-car-art { width: 64px; height: 24px; object-fit: contain; opacity: 0.85; }
.jx-list-gun-vin {
  font-size: 9px;
  color: var(--jx-muted);
  max-width: 100%;
  word-break: break-all;
  text-align: center;
  line-height: 1.25;
}
.jx-list-gun-ctrl {
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 9px;
  color: #fbbf24;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  background: color-mix(in oklab, var(--jx-surface-2) 70%, transparent);
}

.jx-list-vin-pop {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 8px 28px;
  border-radius: 10px;
  border: 1px solid var(--jx-border);
  background: var(--jx-surface);
  box-shadow: 0 8px 14px var(--jx-shadow);
  z-index: 4;
}

@media (max-width: 900px) {
  .jx-list-pile-overview { grid-template-columns: 1fr; }
  .jx-list-gun-grid { grid-template-columns: 1fr; }
  .jx-list-gun-card-body { grid-template-columns: 40px 1fr; }
  .jx-list-gun-car { grid-column: 1 / -1; flex-direction: row; justify-content: center; }
}

:deep(.el-input__wrapper) {
  border-radius: 6px;
  background-color: var(--jx-input-bg);
  box-shadow: 0 0 0 1px var(--jx-border) inset;
}

:deep(.el-input__inner) {
  color: var(--jx-text);
}

:deep(.el-input__inner::placeholder) {
  color: var(--jx-muted);
}
</style>
