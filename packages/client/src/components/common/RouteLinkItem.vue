<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'

const props = withDefaults(defineProps<{
  to: RouteLocationRaw
  active?: boolean
  exact?: boolean
  title?: string
}>(), {
  active: undefined,
  exact: false,
})
</script>

<template>
  <RouterLink v-slot="slotProps" :to="props.to" custom>
    <a
      class="route-link-item"
      :class="{ active: props.active ?? (props.exact ? !!slotProps?.isExactActive : !!slotProps?.isActive) }"
      :href="slotProps?.href || '#'"
      :title="props.title"
      :aria-current="(props.active ?? (props.exact ? !!slotProps?.isExactActive : !!slotProps?.isActive)) ? 'page' : undefined"
      @click="slotProps?.navigate"
    >
      <slot />
    </a>
  </RouterLink>
</template>
