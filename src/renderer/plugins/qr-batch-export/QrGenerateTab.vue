<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ZoomIn } from '@element-plus/icons-vue'
import { pickAndReadExcel, saveExcelBuffer } from './file-io'
import { renderQrWithCaption } from './qr-image'
import { buildResultWorkbook, buildTemplateWorkbook, parseImportWorkbook } from './qr-excel'
import {
  DEFAULT_QR_PIXEL_SIZE,
  QR_PIXEL_SIZE_OPTIONS,
  type QrImportRow,
  type QrResultRow,
} from './types'

const pixelSize = ref(DEFAULT_QR_PIXEL_SIZE)
const importRows = ref<QrImportRow[]>([])
const importSummary = ref<string | null>(null)
const results = ref<QrResultRow[]>([])
const generating = ref(false)
const importing = ref(false)
const exporting = ref(false)

const previewVisible = ref(false)
const previewUrl = ref('')
const previewContent = ref('')
const previewCaption = ref('')

async function onImportExcel() {
  importing.value = true
  importSummary.value = null
  try {
    const buffer = await pickAndReadExcel()
    if (!buffer) return
    const parsed = await parseImportWorkbook(buffer)
    importRows.value = parsed.rows
    results.value = []
    const parts = [`已导入 ${parsed.rows.length} 条有效数据`]
    if (parsed.skippedEmpty > 0) parts.push(`跳过 ${parsed.skippedEmpty} 行（二维码信息为空）`)
    if (parsed.truncated) parts.push('已超过 2000 行上限，仅保留前 2000 条')
    importSummary.value = parts.join('；')
    ElMessage.success('Excel 导入成功')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
  } finally {
    importing.value = false
  }
}

async function onExportTemplate() {
  try {
    const buffer = await buildTemplateWorkbook()
    const res = await saveExcelBuffer('二维码批量导入模板.xlsx', buffer)
    if (res.ok) ElMessage.success(`模板已保存：${res.path}`)
    else if (res.error !== 'cancelled') ElMessage.warning(res.error)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
  }
}

async function onGenerate() {
  if (importRows.value.length === 0) {
    ElMessage.warning('请先导入 Excel')
    return
  }
  if (importRows.value.length > 2000) {
    try {
      await ElMessageBox.confirm(
        '数据超过 2000 行，仅处理前 2000 行，是否继续？',
        '提示',
        { type: 'warning' },
      )
    } catch {
      return
    }
  }

  generating.value = true
  results.value = []
  try {
    const rows = importRows.value.slice(0, 2000)
    const next: QrResultRow[] = []
    for (const row of rows) {
      const { dataUrl, png } = await renderQrWithCaption(row.content, row.caption, pixelSize.value)
      next.push({
        rowIndex: row.rowIndex,
        content: row.content,
        caption: row.caption,
        imageDataUrl: dataUrl,
        imagePng: png,
      })
    }
    results.value = next
    ElMessage.success(`已生成 ${next.length} 个二维码`)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
  } finally {
    generating.value = false
  }
}

async function onExportResults() {
  if (results.value.length === 0) return
  exporting.value = true
  try {
    const buffer = await buildResultWorkbook(results.value)
    const res = await saveExcelBuffer('二维码批量生成结果.xlsx', buffer)
    if (res.ok) ElMessage.success(`结果已导出：${res.path}`)
    else if (res.error !== 'cancelled') ElMessage.warning(res.error)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
  } finally {
    exporting.value = false
  }
}

