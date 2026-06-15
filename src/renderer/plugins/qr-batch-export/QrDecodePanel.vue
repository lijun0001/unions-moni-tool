<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { CopyDocument, UploadFilled } from '@element-plus/icons-vue'
import { decodeQrFromFile, isImageFile } from './qr-decode'

const emit = defineEmits<{
  switchGenerate: []
}>()

type DecodePhase = 'idle' | 'decoding' | 'result' | 'error'

const phase = ref<DecodePhase>('idle')
const dragOver = ref(false)
const decodedText = ref('')
const previewUrl = ref('')
const errorMessage = ref('')
const fileInputRef = ref<HTMLInputElement | null>(null)
/** 避免 Windows 文件对话框关闭后的穿透 click 再次打开选择框 */
let ignoreZoneClickUntil = 0

async function processFiles(files: FileList | File[]) {
  const list = Array.from(files).filter(isImageFile)
  if (list.length === 0) {
    ElMessage.warning('请选择图片文件（PNG、JPG 等）')
    return
  }

  phase.value = 'decoding'
  errorMessage.value = ''
  let lastText = ''
  let ok = 0
  let lastPreview = ''
  let lastError = ''

  for (const file of list) {
    try {
      lastText = await decodeQrFromFile(file)
      lastPreview = URL.createObjectURL(file)
      ok++
    } catch (e) {
      lastError = e instanceof Error ? e.message : '未能从图片中识别二维码'
    }
  }

  if (ok === 0) {
    phase.value = 'error'
    errorMessage.value = lastError || '未能从图片中识别二维码'
    ElMessage.error(errorMessage.value)
    return
  }

  if (lastPreview && previewUrl.value.startsWith('blob:')) {
    URL.revokeObjectURL(previewUrl.value)
  }
  previewUrl.value = lastPreview
  decodedText.value = lastText
  phase.value = 'result'
  if (list.length > 1) {
    ElMessage.success(`已解析 ${ok}/${list.length} 张`)
  }
}

function onPickClick() {
  if (Date.now() < ignoreZoneClickUntil) return
  fileInputRef.value?.click()
}

function onFileChange(e: Event) {
  ignoreZoneClickUntil = Date.now() + 600
  const input = e.target as HTMLInputElement
  if (input.files?.length) void processFiles(input.files)
  input.value = ''
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  dragOver.value = true
}

function onDragLeave() {
  dragOver.value = false
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  dragOver.value = false
  ignoreZoneClickUntil = Date.now() + 600
  if (e.dataTransfer?.files?.length) void processFiles(e.dataTransfer.files)
}

function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  const files: File[] = []
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) files.push(f)
    }
  }
  if (files.length) {
    e.preventDefault()
    ignoreZoneClickUntil = Date.now() + 600
    void processFiles(files)
  }
}

async function copyText() {
  if (!decodedText.value) return
  try {
    await navigator.clipboard.writeText(decodedText.value)
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.error('复制失败')
  }
}

function resetDecode() {
  if (previewUrl.value.startsWith('blob:')) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  decodedText.value = ''
  errorMessage.value = ''
  phase.value = 'idle'
}

onMounted(() => {
  window.addEventListener('paste', onPaste)
})

onUnmounted(() => {
  window.removeEventListener('paste', onPaste)
  if (previewUrl.value.startsWith('blob:')) URL.revokeObjectURL(previewUrl.value)
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- html5-qrcode 文件扫描宿主（须保持足够尺寸） -->
    <Teleport to="body">
      <div id="qr-batch-decode-host" class="qr-decode-host" aria-hidden="true" />
    </Teleport>

    <div
      class="qr-decode-zone flex min-h-[320px] flex-1 flex-col rounded-[var(--um-radius)] border-2 border-dashed transition-colors"
      :class="
        dragOver
          ? 'border-[var(--um-brand)] bg-[var(--um-surface-2)]'
          : phase === 'error'
            ? 'border-[var(--el-color-danger)] bg-[var(--um-surface)]'
            : 'border-[var(--um-border)] bg-[var(--um-surface)]'
      "
      tabindex="0"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @click="phase === 'idle' || phase === 'error' ? onPickClick() : undefined"
    >
      <input
        ref="fileInputRef"
        type="file"
        accept="image/*"
        multiple
        class="hidden"
        @change="onFileChange"
      />

      <div
        v-if="phase === 'idle' || phase === 'decoding' || phase === 'error'"
        class="flex flex-1 cursor-pointer flex-col items-center justify-center gap-3 px-6 py-10"
      >
        <el-icon class="text-[var(--um-brand)]" :size="48">
          <UploadFilled />
        </el-icon>
        <p class="text-lg font-medium text-[var(--um-text)]">图片解码</p>
        <p class="max-w-md text-center text-sm text-[var(--um-text-muted)]">
          点击或拖拽图片到此处，支持粘贴图片
        </p>
        <p v-if="phase === 'decoding'" class="text-sm text-[var(--um-brand)]">正在解析…</p>
        <p v-else-if="phase === 'error'" class="max-w-md text-center text-sm text-[var(--el-color-danger)]">
          {{ errorMessage }}
        </p>
      </div>

      <div
        v-else
        class="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-10"
        @click.stop
      >
        <p class="text-base font-medium text-[var(--um-text)]">解码结果</p>
        <img
          v-if="previewUrl"
          :src="previewUrl"
          alt="已上传的二维码图片"
          class="max-h-40 max-w-full rounded-lg border border-[var(--um-border)] object-contain"
        />
        <div class="flex w-full max-w-2xl items-start justify-center gap-2">
          <p class="min-w-0 flex-1 break-all text-center text-sm leading-relaxed text-[var(--um-text)]">
            {{ decodedText }}
          </p>
          <button
            type="button"
            class="shrink-0 rounded-lg p-2 text-[var(--um-brand)] hover:bg-[var(--um-surface-2)]"
            title="复制"
            @click="copyText"
          >
            <el-icon :size="20"><CopyDocument /></el-icon>
          </button>
        </div>
        <div class="flex flex-wrap justify-center gap-3">
          <button
            type="button"
            class="rounded-lg border border-[var(--um-brand)] px-5 py-2 text-sm text-[var(--um-brand)] hover:bg-[var(--um-surface-2)]"
            @click="emit('switchGenerate')"
          >
            前往生码
          </button>
          <button
            type="button"
            class="rounded-lg bg-[var(--um-brand)] px-5 py-2 text-sm font-semibold text-[oklch(0.15_0.02_250)]"
            @click="resetDecode"
          >
            继续解码
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.qr-decode-host {
  position: fixed;
  left: 0;
  top: 0;
  width: 300px;
  height: 300px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}

.qr-decode-zone:focus {
  outline: 2px solid var(--um-brand);
  outline-offset: 2px;
}
.qr-decode-zone:focus:not(:focus-visible) {
  outline: none;
}
</style>
