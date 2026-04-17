<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { NButton, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import JobCard from '@/components/hermes/jobs/JobCard.vue'
import JobFormModal from '@/components/hermes/jobs/JobFormModal.vue'
import { useJobsStore } from '@/stores/hermes/jobs'
import { useProfilesStore } from '@/stores/hermes/profiles'

const { t } = useI18n()
const jobsStore = useJobsStore()
const profilesStore = useProfilesStore()
const showModal = ref(false)
const editingJob = ref<string | null>(null)
const editingJobProfile = ref<string | null>(null)

// Sync selectedProfile with sidebar profile selector
// "default" = show all bots; specific name = filter to that bot
const sidebarProfile = computed(() => profilesStore.activeProfile?.name ?? 'default')

watch(sidebarProfile, (name) => {
  jobsStore.selectedProfile = name === 'default' ? null : name
}, { immediate: true })

// Display: all profiles or single profile based on sidebar
const displayGroups = computed(() => jobsStore.filteredProfileJobs)

onMounted(() => {
  jobsStore.fetchJobs()
  if (profilesStore.profiles.length === 0) {
    profilesStore.fetchProfiles()
  }
})

function openCreateModal() {
  editingJob.value = null
  editingJobProfile.value = null
  showModal.value = true
}

function openEditModal(jobId: string) {
  editingJob.value = jobId
  // Find the profile for this job from in-memory data
  const found = jobsStore.findJobById(jobId)
  editingJobProfile.value = found?.profile || null
  showModal.value = true
}

function handleModalClose() {
  showModal.value = false
  editingJob.value = null
  editingJobProfile.value = null
}

async function handleSave() {
  await jobsStore.fetchJobs()
  handleModalClose()
}
</script>

<template>
  <div class="jobs-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('jobs.title') }}</h2>
      <NButton type="primary" size="small" @click="openCreateModal">
        <template #icon>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </template>
        {{ t('jobs.createJob') }}
      </NButton>
    </header>

    <div class="jobs-content">
      <NSpin :show="jobsStore.loading && jobsStore.totalJobsCount === 0">
        <template v-if="displayGroups.length === 0 || jobsStore.totalJobsCount === 0">
          <div class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" class="empty-icon">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
              <line x1="16" y1="2" x2="16" y2="6"/>
              <line x1="8" y1="2" x2="8" y2="6"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            <p>{{ t('jobs.noJobs') }}</p>
          </div>
        </template>
        <template v-else>
          <div v-for="profileGroup in displayGroups" :key="profileGroup.profile" class="profile-section">
            <!-- Show profile header only when viewing all bots (selectedProfile is null) -->
            <div v-if="!jobsStore.selectedProfile" class="profile-header">
              <h3 class="profile-name">
                {{ profileGroup.profile }}
                <span v-if="profileGroup.profile === jobsStore.activeProfile" class="active-badge">{{ t('jobs.activeBot') }}</span>
              </h3>
              <span class="profile-count">{{ profileGroup.jobs.length }} {{ t('jobs.jobCount') }}</span>
            </div>
            <div v-if="profileGroup.jobs.length > 0" class="jobs-grid">
              <JobCard
                v-for="job in profileGroup.jobs"
                :key="job.id"
                :job="job"
                :profile="profileGroup.profile"
                :is-active-profile="profileGroup.profile === jobsStore.activeProfile"
                @edit="openEditModal"
              />
            </div>
            <div v-else class="empty-state small">
              <p>{{ t('jobs.noJobs') }}</p>
            </div>
          </div>
        </template>
      </NSpin>
    </div>

    <JobFormModal
      v-if="showModal"
      :job-id="editingJob"
      :job-profile="editingJobProfile"
      @close="handleModalClose"
      @saved="handleSave"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.jobs-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.jobs-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.profile-section {
  margin-bottom: 24px;
}

.profile-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid $border-light;
}

.profile-name {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
  display: flex;
  align-items: center;
  gap: 8px;
}

.active-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(var(--success-rgb), 0.12);
  color: $success;
  font-weight: 500;
}

.profile-count {
  font-size: 12px;
  color: $text-muted;
}

.jobs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr));
  gap: 14px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: $text-muted;
  gap: 12px;

  .empty-icon {
    opacity: 0.3;
  }

  p {
    font-size: 14px;
  }

  &.small {
    height: auto;
    padding: 24px 0;
  }
}
</style>
