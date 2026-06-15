<script setup lang="ts">
withDefaults(
  defineProps<{
    /** 插件等全高页面使用 fill 变体 */
    fill?: boolean
  }>(),
  { fill: false },
)

defineOptions({ inheritAttrs: false })
</script>

<template>
  <!-- um-layer-page-shell:START -->
  <div class="um-page-shell" data-um-layer="page-shell" v-bind="$attrs">
    <div
      class="um-workspace-panel"
      :class="{ 'um-workspace-panel--fill': fill }"
      data-um-layer="workspace-panel"
    >
      <slot />
    </div>
  </div>
  <!-- um-layer-page-shell:END -->
</template>
