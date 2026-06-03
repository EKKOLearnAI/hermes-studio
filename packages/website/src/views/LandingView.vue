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
    <section class="download-section">
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
.download-section {
  max-width: 1120px;
  margin: 0 auto;
  padding: 56px 24px 16px;

  @media (max-width: $breakpoint-mobile) {
    padding: 32px 16px 8px;
  }
}

.cta-row {
  max-width: 1120px;
  margin: 0 auto;
  padding: 80px 24px;
  display: flex;
  gap: 40px;

  @media (max-width: $breakpoint-mobile) {
    flex-direction: column;
    padding: 48px 16px;
    gap: 0;
  }
}

.cta-col {
  flex: 1;
  min-width: 0;
}
</style>
