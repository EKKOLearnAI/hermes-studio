<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  DynamicScroller,
  DynamicScrollerItem,
  type DynamicScrollerExposed,
  type ScrollToOptions,
} from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";

type VirtualItem = {
  id: string | number;
}

type AnchorAlign = "start" | "center";
type AnchorTarget = {
  token: number;
  index: number;
  messageId: string;
  anchorId: string;
  align: AnchorAlign;
}
type BottomScrollOptions = number | {
  frames?: number;
  keepAliveMs?: number;
}
type ViewportScrollSnapshot = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  wasNearBottom: boolean;
}

const props = withDefaults(defineProps<{
  messages: VirtualItem[];
  virtualized?: boolean;
  estimatedItemHeight?: number;
  overscan?: number;
  rowGap?: number;
  padding?: string;
  topThreshold?: number;
}>(), {
  virtualized: true,
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

const hostRef = ref<HTMLElement | null>(null);
const scrollerRef = ref<DynamicScrollerExposed<VirtualItem> | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
let keepBottomUntil = 0;
let bottomFrame: number | null = null;
let bottomFrameRemaining = 0;
let bottomFrameAttempts = 0;
let programmaticScrollUntil = 0;
let userDetachedFromBottom = false;
let anchorFrame: number | null = null;
let anchorToken = 0;
let activeAnchorTarget: AnchorTarget | null = null;
let viewportRestoreFrame: number | null = null;

const messageKeys = computed(() => props.messages.map(messageKey));
const bufferPx = computed(() => Math.max(props.estimatedItemHeight, props.estimatedItemHeight * props.overscan));

function messageKey(message: VirtualItem): string {
  return String(message.id);
}

function getScrollerElement(): HTMLElement | null {
  return hostRef.value?.querySelector<HTMLElement>(".virtual-message-list") ?? null;
}

function syncViewport() {
  const el = getScrollerElement();
  if (!el) return;
  scrollTop.value = el.scrollTop;
  viewportHeight.value = el.clientHeight;
}

function markProgrammaticScroll(ms = 120) {
  programmaticScrollUntil = Date.now() + ms;
}

function isProgrammaticScroll(): boolean {
  return Date.now() < programmaticScrollUntil;
}

function cancelBottomScroll() {
  keepBottomUntil = 0;
  if (bottomFrame != null) {
    cancelAnimationFrame(bottomFrame);
    bottomFrame = null;
  }
  bottomFrameRemaining = 0;
  bottomFrameAttempts = 0;
}

function handleScroll() {
  const previousScrollTop = scrollTop.value;
  syncViewport();
  const delta = scrollTop.value - previousScrollTop;
  if (delta < -1) {
    userDetachedFromBottom = true;
    cancelBottomScroll();
  } else if (!isProgrammaticScroll()) {
    if (isNearBottom(32)) {
      userDetachedFromBottom = false;
    }
    if (userDetachedFromBottom || !isNearBottom(96)) {
      cancelBottomScroll();
    }
  }
  emit("scroll");
  if (scrollTop.value <= props.topThreshold) emit("topReach");
}

function handleWheel(event: WheelEvent) {
  if (event.deltaY < -1) {
    userDetachedFromBottom = true;
    cancelBottomScroll();
  }
}

function handleResize() {
  syncViewport();
  if (Date.now() < keepBottomUntil || isNearBottom(64)) scheduleScrollToBottom(2);
  if (activeAnchorTarget) scheduleAnchorAlignment(activeAnchorTarget.token, 4);
}

function isNearBottom(threshold = 200): boolean {
  const el = getScrollerElement();
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

function shouldAutoFollowBottom(threshold = 200): boolean {
  return !userDetachedFromBottom && isNearBottom(threshold);
}

function scrollToBottom(options: BottomScrollOptions = {}) {
  const frames = typeof options === "number" ? options : options.frames ?? 2;
  const keepAliveMs = typeof options === "number" ? 400 : options.keepAliveMs ?? 400;
  userDetachedFromBottom = false;
  keepBottomUntil = Date.now() + keepAliveMs;
  nextTick(() => {
    scheduleScrollToBottom(frames);
  });
}

function setScrollToBottomNow(): boolean {
  const el = getScrollerElement();
  markProgrammaticScroll();
  if (props.virtualized) scrollerRef.value?.scrollToBottom();
  if (el) {
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    syncViewport();
    return true;
  }
  return false;
}

function scheduleScrollToBottom(frames = 1) {
  bottomFrameRemaining = Math.max(bottomFrameRemaining, frames);
  if (bottomFrame != null) return;

  const step = () => {
    const scrolled = setScrollToBottomNow();
    if (scrolled) {
      bottomFrameAttempts = 0;
      bottomFrameRemaining -= 1;
    } else {
      bottomFrameAttempts += 1;
    }
    if (bottomFrameRemaining <= 0) {
      bottomFrame = null;
      bottomFrameRemaining = 0;
      bottomFrameAttempts = 0;
      return;
    }
    if (bottomFrameAttempts > 30) {
      bottomFrame = null;
      bottomFrameRemaining = 0;
      bottomFrameAttempts = 0;
      return;
    }
    bottomFrame = requestAnimationFrame(step);
  };

  bottomFrame = requestAnimationFrame(step);
}

function findTargetElement(messageId: string, anchorId: string): HTMLElement | null {
  const el = getScrollerElement();
  if (!el) return null;

  const anchor = document.getElementById(anchorId);
  if (anchor instanceof HTMLElement && el.contains(anchor)) return anchor;

  const message = document.getElementById(`message-${messageId}`);
  if (message instanceof HTMLElement && el.contains(message)) return message;

  return null;
}

function alignElement(targetEl: HTMLElement, align: AnchorAlign) {
  const el = getScrollerElement();
  if (!el) return;

  const scrollerRect = el.getBoundingClientRect();
  const targetRect = targetEl.getBoundingClientRect();
  const delta = align === "center"
    ? targetRect.top + targetRect.height / 2 - (scrollerRect.top + scrollerRect.height / 2)
    : targetRect.top - scrollerRect.top - 24;

  if (Math.abs(delta) > 1) {
    markProgrammaticScroll();
    el.scrollTop = Math.max(0, el.scrollTop + delta);
  }
  syncViewport();
}

function findRowElement(index: number): HTMLElement | null {
  const el = getScrollerElement();
  return el?.querySelector<HTMLElement>(`.virtual-row[data-virtual-index="${index}"]`) ?? null;
}

function scrollToItem(index: number, options?: ScrollToOptions) {
  markProgrammaticScroll();
  if (props.virtualized) {
    scrollerRef.value?.scrollToItem(index, options);
    syncViewport();
    return;
  }

  const el = getScrollerElement();
  const row = findRowElement(index);
  if (!el || !row) {
    syncViewport();
    return;
  }

  const rowRect = row.getBoundingClientRect();
  const scrollerRect = el.getBoundingClientRect();
  const align = options?.align ?? "start";
  const offset = options?.offset ?? 0;
  const delta = align === "center"
    ? rowRect.top + rowRect.height / 2 - (scrollerRect.top + scrollerRect.height / 2)
    : rowRect.top - scrollerRect.top + offset;

  el.scrollTop = Math.max(0, el.scrollTop + delta);
  syncViewport();
}

function scheduleAnchorAlignment(token: number, frames = 1) {
  if (anchorFrame != null) cancelAnimationFrame(anchorFrame);

  const step = (remaining: number) => {
    const target = activeAnchorTarget;
    if (!target || target.token !== token) {
      anchorFrame = null;
      return;
    }

    const targetEl = findTargetElement(target.messageId, target.anchorId);
    if (targetEl) {
      alignElement(targetEl, target.align);
    } else {
      scrollToItem(target.index, {
        align: target.align,
        offset: target.align === "start" ? -24 : 0,
      });
    }

    if (remaining <= 1) {
      anchorFrame = null;
      activeAnchorTarget = null;
      return;
    }
    anchorFrame = requestAnimationFrame(() => step(remaining - 1));
  };

  anchorFrame = requestAnimationFrame(() => step(frames));
}

function cancelAnchorAlignment() {
  anchorToken += 1;
  activeAnchorTarget = null;
  if (anchorFrame != null) {
    cancelAnimationFrame(anchorFrame);
    anchorFrame = null;
  }
}

function scrollToMessage(messageId: string) {
  const index = props.messages.findIndex(message => String(message.id) === messageId);
  if (index < 0) return;

  cancelAnchorAlignment();
  const token = anchorToken;
  activeAnchorTarget = {
    token,
    index,
    messageId,
    anchorId: `message-${messageId}`,
    align: "center",
  };

  nextTick(() => {
    scrollToItem(index, { align: "center" });
    scheduleAnchorAlignment(token, 8);
  });
}

function scrollToAnchor(messageId: string, anchorId: string) {
  const index = props.messages.findIndex(message => String(message.id) === messageId);
  if (index < 0) return;

  cancelAnchorAlignment();
  const token = anchorToken;
  activeAnchorTarget = {
    token,
    index,
    messageId,
    anchorId,
    align: "start",
  };

  nextTick(() => {
    scrollToItem(index, { align: "start", offset: -24 });
    scheduleAnchorAlignment(token, 10);
  });
}

function captureScrollPosition() {
  const el = getScrollerElement();
  if (!el) return null;
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
  };
}

function restoreScrollPosition(snapshot: { scrollTop: number; scrollHeight: number } | null) {
  if (!snapshot) return;
  nextTick(() => {
    const el = getScrollerElement();
    if (!el) return;
    const nextScrollTop = Math.max(0, el.scrollHeight - snapshot.scrollHeight + snapshot.scrollTop);
    markProgrammaticScroll();
    if (props.virtualized) scrollerRef.value?.scrollToPosition(nextScrollTop);
    el.scrollTop = nextScrollTop;
    syncViewport();
  });
}

function captureViewportPosition(): ViewportScrollSnapshot | null {
  const el = getScrollerElement();
  if (!el) return null;
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    wasNearBottom: isNearBottom(64),
  };
}

function restoreViewportPosition(snapshot: ViewportScrollSnapshot | null, frames = 4) {
  if (!snapshot) return;
  cancelBottomScroll();
  userDetachedFromBottom = !snapshot.wasNearBottom;
  if (viewportRestoreFrame != null) cancelAnimationFrame(viewportRestoreFrame);

  nextTick(() => {
    let remaining = frames;
    const step = () => {
      const el = getScrollerElement();
      if (!el) {
        viewportRestoreFrame = null;
        return;
      }
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const nextScrollTop = Math.min(maxScrollTop, Math.max(0, snapshot.scrollTop));
      markProgrammaticScroll();
      if (props.virtualized) scrollerRef.value?.scrollToPosition(nextScrollTop);
      el.scrollTop = nextScrollTop;
      syncViewport();

      remaining -= 1;
      if (remaining <= 0) {
        viewportRestoreFrame = null;
        return;
      }
      viewportRestoreFrame = requestAnimationFrame(step);
    };
    viewportRestoreFrame = requestAnimationFrame(step);
  });
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  nextTick(() => {
    syncViewport();
    const el = getScrollerElement();
    if (el && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(el);
    }
  });
});

