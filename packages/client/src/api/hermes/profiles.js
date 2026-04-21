import { request, getBaseUrlValue, getApiKey } from '../client';
export async function fetchProfiles() {
    const res = await request('/api/hermes/profiles');
    return res.profiles;
}
export async function fetchProfileDetail(name) {
    const res = await request(`/api/hermes/profiles/${encodeURIComponent(name)}`);
    return res.profile;
}
export async function createProfile(name, clone) {
    try {
        await request('/api/hermes/profiles', {
            method: 'POST',
            body: JSON.stringify({ name, clone }),
        });
        return true;
    }
    catch {
        return false;
    }
}
export async function deleteProfile(name) {
    try {
        await request(`/api/hermes/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
        return true;
    }
    catch {
        return false;
    }
}
export async function renameProfile(name, newName) {
    try {
        await request(`/api/hermes/profiles/${encodeURIComponent(name)}/rename`, {
            method: 'POST',
            body: JSON.stringify({ new_name: newName }),
        });
        return true;
    }
    catch {
        return false;
    }
}
export async function switchProfile(name) {
    try {
        await request('/api/hermes/profiles/active', {
            method: 'PUT',
            body: JSON.stringify({ name }),
        });
        return true;
    }
    catch {
        return false;
    }
}
export async function exportProfile(name) {
    try {
        const baseUrl = getBaseUrlValue();
        const token = getApiKey();
        const headers = {};
        if (token)
            headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(`${baseUrl}/api/hermes/profiles/${encodeURIComponent(name)}/export`, {
            method: 'POST',
            headers,
        });
        if (!res.ok)
            throw new Error();
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `hermes-profile-${name}.tar.gz`;
        a.click();
        URL.revokeObjectURL(url);
        return true;
    }
    catch {
        return false;
    }
}
export async function importProfile(file) {
    try {
        const baseUrl = getBaseUrlValue();
        const token = getApiKey();
        const headers = {};
        if (token)
            headers['Authorization'] = `Bearer ${token}`;
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch(`${baseUrl}/api/hermes/profiles/import`, {
            method: 'POST',
            headers,
            body: formData,
        });
        return res.ok;
    }
    catch {
        return false;
    }
}
