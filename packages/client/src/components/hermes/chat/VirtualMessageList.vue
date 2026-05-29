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

const hostRef = ref<HTMLElement | null>(null);
const scrollerRef = ref<DynamicScrollerExposed<VirtualItem> | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
let keepBottomUntil = 0;
let bottomFrame: number | null = null;
let anchorFrame: number | null = null;
let anchorToken = 0;
let activeAnchorTarget: AnchorTarget | null = null;

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

function handleScroll() {
  syncViewport();
  emit("scroll");
  if (scrollTop.value <= props.topThreshold) emit("topReach");
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

function scrollToBottom() {
  keepBottomUntil = Date.now() + 700;
  nextTick(() => {
    scheduleScrollToBottom(3);
  });
}

function setScrollToBottomNow() {
  const el = getScrollerElement();
  scrollerRef.value?.scrollToBottom();
  if (el) {
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  }
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
    el.scrollTop = Math.max(0, el.scrollTop + delta);
  }
  syncViewport();
}

function scrollToItem(index: number, options?: ScrollToOptions) {
  scrollerRef.value?.scrollToItem(index, options);
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
    scrollerRef.value?.scrollToPosition(nextScrollTop);
    el.scrollTop = nextScrollTop;
    syncViewport();
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
  if (bottomFrame != null) cancelAnimationFrame(bottomFrame);
  if (anchorFrame != null) cancelAnimationFrame(anchorFrame);
  resizeObserver?.disconnect();
});

watch(messageKeys, () => {
  cancelAnchorAlignment();
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
    ref="hostRef"
    class="virtual-message-list-host"
    :style="{ '--virtual-row-gap': `${rowGap}px`, '--virtual-list-padding': padding }"
  >
    <DynamicScroller
      ref="scrollerRef"
      class="virtual-message-list"
      :items="messages"
      key-field="id"
      :min-item-size="estimatedItemHeight"
      :buffer="bufferPx"
      :flow-mode="true"
      :prerender="overscan"
      @scroll.passive="handleScroll"
      @resize="handleResize"
      @visible="syncViewport"
    >
      <template #empty>
        <slot name="empty" />
      </template>
      <template #before>
        <slot v-if="messages.length > 0" name="before" />
      </template>
      <template #default="{ item, index, active }">
        <DynamicScrollerItem
          :item="item"
          :index="index"
          :active="active"
          class="virtual-row"
        >
          <slot v-if="active" name="item" :message="item" />
        </DynamicScrollerItem>
      </template>
      <template #after>
        <slot v-if="messages.length > 0" name="after" />
      </template>
    </DynamicScroller>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.virtual-message-list-host {
  flex: 1;
  min-height: 0;
  display: flex;
}

.virtual-message-list {
  flex: 1;
  min-height: 0;
  padding: var(--virtual-list-padding);
  box-sizing: border-box;
  background-color: $bg-card;

  .dark & {
    background-color: #333333;
  }
}

.virtual-row {
  box-sizing: border-box;
  padding-bottom: var(--virtual-row-gap);
}
</style>
