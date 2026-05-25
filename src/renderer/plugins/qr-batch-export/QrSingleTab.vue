<script setup lang="ts">
import { ref } from 'vue'
import QrDecodePanel from './QrDecodePanel.vue'
import QrSingleGenerate from './QrSingleGenerate.vue'

const LABEL_DECODE = '\u4e8c\u7ef4\u7801\u89e3\u6790'
const LABEL_GENERATE = '\u4e8c\u7ef4\u7801\u751f\u6210'

const singleMode = ref<'decode' | 'generate'>('decode')

function setMode(mode: 'decode' | 'generate') {
  singleMode.value = mode
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4">
    <div class="qr-mode-switch shrink-0" role="tablist">
      <button
        type="button"
        role="tab"
        class="qr-mode-switch__btn"
        :class="{ 'qr-mode-switch__btn--active': singleMode === 'decode' }"
        :aria-selected="singleMode === 'decode'"
        @click="setMode('decode')"
      >
        {{ LABEL_DECODE }}
      </button>
      <button
        type="button"
        role="tab"
        class="qr-mode-switch__btn"
        :class="{ 'qr-mode-switch__btn--active': singleMode === 'generate' }"
        :aria-selected="singleMode === 'generate'"
        @click="setMode('generate')"
      >
        {{ LABEL_GENERATE }}
      </button>
    </div>

    <QrDecodePanel
      v-if="singleMode === 'decode'"
      class="min-h-0 flex-1"
      @switch-generate="setMode('generate')"
    />
    <QrSingleGenerate
      v-else
      class="min-h-0 flex-1"
      @switch-decode="setMode('decode')"
    />
  </div>
</template>

<style scoped>
.qr-mode-switch {
  display: inline-flex;
  align-self: flex-start;
  padding: 4px;
  border-radius: 9999px;
  background: var(--um-surface-2);
  border: 1px solid var(--um-border);
  gap: 4px;
}

.qr-mode-switch__btn {
  border: none;
  cursor: pointer;
  padding: 8px 20px;
  font-size: 0.875rem;
  line-height: 1.25;
  color: var(--um-text-muted);
  background: transparent;
  border-radius: 9999px;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
}

.qr-mode-switch__btn:hover:not(.qr-mode-switch__btn--active) {
  color: var(--um-text);
  background: var(--um-surface);
}

.qr-mode-switch__btn--active {
  color: oklch(0.15 0.02 250);
  background: var(--um-brand);
  font-weight: 600;
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.12);
}
</style>
