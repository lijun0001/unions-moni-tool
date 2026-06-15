<script setup lang="ts">
import type { JxTopologyPile } from './types'

withDefaults(
  defineProps<{
    pile: JxTopologyPile
    hasTariffModel: (pile: JxTopologyPile) => boolean
    formatRate: (v?: number) => string
    periodRangeText: (
      periods: NonNullable<JxTopologyPile['tariffModel']>['periods'],
      idx: number,
    ) => string
    getCurrentTariffPeriodIndex: (pile: JxTopologyPile) => number
    tariffTypeLabel: (type: number) => string
    placement?: 'left' | 'right' | 'top' | 'bottom'
  }>(),
  { placement: 'left' },
)
</script>

<template>
  <el-popover :placement="placement" width="360" trigger="click" popper-class="jx-rate-popover">
    <template #reference>
      <button
        type="button"
        class="jx-rate-icon"
        :class="{ 'is-set': hasTariffModel(pile) }"
        title="查看费率信息"
      >
        ¥
      </button>
    </template>
    <div class="jx-rate-panel">
      <div class="jx-rate-panel-head">
        <span>计费模型版本：{{ pile.tariffModel?.version ?? '-' }}</span>
        <span>停车费率：{{ formatRate(pile.tariffModel?.parkingRate) }}</span>
      </div>
      <table v-if="(pile.tariffModel?.periods?.length ?? 0) > 0" class="jx-rate-table">
        <thead>
          <tr>
            <th>时段</th>
            <th>类型</th>
            <th>电价</th>
            <th>服务费</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(tp, idx) in pile.tariffModel?.periods ?? []" :key="`${pile.pileId}-tp-${idx}`">
            <td class="jx-rate-time-cell">
              {{ periodRangeText(pile.tariffModel?.periods ?? [], idx) }}
              <span v-if="idx === getCurrentTariffPeriodIndex(pile)" class="jx-current-tag">当前</span>
            </td>
            <td>{{ tariffTypeLabel(tp.type) }}</td>
            <td>{{ formatRate(tp.electricRate) }}</td>
            <td>{{ formatRate(tp.serviceRate) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="jx-rate-empty">暂无费率数据</div>
    </div>
  </el-popover>
</template>

<style scoped>
.jx-rate-icon {
  border: none;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1;
  font-weight: 700;
  color: var(--jx-muted);
  background: var(--jx-surface-2);
  cursor: pointer;
}

.jx-rate-icon.is-set {
  color: #fbbf24;
}

.jx-rate-time-cell {
  position: relative;
}

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

.jx-rate-panel {
  font-size: 12px;
  color: var(--jx-text);
}

.jx-rate-panel-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--jx-muted);
}

.jx-rate-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.jx-rate-table th,
.jx-rate-table td {
  border: 1px solid var(--jx-border);
  padding: 4px 6px;
  text-align: left;
}

.jx-rate-empty {
  color: var(--jx-muted);
  font-size: 11px;
}
</style>

<style>
.jx-rate-popover {
  border: 1px solid var(--um-border) !important;
  background: var(--um-surface) !important;
}
</style>
