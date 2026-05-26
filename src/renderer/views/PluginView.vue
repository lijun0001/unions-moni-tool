<script setup lang="ts">
import { computed, markRaw, shallowRef, toRaw, watch } from 'vue'
import type { Component } from 'vue'
import { useRouter } from 'vue-router'
import { usePluginStore } from '@renderer/stores/plugins'

const props = defineProps<{ pluginId: string }>()

defineOptions({ name: 'PluginView' })

const router = useRouter()
const plugins = usePluginStore()

const pluginId = computed(() => props.pluginId.trim())

const entry = computed(() => plugins.byId.get(pluginId.value))

const error = computed(() => entry.value?.error ?? null)

/** 组件对象不可被 ref 深响应式包裹，否则 Vue 会告警且可能影响性能 */
const MainView = shallowRef<Component | null>(null)

watch(
  () => entry.value?.plugin?.MainView,
  (Comp) => {
    if (!Comp) {
      MainView.value = null
      return
    }
    /** Pinia 可能已把导出包成 Proxy，需 toRaw 再 markRaw，避免 <component :is> 告警 */
    MainView.value = markRaw(toRaw(Comp))
  },
  { immediate: true },
)
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden px-[var(--space-xl)] pb-[var(--space-xl)] pt-[calc(var(--space-2xl)+3rem)]">
    <div class="mb-4 flex shrink-0 items-center gap-3">
      <button
        type="button"
        class="rounded-lg border border-[var(--um-border)] px-3 py-2 text-sm text-[var(--um-text-muted)] hover:text-[var(--um-text)]"
        @click="router.push('/')"
      >
        ← 返回首页
      </button>
      <h1 class="um-display text-xl font-semibold text-[var(--um-text)]">
        {{ entry?.plugin?.meta.name ?? pluginId }}
      </h1>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div
        v-if="error"
        class="rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] p-4 text-sm text-[var(--el-color-danger)]"
      >
        插件加载失败：{{ error }}
      </div>

      <component :is="MainView" v-else-if="MainView" />

      <p v-else class="text-sm text-[var(--um-text-muted)]">未找到该插件或尚未加载。</p>
    </div>
  </div>
</template>
