<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { ElConfigProvider } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import ShellMenu from '@renderer/components/ShellMenu.vue'
import PluginView from '@renderer/views/PluginView.vue'
import { useLicenseGlobalGuard } from '@renderer/composables/useLicenseGuard'
import { useThemeStore } from '@renderer/stores/theme'
import { usePluginStore } from '@renderer/stores/plugins'
import { useLicenseStore } from '@renderer/stores/license'
import { usePluginWindowStore } from '@renderer/stores/pluginWindow'
import { useProductIntro } from '@renderer/composables/useProductIntro'
import ProductIntroDialog from '@renderer/components/ProductIntroDialog.vue'

const theme = useThemeStore()
const plugins = usePluginStore()
const license = useLicenseStore()
const pluginWindow = usePluginWindowStore()
const route = useRoute()
const { introOpen, introTitle, introMarkdown } = useProductIntro()

useLicenseGlobalGuard()

const showStandardRoute = computed(() => route.name !== 'plugin')

const pluginPaneIds = computed(() => {
  const ids = new Set(pluginWindow.openedIds)
  if (route.name === 'plugin') {
    const id = String(route.params.pluginId ?? '').trim()
    if (id) ids.add(id)
  }
  return [...ids]
})

onMounted(async () => {
  await theme.hydrateFromMain()
  await license.hydrate()
  await plugins.loadAll()
})
</script>

<template>
  <ElConfigProvider :locale="zhCn">
    <div class="um-app min-h-screen bg-[var(--um-bg)] text-[var(--um-text)] transition-colors duration-200">
      <ShellMenu />
      <main class="um-canvas-main relative min-h-screen pl-0 pt-0">
        <!-- 标准路由：RouterView 保持挂载（v-show），不用 Transition，避免层显示时 opacity 卡在 0 -->
        <div v-show="showStandardRoute" class="standard-route-layer">
          <RouterView v-slot="{ Component, route: r }">
            <component
              v-if="r.name !== 'plugin' && Component"
              :is="Component"
              :key="r.fullPath"
            />
          </RouterView>
        </div>
        <!-- 插件层：KeepAlive 保留已打开插件 -->
        <div v-show="!showStandardRoute" class="plugin-route-layer">
          <KeepAlive>
            <PluginView
              v-for="id in pluginPaneIds"
              v-show="String(route.params.pluginId) === id"
              :key="id"
              :plugin-id="id"
              class="plugin-cache-pane"
            />
          </KeepAlive>
        </div>
      </main>
      <ProductIntroDialog
        v-model="introOpen"
        :title="introTitle"
        :markdown="introMarkdown"
      />
    </div>
  </ElConfigProvider>
</template>

<style scoped>
.standard-route-layer,
.plugin-route-layer {
  min-height: 100vh;
}

.plugin-route-layer {
  position: relative;
}

.plugin-cache-pane {
  min-height: 100vh;
}
</style>
