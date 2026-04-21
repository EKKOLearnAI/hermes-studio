import { request } from '../client';
export async function fetchSessions(source, limit) {
    const params = new URLSearchParams();
    if (source)
        params.set('source', source);
    if (limit)
        params.set('limit', String(limit));
    const query = params.toString();
    const res = await request(`/api/hermes/sessions${query ? `?${query}` : ''}`);
    return res.sessions;
}
export async function fetchSession(id) {
    try {
        const res = await request(`/api/hermes/sessions/${id}`);
        return res.session;
    }
    catch {
        return null;
    }
}
export async function deleteSession(id) {
    try {
        await request(`/api/hermes/sessions/${id}`, { method: 'DELETE' });
        return true;
    }
    catch {
        return false;
    }
}
export async function renameSession(id, title) {
    try {
        await request(`/api/hermes/sessions/${id}/rename`, {
            method: 'POST',
            body: JSON.stringify({ title }),
        });
        return true;
    }
    catch {
        return false;
    }
}
