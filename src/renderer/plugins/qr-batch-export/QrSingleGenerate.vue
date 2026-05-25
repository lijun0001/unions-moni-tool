<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown, ArrowUp } from '@element-plus/icons-vue'
import { downloadDataUrl, renderSingleQr } from './qr-single-render'
import {
  DEFAULT_SINGLE_SETTINGS,
  ERROR_LEVEL_OPTIONS,
  MARGIN_OPTIONS,
  SIZE_OPTIONS,
  VERSION_OPTIONS,
  sanitizeQrContent,
  settingsSummary,
  type SingleQrSettings,
} from './qr-single-types'

const emit = defineEmits<{
  switchDecode: []
}>()

const STYLE_LABEL = '\u57fa\u7840\u6837\u5f0f'

const T = {
  inputTitle: '\u8f93\u5165\u5185\u5bb9',
  advanced: '\u9ad8\u7ea7\u7f16\u8f91',
  placeholder: '\u8bf7\u8f93\u5165\u6587\u5b57',
  filterHint: '\u5df2\u81ea\u52a8\u8fc7\u6ee4\u7a7a\u683c\u3001\u56de\u8f66\u4e0e\u6362\u884c\u3002\u5f53\u524d\u6709\u6548\u957f\u5ea6\uff1a',
  generating: '\u751f\u6210\u4e2d\u2026',
  generateBtn: '\u751f\u6210\u4e8c\u7ef4\u7801',
  createAnother: '\u518d\u5efa\u4e00\u4e2a',
  stylePrefix: '\u6837\u5f0f\uff1a',
  previewAlt: '\u4e8c\u7ef4\u7801\u9884\u89c8',
  symbology: '\u7801\u5236',
  errorLevel: '\u5bb9\u9519\u7387',
  size: '\u5c3a\u5bf8',
  version: '\u7801\u7248\u672c',
  margin: '\u7801\u8fb9\u8ddd',
  download: '\u4e0b\u8f7d\u56fe\u7247',
  decode: '\u89e3\u7801',
} as const

const rawInput = ref('')
const content = computed(() => sanitizeQrContent(rawInput.value))
const generated = ref(false)
const advancedOpen = ref(false)
const settingsExpanded = ref(false)
const settings = ref<SingleQrSettings>({ ...DEFAULT_SINGLE_SETTINGS, style: 'basic' })
const previewUrl = ref('')
const loading = ref(false)

/** 生成中或已生成：输入区不可编辑 */
const inputLocked = computed(() => loading.value || generated.value)

const summaryText = computed(() => settingsSummary(settings.value))

