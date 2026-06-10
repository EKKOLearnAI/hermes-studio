<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useScrollReveal } from '@/composables/useScrollReveal'

interface ScreenshotItem {
  src: string
  alt: string
  title: string
  desc: string
}

const { t, tm } = useI18n()
useScrollReveal()

const images = computed(() => tm('screenshots.items') as ScreenshotItem[])
const activeIndex = ref(0)
const screenshotFrame = ref<HTMLElement | null>(null)
const tourRail = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setInterval>

function next() {
  activeIndex.value = (activeIndex.value + 1) % images.value.length
}

function setActive(i: number) {
  activeIndex.value = i
  resetTimer()
}

function resetTimer() {
  clearInterval(timer)
  timer = setInterval(next, 5000)
}

function syncTourHeight() {
  if (!screenshotFrame.value || !tourRail.value) return

  if (window.innerWidth <= 980) {
    tourRail.value.style.height = ''
    return
  }

  tourRail.value.style.height = `${screenshotFrame.value.offsetHeight}px`
}

onMounted(() => {
  timer = setInterval(next, 5000)
  nextTick(syncTourHeight)
  window.addEventListener('resize', syncTourHeight)
})

onUnmounted(() => {
  clearInterval(timer)
  window.removeEventListener('resize', syncTourHeight)
})

watch(activeIndex, () => {
  nextTick(syncTourHeight)
})
</script>

<template>
  <section class="screenshots-section">
    <div class="screenshots-inner reveal">
      <div class="showcase-shell">
        <div class="showcase-copy">
          <h2>{{ images[activeIndex].title }}</h2>
          <p>{{ images[activeIndex].desc }}</p>
        </div>

        <div class="showcase-stage">
          <div ref="screenshotFrame" class="screenshot-frame">
            <transition name="slide" mode="out-in">
              <img
                :key="activeIndex"
                :src="images[activeIndex].src"
                :alt="images[activeIndex].alt"
                class="screenshot-img"
                @load="syncTourHeight"
              />
            </transition>
          </div>

          <div ref="tourRail" class="tour-rail" :aria-label="t('screenshots.tourLabel')">
            <button
              v-for="(img, i) in images"
              :key="img.src"
              class="tour-card"
              :class="{ active: activeIndex === i }"
              type="button"
              :aria-label="t('screenshots.goTo', { number: i + 1 })"
              @click="setActive(i)"
            >
              <span class="tour-index">{{ String(i + 1).padStart(2, '0') }}</span>
              <span class="tour-text">
                <strong>{{ img.title }}</strong>
                <small>{{ img.desc }}</small>
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.screenshots-section {
  padding: 66px 18px 28px;
  background: transparent;

  @media (max-width: $breakpoint-mobile) {
    padding: 44px 10px 18px;
  }
}

.screenshots-inner {
  max-width: 1120px;
  margin: 0 auto;
}

.showcase-shell {
  position: relative;
  overflow: hidden;
  border-radius: 34px;
  border: 1px solid rgba(30, 50, 90, 0.08);
  background:
    radial-gradient(circle at 14% 16%, rgba(229, 185, 77, 0.12), rgba(229, 185, 77, 0) 28%),
    radial-gradient(circle at 88% 0%, rgba(68, 111, 174, 0.11), rgba(68, 111, 174, 0) 30%),
    rgba(255, 255, 255, 0.62);
  box-shadow:
    0 24px 80px rgba(30, 50, 90, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.84);
  padding: clamp(20px, 3vw, 34px);

  @media (max-width: $breakpoint-mobile) {
    border-radius: 24px;
    padding: 16px;
  }
}

.showcase-copy {
  max-width: 660px;
  min-height: 128px;
  margin-bottom: 22px;

  h2 {
    margin: 0;
    color: rgba(30, 38, 52, 0.92);
    font-size: clamp(30px, 4vw, 52px);
    font-weight: 650;
    line-height: 1.05;
  }

  p {
    margin: 12px 0 0;
    color: rgba(42, 50, 64, 0.66);
    font-size: 16px;
    line-height: 1.65;
  }
}

.showcase-stage {
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-columns: minmax(0, 670px) 320px;
  gap: 32px;
  align-items: start;
  justify-content: center;

  @media (max-width: 980px) {
    display: flex;
    flex-direction: column;
    gap: 30px;
  }
}

.screenshot-frame {
  position: relative;
  z-index: 1;
  align-self: start;
  width: 100%;
  min-width: 0;
  border-radius: 12px;
  border: 1px solid rgba(30, 50, 90, 0.08);
  overflow: hidden;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.86), rgba(242, 245, 249, 0.82));
  box-shadow:
    0 14px 34px rgba(30, 50, 90, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.88);
  transition: transform 0.4s ease, box-shadow 0.4s ease;

  &:hover {
    box-shadow:
      0 16px 40px rgba(30, 50, 90, 0.1),
      inset 0 1px 0 rgba(255, 255, 255, 0.9);
  }

  @media (max-width: $breakpoint-mobile) {
    width: 92%;
    margin: 0 auto;
    border-radius: 10px;
  }
}

.screenshot-img {
  width: 100%;
  display: block;
  height: auto;
}

.tour-rail {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-rows: repeat(4, 1fr);
  gap: 10px;
  align-self: stretch;
  padding: 12px;
  border: 1px solid rgba(30, 50, 90, 0.08);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.46);

  @media (max-width: 980px) {
    grid-template-rows: none;
    grid-template-columns: repeat(4, minmax(240px, 1fr));
    overflow-x: auto;
  }
}

.tour-card {
  display: flex;
  gap: 12px;
  min-height: 0;
  height: 100%;
  text-align: left;
  border: 1px solid rgba(30, 50, 90, 0.08);
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.5);
  color: rgba(30, 38, 52, 0.74);
  padding: 16px;
  cursor: pointer;
  transition: transform $transition-fast, border-color $transition-fast, background $transition-fast, box-shadow $transition-fast;

  &.active {
    border-color: rgba(30, 50, 90, 0.16);
    background: rgba(255, 255, 255, 0.9);
    box-shadow: 0 16px 34px rgba(30, 50, 90, 0.1);
  }

  &:hover {
    transform: translateY(-1px);
    border-color: rgba(30, 50, 90, 0.16);
    background: rgba(255, 255, 255, 0.82);
  }
}

.tour-index {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: rgba(30, 50, 90, 0.08);
  color: rgba(30, 50, 90, 0.7);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;

  .tour-card.active & {
    background: rgba(30, 50, 90, 0.9);
    color: #fff;
  }
}

.tour-text {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;

  strong {
    color: rgba(30, 38, 52, 0.9);
    font-size: 14px;
    font-weight: 700;
  }

  small {
    color: rgba(42, 50, 64, 0.58);
    font-size: 12px;
    line-height: 1.45;
  }
}

// ─── Slide Transition ───────────────────────

.slide-enter-active,
.slide-leave-active {
  transition: opacity 0.32s ease, transform 0.32s ease;
}

.slide-enter-from {
  opacity: 0;
  transform: translateX(14px);
}

.slide-leave-to {
  opacity: 0;
  transform: translateX(-14px);
}

</style>
