<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePluginStore } from '@renderer/stores/plugins'
import { usePluginWindowStore } from '@renderer/stores/pluginWindow'
import { useThemeStore } from '@renderer/stores/theme'
import { useLicenseStore } from '@renderer/stores/license'
import { useProductIntro } from '@renderer/composables/useProductIntro'
import IntroHelpIcon from '@renderer/components/IntroHelpIcon.vue'

const router = useRouter()
const route = useRoute()
const plugins = usePluginStore()
const pluginWindow = usePluginWindowStore()
const theme = useThemeStore()
const license = useLicenseStore()
const { hasProductIntro, openProductIntro } = useProductIntro()

const open = ref(false)
const expanded = ref<'home' | 'settings' | 'help' | null>(null)

const cardStripRef = ref<HTMLElement | null>(null)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)

const pluginLinks = computed(() =>
  plugins.items.map((p) => ({
    id: p.record.id,
    title: p.plugin?.homeCard.title ?? p.record.name,
    error: p.error,
    introMarkdown: p.plugin?.introMarkdown,
  })),
)

function openPluginIntro(p: { title: string; introMarkdown?: string }, event: Event) {
  event.stopPropagation()
  openProductIntro(p.title, p.introMarkdown)
}

const openedPluginCards = computed(() =>
  pluginWindow.openedIds.map((id) => {
    const hit = plugins.byId.get(id)
    return {
      id,
      title: hit?.plugin?.homeCard.title ?? hit?.record.name ?? id,
    }
  }),
)

const activePluginId = computed(() =>
  route.name === 'plugin' ? String(route.params.pluginId ?? '').trim() : '',
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

async function goHome() {
  await go('/')
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

function updateCardScrollState() {
  const el = cardStripRef.value
  if (!el) {
    canScrollLeft.value = false
    canScrollRight.value = false
    return
  }
  const max = Math.max(0, el.scrollWidth - el.clientWidth)
  canScrollLeft.value = el.scrollLeft > 1
  canScrollRight.value = el.scrollLeft < max - 1
}

function scrollCards(direction: 'left' | 'right') {
  const el = cardStripRef.value
  if (!el) return
  const step = Math.max(160, Math.floor(el.clientWidth * 0.72))
  el.scrollBy({ left: direction === 'left' ? -step : step, behavior: 'smooth' })
}

let stripResizeObserver: ResizeObserver | null = null

function bindStripObserver() {
  stripResizeObserver?.disconnect()
  const el = cardStripRef.value
  if (!el || typeof ResizeObserver === 'undefined') return
  stripResizeObserver = new ResizeObserver(() => updateCardScrollState())
  stripResizeObserver.observe(el)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    open.value = false
    expanded.value = null
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  nextTick(() => {
    bindStripObserver()
    updateCardScrollState()
  })
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  stripResizeObserver?.disconnect()
  stripResizeObserver = null
})

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
    nextTick(updateCardScrollState)
  },
  { immediate: true },
)

watch(openedPluginCards, () => nextTick(updateCardScrollState), { deep: true })
</script>

<template>
  <div class="pointer-events-none fixed left-0 top-0 z-[5000] w-full">
    <Transition name="um-fade">
      <button
        v-if="open"
        type="button"
        class="pointer-events-auto fixed inset-0 z-[4990] cursor-default border-0 bg-[color-mix(in_oklab,var(--um-text)_32%,transparent)] p-0"
        aria-label="关闭菜单"
        @click="open = false"
      />
    </Transition>

    <!-- um-layer-chrome:START — 回滚：改回单层 div.p-[var(--space-lg)] -->
    <header class="um-shell-chrome pointer-events-auto relative z-[5000]" data-um-layer="chrome">
      <div class="um-shell-chrome__inner">
      <div class="flex shrink-0 items-center gap-2">
        <button
          type="button"
          class="um-display flex h-11 w-11 items-center justify-center rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] text-sm font-semibold text-[var(--um-text)] shadow-sm transition duration-200 ease-out-quart hover:bg-[var(--um-surface-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--um-brand)]"
          :aria-expanded="open"
          aria-label="打开菜单"
          @click="open = !open"
        >
          ≡
        </button>

        <button
          type="button"
          class="um-shell-home-btn"
          aria-label="回到首页"
          title="回到首页"
          @click="goHome"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-8.5Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>

      <div
        v-if="openedPluginCards.length > 0"
        class="um-shell-cards-shell ml-auto flex min-w-0 max-w-[min(72vw,760px)] items-center gap-1 rounded-full border border-[var(--um-border)] bg-[var(--um-surface)]/92 px-1 py-1 shadow-sm backdrop-blur-sm"
      >
        <button
          v-show="canScrollLeft"
          type="button"
          class="um-shell-cards-nav"
          aria-label="向左翻看已打开页面"
          @click="scrollCards('left')"
        >
          ‹
        </button>

        <div
          ref="cardStripRef"
          class="um-shell-cards-strip flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-0.5"
          @scroll="updateCardScrollState"
        >
          <div
            v-for="card in openedPluginCards"
            :key="card.id"
            class="um-shell-page-card group"
            :class="{ 'is-active': activePluginId === card.id }"
          >
            <button
              type="button"
              class="um-shell-page-card-label"
              :title="card.title"
              @click="goOpenedPlugin(card.id)"
            >
              {{ card.title }}
            </button>
            <button
              type="button"
              class="um-shell-page-card-close"
              aria-label="关闭页面"
              @click.stop="closeOpenedPlugin(card.id)"
            >
              ×
            </button>
          </div>
        </div>

        <button
          v-show="canScrollRight"
          type="button"
          class="um-shell-cards-nav"
          aria-label="向右翻看已打开页面"
          @click="scrollCards('right')"
        >
          ›
        </button>
      </div>
      </div>
    </header>
    <!-- um-layer-chrome:END -->

    <Transition name="um-drawer">
      <div
        v-if="open"
        class="pointer-events-auto absolute left-[var(--space-lg)] top-[var(--um-shell-content-top)] z-[5000] w-[min(92vw,320px)] overflow-hidden rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] shadow-xl"
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
                <div
                  v-for="p in pluginLinks"
                  :key="p.id"
                  class="um-shell-menu-row"
                >
                  <button
                    type="button"
                    class="um-shell-menu-row-main"
                    @click="go(`/plugin/${p.id}`)"
                  >
                    <span>{{ p.title }}</span>
                    <span v-if="p.error" class="mt-0.5 block text-xs text-[var(--el-color-danger)]">
                      {{ p.error }}
                    </span>
                  </button>
                  <button
                    v-if="hasProductIntro(p.introMarkdown)"
                    type="button"
                    class="um-shell-menu-help"
                    title="产品介绍"
                    aria-label="查看产品介绍"
                    @click="openPluginIntro(p, $event)"
                  >
                    <IntroHelpIcon />
                  </button>
                </div>
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
.um-shell-home-btn {
  display: inline-flex;
  height: 2.75rem;
  width: 2.75rem;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid var(--um-border);
  background: var(--um-surface);
  color: var(--um-text-muted);
  cursor: pointer;
  transition:
    background 0.2s ease,
    color 0.2s ease,
    border-color 0.2s ease,
    transform 0.15s ease;
}

