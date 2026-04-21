import { request } from '../client';
export async function checkHealth() {
    return request('/health');
}
export async function triggerUpdate() {
    return request('/api/hermes/update', { method: 'POST' });
}
export async function fetchConfigModels() {
    return request('/api/hermes/config/models');
}
export async function fetchAvailableModels() {
    return request('/api/hermes/available-models');
}
export async function updateDefaultModel(data) {
    await request('/api/hermes/config/model', {
        method: 'PUT',
        body: JSON.stringify(data),
    });
}
export async function addCustomProvider(data) {
    await request('/api/hermes/config/providers', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}
export async function removeCustomProvider(name) {
    await request(`/api/hermes/config/providers/${encodeURIComponent(name)}`, {
        method: 'DELETE',
    });
}
export async function updateProvider(poolKey, data) {
    await request(`/api/hermes/config/providers/${encodeURIComponent(poolKey)}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    });
}
