<script setup lang="ts">
import { computed, markRaw, shallowRef, toRaw, watch } from 'vue'
import type { Component } from 'vue'
import { usePluginStore } from '@renderer/stores/plugins'
import WorkspaceFrame from '@renderer/components/WorkspaceFrame.vue'

const props = defineProps<{ pluginId: string }>()

defineOptions({ name: 'PluginView' })

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
  <WorkspaceFrame fill>
    <div
      v-if="error"
      class="rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface-2)] p-4 text-sm text-[var(--el-color-danger)]"
    >
      插件加载失败：{{ error }}
    </div>

    <component :is="MainView" v-else-if="MainView" />

    <p v-else class="text-sm text-[var(--um-text-muted)]">未找到该插件或尚未加载。</p>
  </WorkspaceFrame>
</template>