function openPreview(row: QrResultRow) {
  previewUrl.value = row.imageDataUrl
  previewContent.value = row.content
  previewCaption.value = row.caption
  previewVisible.value = true
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-[var(--space-lg)]">
    <section
      class="shrink-0 rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] p-[var(--space-lg)]"
    >
      <p class="text-sm text-[var(--um-text-muted)]">
        从 Excel 批量导入二维码内容与可选说明文字，生成图片并支持导出含图 Excel。请先
        <button
          type="button"
          class="text-[var(--um-brand)] underline-offset-2 hover:underline"
          @click="onExportTemplate"
        >
          下载导入模板
        </button>
        后填写。
      </p>

      <div class="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="rounded-lg border border-[var(--um-border)] px-4 py-2 text-sm text-[var(--um-text)] disabled:opacity-50"
          :disabled="importing"
          @click="onImportExcel"
        >
          {{ importing ? '导入中…' : '导入 Excel' }}
        </button>

        <label class="flex items-center gap-2 text-sm text-[var(--um-text-muted)]">
          <span>图片尺寸</span>
          <select
            v-model.number="pixelSize"
            class="rounded-lg border border-[var(--um-border)] bg-[var(--um-surface-2)] px-3 py-2 text-sm text-[var(--um-text)]"
          >
            <option v-for="opt in QR_PIXEL_SIZE_OPTIONS" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </label>

        <button
          type="button"
          class="rounded-lg bg-[var(--um-brand)] px-4 py-2 text-sm font-semibold text-[oklch(0.15_0.02_250)] disabled:opacity-50"
          :disabled="generating || importRows.length === 0"
          @click="onGenerate"
        >
          {{ generating ? '生成中…' : '生成二维码' }}
        </button>
      </div>

      <p v-if="importSummary" class="mt-3 text-sm text-[var(--um-text)]">
        {{ importSummary }}
      </p>
    </section>

    <section
      class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] p-[var(--space-md)]"
    >
      <div class="mb-3 flex shrink-0 items-center justify-between gap-3">
        <span v-if="results.length > 0" class="text-sm text-[var(--um-text)]">
          共生成 {{ results.length }} 个
        </span>
        <span v-else class="text-sm text-[var(--um-text-muted)]">生成结果</span>
        <button
          v-if="results.length > 0"
          type="button"
          class="rounded-lg bg-[var(--um-brand)] px-4 py-2 text-sm font-semibold text-[oklch(0.15_0.02_250)] disabled:opacity-50"
          :disabled="exporting"
          @click="onExportResults"
        >
          {{ exporting ? '导出中…' : '导出结果 Excel' }}
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-hidden">
        <el-table
          v-if="results.length > 0"
          :data="results"
          height="100%"
          stripe
          class="qr-batch-table"
          empty-text="暂无数据"
        >
          <el-table-column prop="content" label="二维码信息" min-width="220" show-overflow-tooltip />
          <el-table-column prop="caption" label="文字描述" min-width="120" show-overflow-tooltip />
          <el-table-column label="二维码" width="120" align="center">
            <template #default="{ row }">
              <button
                type="button"
                class="qr-thumb-btn group inline-flex flex-col items-center gap-1 rounded-lg p-1 hover:bg-[var(--um-surface-2)]"
                :title="'点击放大：' + row.content"
                @click="openPreview(row)"
              >
                <img :src="row.imageDataUrl" alt="二维码" class="max-h-20 max-w-20 object-contain" />
                <span
                  class="flex items-center gap-0.5 text-xs text-[var(--um-text-muted)] group-hover:text-[var(--um-brand)]"
                >
                  <el-icon :size="12"><ZoomIn /></el-icon>
                  放大
                </span>
              </button>
            </template>
          </el-table-column>
        </el-table>

        <div
          v-else
          class="flex h-full min-h-48 flex-col items-center justify-center gap-2 text-sm text-[var(--um-text-muted)]"
        >
          <p>导入 Excel 后点击「生成二维码」，结果将显示在此处。</p>
          <p v-if="importRows.length > 0">当前已加载 {{ importRows.length }} 条待生成数据。</p>
        </div>
      </div>
    </section>

    <el-dialog
      v-model="previewVisible"
      title="二维码预览"
      width="420px"
      align-center
      destroy-on-close
    >
      <div class="flex flex-col items-center gap-3">
        <img
          :src="previewUrl"
          alt="二维码大图"
          class="max-h-[min(70vh,480px)] max-w-full object-contain"
        />
        <p class="w-full break-all text-center text-sm text-[var(--um-text)]">
          {{ previewContent }}
        </p>
        <p v-if="previewCaption" class="text-center text-sm text-[var(--um-text-muted)]">
          {{ previewCaption }}
        </p>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.qr-batch-table {
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-header-bg-color: var(--um-surface-2);
  --el-table-row-hover-bg-color: var(--um-surface-2);
  --el-table-border-color: var(--um-border);
  --el-table-text-color: var(--um-text);
  --el-table-header-text-color: var(--um-text-muted);
}

.qr-thumb-btn {
  border: none;
  background: transparent;
  cursor: pointer;
}
</style>
