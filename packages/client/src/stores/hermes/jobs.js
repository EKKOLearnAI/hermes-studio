import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as jobsApi from '@/api/hermes/jobs';
function matchId(job, id) {
    return job.job_id === id || job.id === id;
}
export const useJobsStore = defineStore('jobs', () => {
    const jobs = ref([]);
    const loading = ref(false);
    async function fetchJobs() {
        loading.value = true;
        try {
            jobs.value = await jobsApi.listJobs();
        }
        catch (err) {
            console.error('Failed to fetch jobs:', err);
        }
        finally {
            loading.value = false;
        }
    }
    async function createJob(data) {
        const job = await jobsApi.createJob(data);
        jobs.value.unshift(job);
        return job;
    }
    async function updateJob(jobId, data) {
        const job = await jobsApi.updateJob(jobId, data);
        const idx = jobs.value.findIndex(j => matchId(j, jobId));
        if (idx !== -1)
            jobs.value[idx] = job;
        return job;
    }
    async function deleteJob(jobId) {
        await jobsApi.deleteJob(jobId);
        jobs.value = jobs.value.filter(j => !matchId(j, jobId));
    }
    async function pauseJob(jobId) {
        const job = await jobsApi.pauseJob(jobId);
        const idx = jobs.value.findIndex(j => matchId(j, jobId));
        if (idx !== -1)
            jobs.value[idx] = job;
    }
    async function resumeJob(jobId) {
        const job = await jobsApi.resumeJob(jobId);
        const idx = jobs.value.findIndex(j => matchId(j, jobId));
        if (idx !== -1)
            jobs.value[idx] = job;
    }
    async function runJob(jobId) {
        const job = await jobsApi.runJob(jobId);
        const idx = jobs.value.findIndex(j => matchId(j, jobId));
        if (idx !== -1)
            jobs.value[idx] = job;
    }
    return {
        jobs,
        loading,
        fetchJobs,
        createJob,
        updateJob,
        deleteJob,
        pauseJob,
        resumeJob,
        runJob,
    };
});
