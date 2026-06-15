<script setup lang="ts">
import { computed } from 'vue'
import carSvg from './assets/car.svg'
import type { JxTopologyPile } from './types'
import { gunLayoutMode } from './jx-topology-layout'
import type { GunDensity, GunLayoutMode } from './jx-topology-layout'
import {
  gunHudAmountLine,
  gunHudCharging,
  gunHudEnergyLine,
  gunHudSocDisplay,
  gunLabelFromPile,
  gunStatusForPile,
  isVirtualCarForPile,
} from './jx-gun-display'
import { useJxOrderStore } from './useJxOrderStore'

const props = withDefaults(
  defineProps<{
    pile: JxTopologyPile
    layout?: GunLayoutMode
    density?: GunDensity
    showWiring?: boolean
    vinVisible: boolean
    vinPileId: string
    vinGunId: string
    vinDraft: string
  }>(),
  {
    layout: undefined,
    density: 'normal',
    showWiring: true,
  },
)

const emit = defineEmits<{
  carClick: [pileId: string, gunId: string]
  startControl: [pileId: string, gunId: string]
  vinClose: []
  vinConfirm: []
  'update:vinDraft': [value: string]
}>()

const orderStore = useJxOrderStore()

const resolvedLayout = computed(() => props.layout ?? gunLayoutMode(props.pile.guns.length))
const pileOrders = computed(() => orderStore.listByPile(props.pile.pileId))
const clusterClass = computed(() => ({
  'is-compact': props.density === 'compact' || (props.density === 'normal' && resolvedLayout.value === 'grid'),
  'is-relaxed': props.density === 'relaxed',
}))
const listClass = computed(() => ({
  'is-grid': resolvedLayout.value === 'grid',
  'is-multi': props.pile.guns.length > 1,
}))

function onVinInput(v: string) {
  emit('update:vinDraft', v)
}
</script>

<template>
  <div class="jx-gun-cluster" :class="clusterClass">
    <div v-if="showWiring" class="jx-car-bus-wrap" aria-hidden="true">
      <div class="jx-car-bus-drop" />
    </div>
    <div class="jx-gun-list" :class="listClass">
      <div v-if="showWiring && pile.guns.length > 1" class="jx-car-bus-line" aria-hidden="true" />
      <div v-for="gun in pile.guns" :key="`${pile.pileId}-${gun.gunId}`" class="jx-gun-row">
        <div v-if="showWiring" class="jx-car-line" aria-hidden="true" />
        <div class="jx-gun-item">
          <span class="jx-gun-id">{{ gunLabelFromPile(pile, gun.gunId) }}</span>
          <span
            class="jx-gun-status"
            :class="[pile.onlineState === 'online' ? `is-${gun.status}` : 'is-unknown']"
          >
            {{ gunStatusForPile(pile.onlineState, gun.status) }}
          </span>
        </div>
        <button
          type="button"
          class="jx-car-btn"
          :class="{ 'is-virtual': isVirtualCarForPile(pile, gun.gunId) }"
          @click="emit('carClick', pile.pileId, gun.gunId)"
        >
          <svg
            v-if="isVirtualCarForPile(pile, gun.gunId)"
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
            v-if="pile.onlineState === 'online' && gun.status !== 'idle' && !isVirtualCarForPile(pile, gun.gunId)"
            class="jx-car-qr-icon"
            title="启动控制"
            aria-label="启动控制"
            @click.stop="emit('startControl', pile.pileId, gun.gunId)"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path
                d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z"
                fill="currentColor"
              />
            </svg>
          </span>
        </button>
        <div
          v-if="vinVisible && vinPileId === pile.pileId && vinGunId === gun.gunId"
          class="jx-vin-pop"
        >
          <button type="button" class="jx-vin-close" aria-label="关闭" @click="emit('vinClose')">×</button>
          <el-input
            :model-value="vinDraft"
            size="small"
            placeholder="输入VIN"
            maxlength="20"
            @update:model-value="onVinInput"
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
        <div
          v-if="pile.onlineState === 'online' && gun.status !== 'idle'"
          class="jx-car-hud"
          :class="{ 'is-charging': gunHudCharging(gun) }"
        >
          <div class="jx-hud-cell">
            <svg class="jx-hud-ico" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M13 2L4 14h7l-1 8 10-14h-7l0-6z" fill="currentColor" />
            </svg>
            <span class="jx-hud-val jx-hud-val--soc">{{ gunHudSocDisplay(pile, gun.gunId, gun, pileOrders) }}</span>
          </div>
          <div class="jx-hud-cell">
            <svg class="jx-hud-ico" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="6" y="7" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6" />
              <path d="M9 18v2h6v-2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              <path d="M11 5h2v3h-2z" fill="currentColor" />
            </svg>
            <span class="jx-hud-val">{{ gunHudEnergyLine(pile, gun.gunId, gun, pileOrders) }}</span>
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
            <span class="jx-hud-val">{{ gunHudAmountLine(pile, gun.gunId, gun, pileOrders) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
