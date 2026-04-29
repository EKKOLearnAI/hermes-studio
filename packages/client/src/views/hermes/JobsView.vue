<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { NButton, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import JobsPanel from '@/components/hermes/jobs/JobsPanel.vue'
import JobRunHistory from '@/components/hermes/jobs/JobRunHistory.vue'
import JobFormModal from '@/components/hermes/jobs/JobFormModal.vue'
import { useJobsStore } from '@/stores/hermes/jobs'

const { t } = useI18n()
const jobsStore = useJobsStore()
const showModal = ref(false)
const editingJob = ref<string | null>(null)
const selectedJobId = ref<string | null>(null)

const jobNameMap = computed(() => {
  const map: Record<string, string> = {}
  for (const job of jobsStore.jobs) {
    const id = job.job_id || job.id
    map[id] = job.name
  }
  return map
})

onMounted(() => {
  jobsStore.fetchJobs()
})

function openCreateModal() {
  editingJob.value = null
  showModal.value = true
}

function openEditModal(jobId: string) {
  editingJob.value = jobId
  showModal.value = true
}

function handleModalClose() {
  showModal.value = false
  editingJob.value = null
}

async function handleSave() {
  await jobsStore.fetchJobs()
  handleModalClose()
}

function handleSelectJob(jobId: string | null) {
  selectedJobId.value = selectedJobId.value === jobId ? null : jobId
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

    <div class="jobs-split">
      <div class="jobs-top">
        <NSpin :show="jobsStore.loading && jobsStore.jobs.length === 0">
          <JobsPanel
            :selected-job-id="selectedJobId"
            @edit="openEditModal"
            @select="handleSelectJob"
          />
        </NSpin>
      </div>

      <div class="splitter" />

      <div class="jobs-bottom">
        <JobRunHistory
          :selected-job-id="selectedJobId"
          :job-name-map="jobNameMap"
        />
      </div>
    </div>

    <JobFormModal
      v-if="showModal"
      :job-id="editingJob"
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

.jobs-split {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.jobs-top {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  min-height: 120px;
}

.splitter {
  height: 1px;
  background: $border-light;
  flex-shrink: 0;
}

.jobs-bottom {
  flex: 1;
  min-height: 120px;
  overflow: hidden;
}
</style>
