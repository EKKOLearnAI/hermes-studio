<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useScrollReveal } from '@/composables/useScrollReveal'

interface ScreenshotItem {
  src: string
  alt: string
  title: string
  desc: string
}

const { tm } = useI18n()
useScrollReveal()

const images = computed(() => tm('screenshots.items') as ScreenshotItem[])
const screenshot = computed(() => images.value[0] as ScreenshotItem)
</script>

<template>
  <section class="screenshots-section">
    <div class="screenshots-inner reveal">
      <div class="showcase-shell">
        <div class="showcase-copy">
          <h2>{{ screenshot.title }}</h2>
          <p>{{ screenshot.desc }}</p>
        </div>

        <div class="showcase-stage">
          <div class="screenshot-frame">
            <img
              :src="screenshot.src"
              :alt="screenshot.alt"
              class="screenshot-img"
            />
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
  display: flex;
  justify-content: center;
}

.screenshot-frame {
  position: relative;
  z-index: 1;
  align-self: start;
  width: 100%;
  max-width: 860px;
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

</style>