onBeforeUnmount(() => {
  cancelBottomScroll();
  if (anchorFrame != null) cancelAnimationFrame(anchorFrame);
  if (viewportRestoreFrame != null) cancelAnimationFrame(viewportRestoreFrame);
  resizeObserver?.disconnect();
});

watch(messageKeys, () => {
  cancelAnchorAlignment();
  nextTick(syncViewport);
});

defineExpose({
  isNearBottom,
  shouldAutoFollowBottom,
  scrollToBottom,
  scrollToMessage,
  scrollToAnchor,
  captureScrollPosition,
  restoreScrollPosition,
  captureViewportPosition,
  restoreViewportPosition,
});
</script>

<template>
  <div
    ref="hostRef"
    class="virtual-message-list-host"
    :style="{ '--virtual-row-gap': `${rowGap}px`, '--virtual-list-padding': padding }"
  >
    <DynamicScroller
      v-if="virtualized"
      ref="scrollerRef"
      class="virtual-message-list"
      :items="messages"
      key-field="id"
      :min-item-size="estimatedItemHeight"
      :buffer="bufferPx"
      :flow-mode="true"
      :prerender="overscan"
      @scroll.passive="handleScroll"
      @wheel.passive="handleWheel"
      @resize="handleResize"
      @visible="syncViewport"
    >
      <template #before>
        <slot v-if="messages.length > 0" name="before" />
      </template>
      <template #default="{ item, index, active }">
        <DynamicScrollerItem
          :item="item"
          :index="index"
          :active="active"
          class="virtual-row"
          :data-virtual-index="index"
        >
          <slot v-if="active" name="item" :message="item" />
        </DynamicScrollerItem>
      </template>
      <template #after>
        <slot v-if="messages.length > 0" name="after" />
      </template>
    </DynamicScroller>
    <div
      v-else
      class="virtual-message-list"
      @scroll.passive="handleScroll"
      @wheel.passive="handleWheel"
    >
      <slot v-if="messages.length > 0" name="before" />
      <div
        v-for="(item, index) in messages"
        :key="messageKey(item)"
        class="virtual-row"
        :data-virtual-index="index"
      >
        <slot name="item" :message="item" />
      </div>
      <slot v-if="messages.length > 0" name="after" />
    </div>
    <div v-if="messages.length === 0 && $slots.empty" class="virtual-message-list-empty">
      <slot name="empty" />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.virtual-message-list-host {
  flex: 1;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
  display: flex;
  position: relative;
  animation: message-list-fade-in 1.5s ease both;
}

.virtual-message-list {
  flex: 1;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  padding: var(--virtual-list-padding);
  box-sizing: border-box;
  background-color: $bg-card;

  .dark & {
    background-color: #333333;
  }
}

.virtual-row {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  padding-bottom: var(--virtual-row-gap);
}

.virtual-message-list-empty {
  position: absolute;
  inset: var(--virtual-list-padding);
  display: grid;
  place-items: center;
  min-width: 0;
  min-height: 0;
  pointer-events: auto;
}

.virtual-message-list-empty :deep(.empty-state) {
  width: 100%;
  height: 100%;
  min-height: 0;
}

@keyframes message-list-fade-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

</style>
