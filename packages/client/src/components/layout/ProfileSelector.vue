<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { NSelect, useMessage } from 'naive-ui'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()

const options = computed(() =>
  profilesStore.profiles.map(p => ({
    label: p.backend_url ? `${p.name} → ${p.backend_url}` : p.name,
    value: p.name,
  })),
)

const activeName = computed(() => profilesStore.activeProfile?.name ?? '')

async function handleChange(value: string | number | Array<string | number>) {
  if (typeof value === 'string' && value !== activeName.value) {
    const ok = await profilesStore.switchProfileSmooth(value)
    if (ok) {
      message.success(t('profiles.switchSuccess', { name: value }))
    }
  }
}

onMounted(() => {
  if (profilesStore.profiles.length === 0) {
    profilesStore.fetchProfiles()
  }
})
</script>

<template>
  <div class="profile-selector">
    <div class="selector-label">{{ t('sidebar.profiles') }}</div>
    <NSelect
      :value="activeName"
      :options="options"
      :loading="profilesStore.switching"
      size="small"
      @update:value="handleChange"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.profile-selector {
  padding: 0 12px;
  margin-bottom: 8px;
}

.selector-label {
  font-size: 11px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}
</style>
