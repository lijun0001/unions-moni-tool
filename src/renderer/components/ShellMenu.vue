<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePluginStore } from '@renderer/stores/plugins'
import { usePluginWindowStore } from '@renderer/stores/pluginWindow'
import { useThemeStore } from '@renderer/stores/theme'
import { useLicenseStore } from '@renderer/stores/license'

const router = useRouter()
const route = useRoute()
const plugins = usePluginStore()
const pluginWindow = usePluginWindowStore()
const theme = useThemeStore()
const license = useLicenseStore()

const open = ref(false)
const expanded = ref<'home' | 'settings' | 'help' | null>(null)
const hoverMenu = ref(false)

const pluginLinks = computed(() =>
  plugins.items.map((p) => ({
    id: p.record.id,
    title: p.plugin?.homeCard.title ?? p.record.name,
    error: p.error,
  })),
)

const openedPluginCards = computed(() =>
  pluginWindow.openedIds.map((id) => {
    const hit = plugins.byId.get(id)
    return {
      id,
      title: hit?.plugin?.homeCard.title ?? hit?.record.name ?? id,
    }
  }),
)

function toggleSection(s: typeof expanded.value) {
  expanded.value = expanded.value === s ? null : s
}

async function go(path: string) {
  if (path !== '/help/license' && !(await license.guardAction())) return
  router.push(path)
  open.value = false
  expanded.value = null
}

function closeOpenedPlugin(id: string) {
  if (route.name === 'plugin' && String(route.params.pluginId ?? '') === id) {
    router.push('/')
  }
  pluginWindow.close(id)
}

