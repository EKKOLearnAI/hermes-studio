import { request } from '../client';
export async function fetchLogFiles() {
    const res = await request('/api/hermes/logs');
    return res.files;
}
export async function fetchLogs(name, params) {
    const query = new URLSearchParams();
    if (params?.lines)
        query.set('lines', String(params.lines));
    if (params?.level)
        query.set('level', params.level);
    if (params?.session)
        query.set('session', params.session);
    if (params?.since)
        query.set('since', params.since);
    const qs = query.toString();
    const res = await request(`/api/hermes/logs/${name}${qs ? `?${qs}` : ''}`);
    return res.entries.filter((e) => e !== null);
}
