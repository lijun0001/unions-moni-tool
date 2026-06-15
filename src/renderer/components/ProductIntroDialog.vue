<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { Close } from '@element-plus/icons-vue'
import { parseIntroToc, renderIntroMarkdownHtml } from '@renderer/utils/markdown-intro'

const props = defineProps<{
  modelValue: boolean
  title: string
  markdown: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const PANEL_W = 860
const PANEL_H_EST = 560

const contentRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const activeId = ref('')
const pos = ref({ x: 0, y: 0 })
const zIndex = ref(6200)

const toc = computed(() => parseIntroToc(props.markdown))
const html = computed(() => renderIntroMarkdownHtml(props.markdown))

const panelStyle = computed(() => ({
  left: `${pos.value.x}px`,
  top: `${pos.value.y}px`,
  zIndex: zIndex.value,
}))

function resetPosition() {
  const w = typeof window !== 'undefined' ? window.innerWidth : PANEL_W
  const h = typeof window !== 'undefined' ? window.innerHeight : PANEL_H_EST
  const pw = Math.min(PANEL_W, w - 32)
  pos.value = {
    x: Math.max(16, Math.round((w - pw) / 2)),
    y: Math.max(24, Math.round(h * 0.06)),
  }
}

function bringToFront() {
  zIndex.value = 6200 + (Date.now() % 100)
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    resetPosition()
    bringToFront()
    activeId.value = toc.value[0]?.id ?? ''
    nextTick(() => {
      contentRef.value && (contentRef.value.scrollTop = 0)
    })
  },
)

function close() {
  emit('update:modelValue', false)
}

function scrollToSection(id: string) {
  activeId.value = id
  const root = contentRef.value
  const target = root?.querySelector(`#${CSS.escape(id)}`)
  if (target instanceof HTMLElement && root) {
    const top = target.offsetTop - root.offsetTop - 8
    root.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }
}

function onContentScroll() {
  const root = contentRef.value
  if (!root || toc.value.length === 0) return
  const scrollTop = root.scrollTop + 12
  let current = toc.value[0]?.id ?? ''
  for (const item of toc.value) {
    const el = root.querySelector(`#${CSS.escape(item.id)}`)
    if (el instanceof HTMLElement && el.offsetTop - root.offsetTop <= scrollTop) {
      current = item.id
    }
  }
  activeId.value = current
}

let dragging = false
let dragOffset = { x: 0, y: 0 }

function clampPosition(x: number, y: number) {
  const el = panelRef.value
  const w = window.innerWidth
  const h = window.innerHeight
  const pw = el?.offsetWidth ?? PANEL_W
  const ph = el?.offsetHeight ?? PANEL_H_EST
  return {
    x: Math.min(Math.max(0, x), Math.max(0, w - pw)),
    y: Math.min(Math.max(0, y), Math.max(0, h - Math.min(ph, h))),
  }
}

function onDragStart(event: MouseEvent) {
  if (event.button !== 0) return
  bringToFront()
  dragging = true
  dragOffset = {
    x: event.clientX - pos.value.x,
    y: event.clientY - pos.value.y,
  }
  document.addEventListener('mousemove', onDragMove)
  document.addEventListener('mouseup', onDragEnd)
  event.preventDefault()
}

function onDragMove(event: MouseEvent) {
  if (!dragging) return
  pos.value = clampPosition(event.clientX - dragOffset.x, event.clientY - dragOffset.y)
}

function onDragEnd() {
  dragging = false
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
}

function onPanelPointerDown() {
  bringToFront()
}

onUnmounted(() => {
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="modelValue"
      ref="panelRef"
      class="product-intro-float"
      :style="panelStyle"
      role="dialog"
      aria-modal="false"
      :aria-label="title"
      @mousedown="onPanelPointerDown"
    >
      <header class="product-intro-float__header" @mousedown="onDragStart">
        <h2 class="product-intro-float__title">{{ title }}</h2>
        <button
          type="button"
          class="product-intro-float__close"
          aria-label="关闭"
          @mousedown.stop
          @click="close"
        >
          <Close class="h-4 w-4" />
        </button>
      </header>

      <div class="product-intro-layout">
        <nav v-if="toc.length" class="product-intro-nav" aria-label="文档目录">
          <button
            v-for="item in toc"
            :key="item.id"
            type="button"
            class="product-intro-nav-item"
            :class="{
              'product-intro-nav-item--active': activeId === item.id,
              [`product-intro-nav-item--l${item.level}`]: true,
            }"
            @click="scrollToSection(item.id)"
          >
            {{ item.title }}
          </button>
        </nav>
        <div
          ref="contentRef"
          class="product-intro-content um-scroll-unified"
          @scroll.passive="onContentScroll"
          v-html="html"
        />
      </div>

      <footer class="product-intro-float__footer">
        <button type="button" class="product-intro-float__btn" @click="close">关闭</button>
      </footer>
    </div>
  </Teleport>
</template>

<style scoped>
.product-intro-float {
  position: fixed;
  display: flex;
  width: min(860px, calc(100vw - 32px));
  max-height: min(720px, calc(100vh - 48px));
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--um-border);
  border-radius: var(--um-radius);
  background: var(--um-surface);
  box-shadow: var(--um-workspace-shadow, 0 12px 40px color-mix(in oklab, var(--um-text) 18%, transparent));
  pointer-events: auto;
}

