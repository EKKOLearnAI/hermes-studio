<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from "vue";

type VirtualItem = {
  id: string | number;
}

const props = withDefaults(defineProps<{
  messages: VirtualItem[];
  estimatedItemHeight?: number;
  overscan?: number;
  rowGap?: number;
  padding?: string;
  topThreshold?: number;
}>(), {
  estimatedItemHeight: 180,
  overscan: 8,
  rowGap: 16,
  padding: "20px",
  topThreshold: 120,
});

const emit = defineEmits<{
  scroll: [];
  topReach: [];
}>();

defineSlots<{
  empty?: () => any;
  before?: () => any;
  item?: (props: { message: any }) => any;
  after?: () => any;
}>();

const scrollerRef = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
const heightVersion = ref(0);
const forcedRange = ref<{ start: number; end: number } | null>(null);
const measuredHeights = new Map<string, number>();
const observedElements = new Map<string, HTMLElement>();
const observers = new Map<string, ResizeObserver>();
let keepBottomUntil = 0;
let bottomFrame: number | null = null;
let anchorFrame: number | null = null;
let anchorToken = 0;
let activeAnchorTarget: { token: number; messageId: string; anchorId: string; key: string } | null = null;

const messageKeys = computed(() => props.messages.map(messageKey));

function messageKey(message: VirtualItem): string {
  return String(message.id);
}

function itemHeight(key: string): number {
  return measuredHeights.get(key) || props.estimatedItemHeight;
}

function measuredRowHeight(el: HTMLElement): number {
  return Math.ceil(el.getBoundingClientRect().height || props.estimatedItemHeight);
}

function setMeasuredHeight(key: string, height: number) {
  const oldHeight = itemHeight(key);
  if (oldHeight === height) return;

  const el = scrollerRef.value;
  const shouldKeepBottom = !!el && (Date.now() < keepBottomUntil || isNearBottom(64));
  const shouldKeepAnchor = !!activeAnchorTarget;
  const index = messageKeys.value.indexOf(key);
  if (index >= 0 && !shouldKeepBottom && !shouldKeepAnchor) {
    const rowTop = layout.value.offsets[index] || 0;
    const delta = height - oldHeight;
    if (el && rowTop < scrollTop.value && delta !== 0) {
      el.scrollTop = Math.max(0, el.scrollTop + delta);
      syncViewport();
    }
  }

  measuredHeights.set(key, height);
  heightVersion.value += 1;
  if (shouldKeepBottom) scheduleScrollToBottom(2);
  if (shouldKeepAnchor && activeAnchorTarget) scheduleAnchorAlignment(activeAnchorTarget.token, 4);
}

const layout = computed(() => {
  heightVersion.value;
  const offsets: number[] = [];
  let total = 0;
  for (const key of messageKeys.value) {
    offsets.push(total);
    total += itemHeight(key);
  }
  return { offsets, total };
});

const visibleRange = computed(() => {
  const count = props.messages.length;
  if (count === 0) return { start: 0, end: -1 };
  if (forcedRange.value) {
    return {
      start: Math.max(0, Math.min(count - 1, forcedRange.value.start)),
      end: Math.max(0, Math.min(count - 1, forcedRange.value.end)),
    };
  }

  const overscanPx = props.estimatedItemHeight * props.overscan;
  const startPx = Math.max(0, scrollTop.value - overscanPx);
  const endPx = scrollTop.value + viewportHeight.value + overscanPx;
  const { offsets } = layout.value;

  let start = 0;
  let low = 0;
  let high = count - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const bottom = offsets[mid] + itemHeight(messageKeys.value[mid]);
    if (bottom < startPx) low = mid + 1;
    else {
      start = mid;
      high = mid - 1;
    }
  }

  let end = start;
  while (end < count - 1 && offsets[end] < endPx) end += 1;
  return { start, end };
});

const visibleMessages = computed(() => {
  const { start, end } = visibleRange.value;
  return end >= start ? props.messages.slice(start, end + 1) : [];
});

