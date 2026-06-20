<script setup lang="ts">
import HeroSection from '@/components/landing/HeroSection.vue'
import ScreenshotsSection from '@/components/landing/ScreenshotsSection.vue'
import FeaturesGrid from '@/components/landing/FeaturesGrid.vue'
import InstallSection from '@/components/landing/InstallSection.vue'
import StarHistorySection from '@/components/landing/StarHistorySection.vue'
</script>

<template>
  <div class="landing">
    <HeroSection />
    <section id="download" class="download-section">
      <InstallSection />
    </section>
    <ScreenshotsSection />
    <FeaturesGrid />
    <div class="cta-row">
      <StarHistorySection class="cta-col" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.landing {
  background: #f7f8fa;
}

.download-section {
  width: 100%;
  padding: 76px 18px 20px;
  background: transparent;

  @media (max-width: $breakpoint-mobile) {
    padding: 42px 10px 8px;
  }
}

.cta-row {
  width: 100%;
  margin: 0;
  padding: 26px 18px 72px;
  display: flex;
  gap: 40px;
  background: transparent;

  @media (max-width: $breakpoint-mobile) {
    flex-direction: column;
    padding: 18px 10px 44px;
    gap: 0;
  }
}

.cta-col {
  flex: 1;
  min-width: 0;
  max-width: 1120px;
  margin: 0 auto;
}
</style>
