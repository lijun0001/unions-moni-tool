<script setup lang="ts">
import { ref } from 'vue'
import QrGenerateTab from './QrGenerateTab.vue'
import QrSingleTab from './QrSingleTab.vue'

const TAB_BATCH = '\u4e8c\u7ef4\u7801\u751f\u6210(\u6279\u91cf)'
const TAB_SINGLE = '\u4e8c\u7ef4\u7801(\u5355\u4e2a)'

const activeTab = ref<'batch' | 'single'>('batch')
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-[var(--space-md)]">
    <el-tabs v-model="activeTab" class="qr-plugin-tabs min-h-0 flex-1 flex flex-col">
      <el-tab-pane :label="TAB_BATCH" name="batch" class="min-h-0 flex-1">
        <QrGenerateTab class="h-full min-h-[420px]" />
      </el-tab-pane>
      <el-tab-pane :label="TAB_SINGLE" name="single" class="min-h-0 flex-1">
        <QrSingleTab class="h-full min-h-[420px]" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.qr-plugin-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.qr-plugin-tabs :deep(.el-tab-pane) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.qr-plugin-tabs :deep(.el-tabs__header) {
  margin-bottom: var(--space-md);
}

.qr-plugin-tabs :deep(.el-tabs__item.is-active) {
  color: var(--um-brand);
}

.qr-plugin-tabs :deep(.el-tabs__active-bar) {
  background-color: var(--um-brand);
}
</style>
