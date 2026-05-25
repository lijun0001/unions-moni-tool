<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { usePluginStore } from '@renderer/stores/plugins'

const router = useRouter()
const plugins = usePluginStore()

const busy = ref(false)
const message = ref<string | null>(null)

async function pickAndInstall(kind: 'zip' | 'dir') {
  message.value = null
  busy.value = true
  try {
    const p = await window.unions.openPluginSourceDialog(kind)
    if (!p) return
    const res = await window.unions.installPluginFromPath(p)
    if (res.ok) {
      message.value = `已安装：${res.record.name} (${res.record.id})`
      await plugins.refreshFromMain()
      router.push('/')
    } else {
      message.value = res.error
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="px-[var(--space-xl)] pb-[var(--space-2xl)] pt-[calc(var(--space-2xl)+3rem)]">
    <h1 class="um-display text-2xl font-semibold text-[var(--um-text)]">导入功能包</h1>
    <p class="mt-2 max-w-[75ch] text-sm text-[var(--um-text-muted)]">
      选择包含 manifest.json 与 ESM 入口的目录，或选择打包好的 .zip。安装目录为应用用户数据下的 plugins 文件夹。
    </p>

    <div class="mt-8 flex flex-wrap gap-3">
      <button
        type="button"
        class="rounded-lg bg-[var(--um-brand)] px-4 py-2 text-sm font-semibold text-[oklch(0.15_0.02_250)] disabled:opacity-50"
        :disabled="busy"
        @click="pickAndInstall('zip')"
      >
        选择 .zip 包
      </button>
      <button
        type="button"
        class="rounded-lg border border-[var(--um-border)] px-4 py-2 text-sm text-[var(--um-text)] disabled:opacity-50"
        :disabled="busy"
        @click="pickAndInstall('dir')"
      >
        选择文件夹
      </button>
      <button
        type="button"
        class="rounded-lg border border-transparent px-4 py-2 text-sm text-[var(--um-text-muted)] hover:text-[var(--um-text)]"
        @click="router.push('/')"
      >
        返回首页
      </button>
    </div>

    <p v-if="message" class="mt-6 max-w-[75ch] text-sm text-[var(--um-text)]">
      {{ message }}
    </p>
  </div>
</template>