async function goOpenedPlugin(id: string) {
  if (!(await license.guardAction())) return
  router.push(`/plugin/${id}`)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    open.value = false
    expanded.value = null
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

watch(
  () => route.fullPath,
  () => {
    open.value = false
    expanded.value = null
    if (route.name === 'plugin') {
      const id = String(route.params.pluginId ?? '').trim()
      if (!id) return
      pluginWindow.markOpened(id)
    }
  },
  { immediate: true },
)
</script>

<template>
  <div class="pointer-events-none fixed left-0 top-0 z-[5000] flex w-full">
    <Transition name="um-fade">
      <button
        v-if="open"
        type="button"
        class="pointer-events-auto fixed inset-0 z-[4990] cursor-default border-0 bg-black/35 p-0"
        aria-label="关闭菜单"
        @click="open = false"
      />
    </Transition>
    <div
      class="pointer-events-auto relative z-[5000] p-[var(--space-lg)]"
      @mouseenter="hoverMenu = true"
      @mouseleave="hoverMenu = false"
    >
      <div class="relative">
        <button
          type="button"
          class="um-display flex h-11 w-11 items-center justify-center rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] text-sm font-semibold text-[var(--um-text)] shadow-sm transition duration-200 ease-out-quart hover:bg-[var(--um-surface-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--um-brand)]"
          :aria-expanded="open"
          aria-label="打开菜单"
          @click="open = !open"
        >
          ≡
        </button>
        <Transition name="um-fade">
          <div v-if="hoverMenu && openedPluginCards.length > 0" class="absolute left-[calc(100%+10px)] top-0 z-[5001] w-[min(56vw,340px)] rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] p-2 shadow-xl">
            <div class="mb-1 px-1 text-xs text-[var(--um-text-muted)]">已打开插件</div>
            <div class="max-h-[300px] space-y-1 overflow-auto">
              <div
                v-for="card in openedPluginCards"
                :key="card.id"
                class="flex items-center gap-2 rounded-md border border-[var(--um-border)] bg-[var(--um-surface-2)] px-2 py-1.5"
              >
                <button
                  type="button"
                  class="min-w-0 flex-1 truncate text-left text-sm text-[var(--um-text)] hover:text-[var(--um-brand)]"
                  @click="goOpenedPlugin(card.id)"
                >
                  {{ card.title }}
                </button>
                <button
                  type="button"
                  class="shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--um-text-muted)] hover:bg-[var(--um-bg)] hover:text-[var(--el-color-danger)]"
                  @click="closeOpenedPlugin(card.id)"
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        </Transition>
      </div>
    </div>

    <Transition name="um-drawer">
      <div
        v-if="open"
        class="pointer-events-auto absolute left-[var(--space-lg)] top-[calc(var(--space-lg)+3rem)] z-[5000] w-[min(92vw,320px)] overflow-hidden rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] shadow-xl"
        role="dialog"
        aria-modal="true"
      >
        <div class="flex max-h-[min(70vh,560px)] flex-col gap-1 p-[var(--space-md)]">
          <button
            type="button"
            class="rounded-lg px-3 py-2 text-left text-sm font-semibold text-[var(--um-text)] hover:bg-[var(--um-surface-2)]"
            @click="go('/')"
          >
            首页
          </button>

          <div class="rounded-lg bg-[var(--um-bg)]/40">
            <button
              type="button"
              class="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold text-[var(--um-text)] hover:bg-[var(--um-surface-2)]"
              @click="toggleSection('home')"
            >
              首页功能
              <span class="text-[var(--um-text-muted)]">{{ expanded === 'home' ? '▾' : '▸' }}</span>
            </button>
            <Transition name="um-accordion">
              <div v-if="expanded === 'home'" class="border-t border-[var(--um-border)]/60 px-2 py-2">
                <p v-if="pluginLinks.length === 0" class="px-2 py-1 text-xs text-[var(--um-text-muted)]">
                  暂无已加载插件
                </p>
                <button
                  v-for="p in pluginLinks"
                  :key="p.id"
                  type="button"
                  class="block w-full rounded-md px-2 py-2 text-left text-sm text-[var(--um-text)] hover:bg-[var(--um-surface-2)]"
                  @click="go(`/plugin/${p.id}`)"
                >
                  <span>{{ p.title }}</span>
                  <span v-if="p.error" class="mt-0.5 block text-xs text-[var(--el-color-danger)]">
                    {{ p.error }}
                  </span>
                </button>
              </div>
            </Transition>
          </div>

          <div class="rounded-lg bg-[var(--um-bg)]/40">
            <button
              type="button"
              class="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold text-[var(--um-text)] hover:bg-[var(--um-surface-2)]"
              @click="toggleSection('settings')"
            >
              工具配置
              <span class="text-[var(--um-text-muted)]">{{ expanded === 'settings' ? '▾' : '▸' }}</span>
            </button>
            <Transition name="um-accordion">
              <div v-if="expanded === 'settings'" class="border-t border-[var(--um-border)]/60 px-2 py-2">
                <button
                  type="button"
                  class="block w-full rounded-md px-2 py-2 text-left text-sm text-[var(--um-text)] hover:bg-[var(--um-surface-2)]"
                  @click="go('/settings/import')"
                >
                  导入功能
                </button>
              </div>
            </Transition>
          </div>

          <div class="rounded-lg bg-[var(--um-bg)]/40">
            <button
              type="button"
              class="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold text-[var(--um-text)] hover:bg-[var(--um-surface-2)]"
              @click="toggleSection('help')"
            >
              帮助
              <span class="text-[var(--um-text-muted)]">{{ expanded === 'help' ? '▾' : '▸' }}</span>
            </button>
            <Transition name="um-accordion">
              <div v-if="expanded === 'help'" class="border-t border-[var(--um-border)]/60 px-2 py-2">
                <button
                  type="button"
                  class="block w-full rounded-md px-2 py-2 text-left text-sm text-[var(--um-text)] hover:bg-[var(--um-surface-2)]"
                  @click="go('/help/about')"
                >
                  关于我们
                </button>
                <button
                  type="button"
                  class="block w-full rounded-md px-2 py-2 text-left text-sm text-[var(--um-text)] hover:bg-[var(--um-surface-2)]"
                  @click="go('/help/license')"
                >
                  注册激活
                </button>
              </div>
            </Transition>
          </div>

          <div class="mt-2 border-t border-[var(--um-border)]/60 pt-3">
            <p class="px-2 pb-2 text-xs text-[var(--um-text-muted)]">主题</p>
            <div class="flex flex-wrap gap-2 px-2">
              <button
                v-for="m in ['dark', 'light', 'system'] as const"
                :key="m"
                type="button"
                class="rounded-md border px-2 py-1 text-xs transition"
                :class="
                  theme.mode === m
                    ? 'border-[var(--um-brand)] text-[var(--um-text)]'
                    : 'border-[var(--um-border)] text-[var(--um-text-muted)] hover:border-[var(--um-brand-muted)]'
                "
                @click="theme.setMode(m)"
              >
                {{ m === 'dark' ? '深色' : m === 'light' ? '浅色' : '跟随系统' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.um-drawer-enter-active,
.um-drawer-leave-active {
  transition:
    transform 0.2s cubic-bezier(0.25, 1, 0.5, 1),
    opacity 0.2s ease-out;
}
.um-drawer-enter-from,
.um-drawer-leave-to {
  opacity: 0;
  transform: translateX(-12px);
}
.um-accordion-enter-active,
.um-accordion-leave-active {
  transition: opacity 0.16s ease-out;
}
.um-accordion-enter-from,
.um-accordion-leave-to {
  opacity: 0;
}

.um-fade-enter-active,
.um-fade-leave-active {
  transition: opacity 0.18s ease-out;
}
.um-fade-enter-from,
.um-fade-leave-to {
  opacity: 0;
}
</style>