async function refreshQr() {
  if (!content.value) {
    previewUrl.value = ''
    return
  }
  loading.value = true
  try {
    previewUrl.value = await renderSingleQr({
      content: content.value,
      settings: { ...settings.value, style: 'basic' },
    })
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
}

async function onGenerate() {
  if (!content.value) {
    ElMessage.warning('请输入文字')
    return
  }
  generated.value = true
  await refreshQr()
}

function onInput() {
  if (inputLocked.value) return
  rawInput.value = sanitizeQrContent(rawInput.value)
}

function onCreateAnother() {
  generated.value = false
  rawInput.value = ''
  previewUrl.value = ''
  settingsExpanded.value = false
}

function onDownload() {
  if (!previewUrl.value) return
  downloadDataUrl(previewUrl.value, `qrcode-${Date.now()}.png`)
  ElMessage.success('图片已下载')
}

watch(
  () => ({ c: content.value, s: { ...settings.value } }),
  () => {
    if (generated.value && content.value) void refreshQr()
  },
  { deep: true },
)
</script>

<template>
  <div class="qr-single-gen grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
    <section
      class="flex flex-col rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] p-4"
    >
      <div class="mb-2 flex items-center justify-between">
        <span class="text-sm text-[var(--um-text-muted)]">{{ T.inputTitle }}</span>
        <button
          v-if="!inputLocked"
          type="button"
          class="text-sm text-[var(--um-brand)] hover:underline"
          @click="advancedOpen = !advancedOpen"
        >
          {{ T.advanced }}
        </button>
      </div>

      <textarea
        v-model="rawInput"
        class="min-h-[200px] flex-1 resize-none rounded-lg border border-[var(--um-border)] bg-[var(--um-surface-2)] p-3 text-sm text-[var(--um-text)] outline-none focus:border-[var(--um-brand)] disabled:cursor-not-allowed disabled:opacity-70"
        :placeholder="inputLocked ? '' : T.placeholder"
        :disabled="inputLocked"
        @input="onInput"
      />

      <p v-if="advancedOpen && !inputLocked" class="mt-2 text-xs text-[var(--um-text-muted)]">
        {{ T.filterHint }}{{ content.length }}
      </p>

      <div class="mt-4 flex justify-center">
        <button
          v-if="!generated"
          type="button"
          class="rounded-full bg-[var(--um-brand)] px-8 py-2.5 text-sm font-semibold text-[oklch(0.15_0.02_250)] disabled:opacity-50"
          :disabled="!content || loading"
          @click="onGenerate"
        >
          {{ loading ? T.generating : T.generateBtn }}
        </button>
        <button
          v-else
          type="button"
          class="rounded-full border border-[var(--um-brand)] bg-[var(--um-surface)] px-8 py-2.5 text-sm text-[var(--um-brand)]"
          @click="onCreateAnother"
        >
          {{ T.createAnother }}
        </button>
      </div>
    </section>

    <section
      class="flex min-h-0 flex-col rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface-2)] p-4"
    >
      <div v-if="generated" class="mb-3 text-sm text-[var(--um-text-muted)]">
        {{ T.stylePrefix }}<span class="text-[var(--um-text)]">{{ STYLE_LABEL }}</span>
      </div>

      <div
        class="flex min-h-[200px] flex-1 flex-col items-center justify-center rounded-lg bg-[var(--um-surface)] p-6 shadow-sm"
      >
        <img
          v-if="previewUrl && !loading"
          :src="previewUrl"
          :alt="T.previewAlt"
          class="max-h-[min(360px,50vh)] max-w-full object-contain"
        />
        <div
          v-else
          class="flex h-48 w-48 items-center justify-center text-[var(--um-text-muted)] opacity-40"
        >
          <svg viewBox="0 0 100 100" class="h-full w-full" aria-hidden="true">
            <rect width="100" height="100" fill="currentColor" opacity="0.08" />
            <rect x="10" y="10" width="24" height="24" fill="currentColor" opacity="0.2" />
            <rect x="66" y="10" width="24" height="24" fill="currentColor" opacity="0.2" />
            <rect x="10" y="66" width="24" height="24" fill="currentColor" opacity="0.2" />
          </svg>
        </div>
        <p v-if="loading" class="mt-2 text-sm text-[var(--um-brand)]">{{ T.generating }}</p>
      </div>

      <template v-if="generated">
        <button
          type="button"
          class="mt-4 flex w-full shrink-0 items-center justify-between rounded-lg border border-[var(--um-border)] bg-[var(--um-surface)] px-3 py-2 text-left text-sm text-[var(--um-text)]"
          @click="settingsExpanded = !settingsExpanded"
        >
          <span class="truncate">{{ summaryText }}</span>
          <el-icon class="shrink-0 text-[var(--um-text-muted)]">
            <ArrowUp v-if="settingsExpanded" />
            <ArrowDown v-else />
          </el-icon>
        </button>

        <div
          v-show="settingsExpanded"
          class="qr-settings-scroll mt-3 space-y-3 rounded-lg border border-[var(--um-border)] bg-[var(--um-surface)] p-3"
        >
          <label class="qr-setting-row">
            <span class="qr-setting-label">{{ T.symbology }}</span>
            <select class="qr-setting-select" disabled>
              <option>QR Code</option>
            </select>
          </label>
          <label class="qr-setting-row">
            <span class="qr-setting-label">{{ T.errorLevel }}</span>
            <select v-model="settings.errorLevel" class="qr-setting-select">
              <option v-for="o in ERROR_LEVEL_OPTIONS" :key="o.value" :value="o.value">
                {{ o.label }}
              </option>
            </select>
          </label>
          <label class="qr-setting-row">
            <span class="qr-setting-label">{{ T.size }}</span>
            <select v-model.number="settings.size" class="qr-setting-select">
              <option v-for="s in SIZE_OPTIONS" :key="s" :value="s">{{ s }}</option>
            </select>
          </label>
          <label class="qr-setting-row">
            <span class="qr-setting-label">{{ T.version }}</span>
            <select v-model.number="settings.version" class="qr-setting-select">
              <option v-for="o in VERSION_OPTIONS" :key="o.value" :value="o.value">
                {{ o.label }}
              </option>
            </select>
          </label>
          <label class="qr-setting-row">
            <span class="qr-setting-label">{{ T.margin }}</span>
            <select v-model.number="settings.margin" class="qr-setting-select">
              <option v-for="o in MARGIN_OPTIONS" :key="o.value" :value="o.value">
                {{ o.label }}
              </option>
            </select>
          </label>
        </div>

        <button
          type="button"
          class="mt-4 w-full shrink-0 rounded-full bg-[var(--um-brand)] py-2.5 text-sm font-semibold text-[oklch(0.15_0.02_250)] disabled:opacity-50"
          :disabled="!previewUrl"
          @click="onDownload"
        >
          {{ T.download }}
        </button>
      </template>

      <div
        v-else
        class="mt-4 shrink-0 border-t border-[var(--um-border)] pt-3 text-center text-sm"
      >
        <button
          type="button"
          class="text-[var(--um-text-muted)] hover:text-[var(--um-brand)]"
          @click="emit('switchDecode')"
        >
          {{ T.decode }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.qr-settings-scroll {
  max-height: min(220px, 32vh);
  overflow-y: auto;
  overflow-x: hidden;
}

.qr-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.qr-setting-label {
  flex-shrink: 0;
  font-size: 0.875rem;
  color: var(--um-text-muted);
  border-bottom: 1px dotted var(--um-border);
}

.qr-setting-select {
  min-width: 140px;
  flex: 1;
  max-width: 200px;
  border-radius: 8px;
  border: 1px solid var(--um-border);
  background: var(--um-surface-2);
  padding: 6px 10px;
  font-size: 0.875rem;
  color: var(--um-text);
}
</style>
