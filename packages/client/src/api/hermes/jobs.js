import { request } from '../client';
function unwrap(res) {
    return res.job;
}
export async function listJobs() {
    const res = await request('/api/hermes/jobs?include_disabled=true');
    return res.jobs;
}
export async function getJob(jobId) {
    return unwrap(await request(`/api/hermes/jobs/${jobId}`));
}
export async function createJob(data) {
    return unwrap(await request('/api/hermes/jobs', {
        method: 'POST',
        body: JSON.stringify(data),
    }));
}
export async function updateJob(jobId, data) {
    return unwrap(await request(`/api/hermes/jobs/${jobId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
    }));
}
export async function deleteJob(jobId) {
    return request(`/api/hermes/jobs/${jobId}`, {
        method: 'DELETE',
    });
}
export async function pauseJob(jobId) {
    return unwrap(await request(`/api/hermes/jobs/${jobId}/pause`, { method: 'POST' }));
}
export async function resumeJob(jobId) {
    return unwrap(await request(`/api/hermes/jobs/${jobId}/resume`, { method: 'POST' }));
}
export async function runJob(jobId) {
    return unwrap(await request(`/api/hermes/jobs/${jobId}/run`, { method: 'POST' }));
}