const topSpacerHeight = computed(() => layout.value.offsets[visibleRange.value.start] || 0);
const bottomSpacerHeight = computed(() => {
  const { end } = visibleRange.value;
  if (end < 0) return 0;
  const nextOffset = end + 1 < props.messages.length
    ? layout.value.offsets[end + 1]
    : layout.value.total;
  return Math.max(0, layout.value.total - nextOffset);
});

function setItemRef(key: string, el: Element | ComponentPublicInstance | null) {
  const existing = observedElements.get(key);
  if (existing === el) return;

  observers.get(key)?.disconnect();
  observers.delete(key);
  observedElements.delete(key);

  if (!(el instanceof HTMLElement)) return;

  observedElements.set(key, el);
  if (typeof ResizeObserver === "undefined") {
    setMeasuredHeight(key, measuredRowHeight(el));
    return;
  }

  const observer = new ResizeObserver(() => setMeasuredHeight(key, measuredRowHeight(el)));
  observer.observe(el);
  observers.set(key, observer);
}

function syncViewport() {
  const el = scrollerRef.value;
  if (!el) return;
  scrollTop.value = el.scrollTop;
  viewportHeight.value = el.clientHeight;
}

function handleScroll() {
  syncViewport();
  emit("scroll");
  if (scrollTop.value <= props.topThreshold) emit("topReach");
}

function isNearBottom(threshold = 200): boolean {
  const el = scrollerRef.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

function scrollToBottom() {
  keepBottomUntil = Date.now() + 700;
  nextTick(() => {
    scheduleScrollToBottom(3);
  });
}

function setScrollToBottomNow() {
  const el = scrollerRef.value;
  if (!el) return;
  el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  syncViewport();
}

function scheduleScrollToBottom(frames = 1) {
  if (bottomFrame != null) cancelAnimationFrame(bottomFrame);

  const step = (remaining: number) => {
    setScrollToBottomNow();
    if (remaining <= 1) {
      bottomFrame = null;
      return;
    }
    bottomFrame = requestAnimationFrame(() => step(remaining - 1));
  };

  bottomFrame = requestAnimationFrame(() => step(frames));
}

function forceRangeAround(index: number) {
  forcedRange.value = {
    start: Math.max(0, index - 3),
    end: Math.min(props.messages.length - 1, index + 6),
  };
}

function findTargetElement(messageId: string, anchorId: string): HTMLElement | null {
  const el = scrollerRef.value;
  if (!el) return null;

  const anchor = document.getElementById(anchorId);
  if (anchor instanceof HTMLElement && el.contains(anchor)) return anchor;

  const message = document.getElementById(`message-${messageId}`);
  if (message instanceof HTMLElement && el.contains(message)) return message;

  return null;
}

function alignAnchorTarget(target: { messageId: string; anchorId: string }): boolean {
  const el = scrollerRef.value;
  if (!el) return false;

  const targetEl = findTargetElement(target.messageId, target.anchorId);
  if (!targetEl) return false;

  const scrollerRect = el.getBoundingClientRect();
  const targetRect = targetEl.getBoundingClientRect();
  const delta = targetRect.top - scrollerRect.top - 24;
  if (Math.abs(delta) > 1) {
    el.scrollTop = Math.max(0, el.scrollTop + delta);
    syncViewport();
    return false;
  }

  syncViewport();
  return true;
}

function clearAnchorTarget(token: number) {
  if (!activeAnchorTarget || activeAnchorTarget.token !== token) return;
  activeAnchorTarget = null;
  forcedRange.value = null;
  nextTick(syncViewport);
}

function scheduleAnchorAlignment(token: number, frames = 1) {
  if (anchorFrame != null) cancelAnimationFrame(anchorFrame);

  const step = (remaining: number) => {
    const target = activeAnchorTarget;
    if (!target || target.token !== token) {
      anchorFrame = null;
      return;
    }

    alignAnchorTarget(target);
    if (remaining <= 1) {
      anchorFrame = null;
      clearAnchorTarget(token);
      return;
    }
    anchorFrame = requestAnimationFrame(() => step(remaining - 1));
  };

  anchorFrame = requestAnimationFrame(() => step(frames));
}

function cancelAnchorTarget() {
  anchorToken += 1;
  activeAnchorTarget = null;
  forcedRange.value = null;
  if (anchorFrame != null) {
    cancelAnimationFrame(anchorFrame);
    anchorFrame = null;
  }
}

function scrollToMessage(messageId: string) {
  const index = props.messages.findIndex(message => String(message.id) === messageId);
  if (index < 0) return;

  nextTick(() => {
    const el = scrollerRef.value;
    if (!el) return;
    el.scrollTop = Math.max(0, (layout.value.offsets[index] || 0) - el.clientHeight / 2);
    syncViewport();
    nextTick(() => {
      document.getElementById(`message-${messageId}`)?.scrollIntoView({ block: "center" });
    });
  });
}

function scrollToAnchor(messageId: string, anchorId: string) {
  const index = props.messages.findIndex(message => String(message.id) === messageId);
  if (index < 0) return;

  cancelAnchorTarget();
  const token = anchorToken;
  activeAnchorTarget = {
    token,
    messageId,
    anchorId,
    key: messageKey(props.messages[index]),
  };
  forceRangeAround(index);

  nextTick(() => {
    const el = scrollerRef.value;
    if (!el) {
      clearAnchorTarget(token);
      return;
    }
    el.scrollTop = Math.max(0, (layout.value.offsets[index] || 0) - 24);
    syncViewport();
    scheduleAnchorAlignment(token, 8);
  });
}

function captureScrollPosition() {
  const el = scrollerRef.value;
  if (!el) return null;
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
  };
}

