import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as jobsApi from '@/api/hermes/jobs'
import type { Job, ProfileJobsResult, CreateJobRequest, UpdateJobRequest } from '@/api/hermes/jobs'

function matchId(job: Job, id: string): boolean {
  return job.job_id === id || job.id === id
}

export const useJobsStore = defineStore('jobs', () => {
  const jobs = ref<Job[]>([])
  const profileJobs = ref<ProfileJobsResult[]>([])
  const activeProfile = ref('')
  const loading = ref(false)
  // null = show all profiles (when sidebar profile is "default")
  // string = show only that profile
  const selectedProfile = ref<string | null>(null)

  const totalJobsCount = computed(() =>
    profileJobs.value.reduce((sum, p) => sum + p.jobs.length, 0)
  )

  // When selectedProfile is null → show all; otherwise filter
  const filteredProfileJobs = computed(() => {
    if (!selectedProfile.value) return profileJobs.value
    return profileJobs.value.filter(p => p.profile === selectedProfile.value)
  })

  const profileNames = computed(() =>
    profileJobs.value.map(p => p.profile)
  )

  // Find a job across all profiles by id
  function findJobById(jobId: string): { job: Job; profile: string } | null {
    for (const p of profileJobs.value) {
      const job = p.jobs.find(j => matchId(j, jobId))
      if (job) return { job, profile: p.profile }
    }
    return null
  }

  async function fetchJobs() {
    loading.value = true
    try {
      const allProfiles = await jobsApi.listAllProfileJobs()
      profileJobs.value = allProfiles.profiles
      activeProfile.value = allProfiles.activeProfile

      // Also keep legacy jobs ref in sync with active profile
      const activeGroup = allProfiles.profiles.find(p => p.profile === allProfiles.activeProfile)
      jobs.value = activeGroup?.jobs || []
    } catch {
      // Fallback to single-profile fetch
      try {
        jobs.value = await jobsApi.listJobs()
      } catch (err) {
        console.error('Failed to fetch jobs:', err)
      }
    } finally {
      loading.value = false
    }
  }

  function _updateProfileJobs(profileName: string, updated: ProfileJobsResult) {
    const idx = profileJobs.value.findIndex(p => p.profile === profileName)
    if (idx !== -1) profileJobs.value[idx] = updated
  }

  async function createJob(data: CreateJobRequest): Promise<Job> {
    const job = await jobsApi.createJob(data)
    jobs.value.unshift(job)
    return job
  }

  async function createProfileJob(profile: string, data: CreateJobRequest) {
    const res = await jobsApi.createProfileJob(profile, data)
    if (res.profile) _updateProfileJobs(profile, res.profile)
    return res
  }

  async function updateJob(jobId: string, data: UpdateJobRequest): Promise<Job> {
    const job = await jobsApi.updateJob(jobId, data)
    const idx = jobs.value.findIndex(j => matchId(j, jobId))
    if (idx !== -1) jobs.value[idx] = job
    return job
  }

  async function deleteJob(jobId: string) {
    await jobsApi.deleteJob(jobId)
    jobs.value = jobs.value.filter(j => !matchId(j, jobId))
  }

  async function pauseJob(jobId: string) {
    const job = await jobsApi.pauseJob(jobId)
    const idx = jobs.value.findIndex(j => matchId(j, jobId))
    if (idx !== -1) jobs.value[idx] = job
  }

  async function resumeJob(jobId: string) {
    const job = await jobsApi.resumeJob(jobId)
    const idx = jobs.value.findIndex(j => matchId(j, jobId))
    if (idx !== -1) jobs.value[idx] = job
  }

  async function runJob(jobId: string) {
    const job = await jobsApi.runJob(jobId)
    const idx = jobs.value.findIndex(j => matchId(j, jobId))
    if (idx !== -1) jobs.value[idx] = job
  }

  // Profile-scoped operations
  async function pauseProfileJob(profile: string, jobId: string) {
    const res = await jobsApi.pauseProfileJob(profile, jobId)
    if (res.profile) _updateProfileJobs(profile, res.profile)
  }

  async function resumeProfileJob(profile: string, jobId: string) {
    const res = await jobsApi.resumeProfileJob(profile, jobId)
    if (res.profile) _updateProfileJobs(profile, res.profile)
  }

  async function runProfileJob(profile: string, jobId: string) {
    const res = await jobsApi.runProfileJob(profile, jobId)
    if (res.profile) _updateProfileJobs(profile, res.profile)
  }

  async function deleteProfileJob(profile: string, jobId: string) {
    const res = await jobsApi.deleteProfileJob(profile, jobId)
    if (res.profile) _updateProfileJobs(profile, res.profile)
  }

  return {
    jobs,
    profileJobs,
    activeProfile,
    loading,
    selectedProfile,
    totalJobsCount,
    filteredProfileJobs,
    profileNames,
    findJobById,
    fetchJobs,
    createJob,
    createProfileJob,
    updateJob,
    deleteJob,
    pauseJob,
    resumeJob,
    runJob,
    pauseProfileJob,
    resumeProfileJob,
    runProfileJob,
    deleteProfileJob,
  }
})