.um-shell-home-btn:hover {
  color: var(--um-text);
  background: var(--um-surface-2);
  border-color: color-mix(in oklab, var(--um-brand) 35%, var(--um-border));
}

.um-shell-home-btn:active {
  transform: scale(0.96);
}

.um-shell-cards-shell {
  min-height: 2.75rem;
}

.um-shell-cards-strip {
  scrollbar-width: none;
}

.um-shell-cards-strip::-webkit-scrollbar {
  display: none;
}

.um-shell-cards-nav {
  flex-shrink: 0;
  width: 1.75rem;
  height: 1.75rem;
  border: none;
  border-radius: 999px;
  background: var(--um-surface-2);
  color: var(--um-text-muted);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease;
}

.um-shell-cards-nav:hover {
  color: var(--um-text);
  background: color-mix(in oklab, var(--um-brand) 12%, var(--um-surface-2));
}

.um-shell-page-card {
  display: inline-flex;
  max-width: 168px;
  flex-shrink: 0;
  align-items: center;
  gap: 0.25rem;
  border-radius: 999px;
  border: 1px solid var(--um-border);
  background: var(--um-surface-2);
  padding: 0.2rem 0.2rem 0.2rem 0.65rem;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
}

.um-shell-page-card.is-active {
  border-color: color-mix(in oklab, var(--um-brand) 55%, var(--um-border));
  background: color-mix(in oklab, var(--um-brand) 10%, var(--um-surface-2));
  box-shadow: 0 0 0 1px color-mix(in oklab, var(--um-brand) 18%, transparent);
}

.um-shell-page-card-label {
  min-width: 0;
  flex: 1;
  border: none;
  background: transparent;
  padding: 0.2rem 0;
  text-align: left;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--um-text);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.um-shell-page-card-label:hover {
  color: var(--um-brand);
}

.um-shell-page-card-close {
  flex-shrink: 0;
  width: 1.35rem;
  height: 1.35rem;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--um-text-muted);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease;
}

.um-shell-page-card-close:hover {
  color: var(--el-color-danger);
  background: color-mix(in oklab, var(--el-color-danger) 12%, transparent);
}

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

.um-shell-menu-row {
  display: flex;
  align-items: center;
  gap: 0.15rem;
  border-radius: calc(var(--um-radius) - 2px);
  transition: background 0.15s ease;
}

.um-shell-menu-row:hover {
  background: var(--um-surface-2);
}

.um-shell-menu-row-main {
  min-width: 0;
  flex: 1;
  border: 0;
  background: transparent;
  border-radius: calc(var(--um-radius) - 2px);
  padding: 0.5rem 0.35rem 0.5rem 0.5rem;
  text-align: left;
  font-size: 0.875rem;
  color: var(--um-text);
  cursor: pointer;
}

.um-shell-menu-row-main:hover {
  color: var(--um-text);
}

.um-shell-menu-help {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  margin-right: 0.15rem;
  border: 0;
  border-radius: calc(var(--um-radius) - 2px);
  background: transparent;
  color: var(--um-text-muted);
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}

.um-shell-menu-help:hover {
  color: var(--um-brand);
  background: color-mix(in oklab, var(--um-brand) 10%, transparent);
}
</style>