function restoreScrollPosition(snapshot: { scrollTop: number; scrollHeight: number } | null) {
  if (!snapshot) return;
  nextTick(() => {
    const el = scrollerRef.value;
    if (!el) return;
    el.scrollTop = Math.max(0, el.scrollHeight - snapshot.scrollHeight + snapshot.scrollTop);
    syncViewport();
  });
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  syncViewport();
  if (scrollerRef.value && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(syncViewport);
    resizeObserver.observe(scrollerRef.value);
  }
});

onBeforeUnmount(() => {
  if (bottomFrame != null) cancelAnimationFrame(bottomFrame);
  if (anchorFrame != null) cancelAnimationFrame(anchorFrame);
  resizeObserver?.disconnect();
  for (const observer of observers.values()) observer.disconnect();
  observers.clear();
  observedElements.clear();
});

watch(messageKeys, keys => {
  const activeKeys = new Set(keys);
  for (const key of [...observedElements.keys()]) {
    if (activeKeys.has(key)) continue;
    observers.get(key)?.disconnect();
    observers.delete(key);
    observedElements.delete(key);
  }
  let droppedHeights = false;
  for (const key of [...measuredHeights.keys()]) {
    if (activeKeys.has(key)) continue;
    measuredHeights.delete(key);
    droppedHeights = true;
  }
  if (droppedHeights) heightVersion.value += 1;
  if (activeAnchorTarget && !activeKeys.has(activeAnchorTarget.key)) cancelAnchorTarget();
  nextTick(syncViewport);
});

defineExpose({
  isNearBottom,
  scrollToBottom,
  scrollToMessage,
  scrollToAnchor,
  captureScrollPosition,
  restoreScrollPosition,
});
</script>

<template>
  <div
    ref="scrollerRef"
    class="virtual-message-list"
    :style="{ '--virtual-row-gap': `${rowGap}px`, '--virtual-list-padding': padding }"
    @scroll="handleScroll"
  >
    <slot v-if="messages.length === 0" name="empty" />
    <template v-else>
      <slot name="before" />
      <div class="virtual-spacer" :style="{ height: `${topSpacerHeight}px` }" />
      <div
        v-for="msg in visibleMessages"
        :key="msg.id"
        :ref="(el) => setItemRef(messageKey(msg), el)"
        class="virtual-row"
      >
        <slot name="item" :message="msg" />
      </div>
      <div class="virtual-spacer" :style="{ height: `${bottomSpacerHeight}px` }" />
    </template>
    <slot name="after" />
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.virtual-message-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--virtual-list-padding);
  display: flex;
  flex-direction: column;
  background-color: $bg-card;
  position: relative;

  .dark & {
    background-color: #333333;
  }
}

.virtual-spacer {
  flex: 0 0 auto;
}

.virtual-row {
  padding-bottom: var(--virtual-row-gap);
}
</style>