.product-intro-float__header {
  display: flex;
  flex-shrink: 0;
  cursor: grab;
  user-select: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  border-bottom: 1px solid var(--um-border);
  padding: 0.75rem 1rem;
  background: var(--um-surface-2);
}

.product-intro-float__header:active {
  cursor: grabbing;
}

.product-intro-float__title {
  margin: 0;
  font-family: Lexend, ui-sans-serif, system-ui, sans-serif;
  font-size: 1rem;
  font-weight: 600;
  color: var(--um-text);
}

.product-intro-float__close {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: calc(var(--um-radius) - 2px);
  background: transparent;
  padding: 0.25rem;
  color: var(--um-text-muted);
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.product-intro-float__close:hover {
  color: var(--um-text);
  background: color-mix(in oklab, var(--um-text) 8%, transparent);
}

.product-intro-layout {
  display: flex;
  min-height: 0;
  flex: 1;
  gap: var(--space-md);
  padding: var(--space-md) var(--space-md) 0;
}

.product-intro-nav {
  flex: 0 0 200px;
  overflow: auto;
  border-right: 1px solid var(--um-border);
  padding-right: var(--space-sm);
}

.product-intro-nav-item {
  display: block;
  width: 100%;
  border: 0;
  background: transparent;
  text-align: left;
  padding: 0.35rem 0.5rem;
  border-radius: calc(var(--um-radius) - 2px);
  font-size: 0.8125rem;
  line-height: 1.4;
  color: var(--um-text-muted);
  cursor: pointer;
}

.product-intro-nav-item:hover {
  color: var(--um-text);
  background: var(--um-surface-2);
}

.product-intro-nav-item--active {
  color: var(--um-text);
  background: color-mix(in oklab, var(--um-brand) 14%, var(--um-surface-2));
  font-weight: 600;
}

.product-intro-nav-item--l2 {
  padding-left: 0.85rem;
}

.product-intro-nav-item--l3 {
  padding-left: 1.25rem;
  font-size: 0.75rem;
}

.product-intro-content {
  flex: 1;
  overflow: auto;
  padding-right: 0.25rem;
  font-size: 0.875rem;
  line-height: 1.65;
  color: var(--um-text);
}

.product-intro-content :deep(.intro-md-h1) {
  font-size: 1.35rem;
  font-weight: 700;
  margin: 0 0 0.75rem;
}

.product-intro-content :deep(.intro-md-h2) {
  font-size: 1.1rem;
  font-weight: 650;
  margin: 1.25rem 0 0.5rem;
}

.product-intro-content :deep(.intro-md-h3) {
  font-size: 0.95rem;
  font-weight: 600;
  margin: 1rem 0 0.35rem;
}

.product-intro-content :deep(.intro-md-p) {
  margin: 0.45rem 0;
}

.product-intro-content :deep(.intro-md-ul),
.product-intro-content :deep(.intro-md-ol) {
  margin: 0.35rem 0 0.65rem;
  padding-left: 1.25rem;
}

.product-intro-content :deep(.intro-md-table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.65rem 0;
  font-size: 0.8125rem;
}

.product-intro-content :deep(.intro-md-table th),
.product-intro-content :deep(.intro-md-table td) {
  border: 1px solid var(--um-border);
  padding: 0.35rem 0.5rem;
  text-align: left;
}

.product-intro-content :deep(.intro-md-table th) {
  background: var(--um-surface-2);
}

.product-intro-content :deep(.intro-md-pre) {
  margin: 0.65rem 0;
  padding: 0.65rem 0.75rem;
  border-radius: calc(var(--um-radius) - 2px);
  background: var(--um-surface-2);
  overflow: auto;
  font-size: 0.75rem;
}

.product-intro-content :deep(.intro-md-quote) {
  margin: 0.65rem 0;
  padding: 0.5rem 0.75rem;
  border-left: 3px solid var(--um-brand-muted);
  color: var(--um-text-muted);
  background: var(--um-surface-2);
}

.product-intro-content :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.85em;
  background: var(--um-surface-2);
  padding: 0.05rem 0.25rem;
  border-radius: 3px;
}

.product-intro-content :deep(.intro-md-hr) {
  border: 0;
  border-top: 1px solid var(--um-border);
  margin: 1rem 0;
}

.product-intro-float__footer {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--um-border);
  padding: 0.65rem 1rem;
  background: var(--um-surface);
}

.product-intro-float__btn {
  border: 0;
  border-radius: calc(var(--um-radius) - 2px);
  background: var(--um-brand);
  padding: 0.45rem 1rem;
  font-size: 0.875rem;
  font-weight: 600;
  color: oklch(0.15 0.02 250);
  cursor: pointer;
}

.product-intro-float__btn:hover {
  filter: brightness(1.08);
}
</style>
