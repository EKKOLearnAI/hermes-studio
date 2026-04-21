import { request, getBaseUrlValue, getApiKey } from '../client';
export async function startRun(body) {
    return request('/api/hermes/v1/runs', {
        method: 'POST',
        body: JSON.stringify(body),
    });
}
export function streamRunEvents(runId, onEvent, onDone, onError) {
    const baseUrl = getBaseUrlValue();
    const token = getApiKey();
    const profile = localStorage.getItem('hermes_active_profile_name');
    const params = new URLSearchParams();
    if (token)
        params.set('token', token);
    if (profile && profile !== 'default')
        params.set('profile', profile);
    const qs = params.toString();
    const url = `${baseUrl}/api/hermes/v1/runs/${runId}/events${qs ? `?${qs}` : ''}`;
    let closed = false;
    const source = new EventSource(url);
    source.onmessage = (e) => {
        if (closed)
            return;
        try {
            const parsed = JSON.parse(e.data);
            onEvent(parsed);
            if (parsed.event === 'run.completed' || parsed.event === 'run.failed') {
                closed = true;
                source.close();
                onDone();
            }
        }
        catch {
            onEvent({ event: 'message', delta: e.data });
        }
    };
    source.onerror = () => {
        if (closed)
            return;
        closed = true;
        source.close();
        onError(new Error('SSE connection error'));
    };
    // Return AbortController-compatible object
    return {
        abort: () => {
            if (!closed) {
                closed = true;
                source.close();
            }
        },
    };
}
export async function fetchModels() {
    return request('/api/hermes/v1/models');
}
