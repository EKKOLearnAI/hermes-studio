import { request } from '../client';
export async function startCodexLogin() {
    return request('/api/hermes/auth/codex/start', { method: 'POST' });
}
export async function pollCodexLogin(sessionId) {
    return request(`/api/hermes/auth/codex/poll/${sessionId}`);
}
export async function getCodexAuthStatus() {
    return request('/api/hermes/auth/codex/status');
}
