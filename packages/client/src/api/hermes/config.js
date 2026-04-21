import { request } from '../client';
export async function fetchConfig(sections) {
    const query = sections ? `?sections=${sections.join(',')}` : '';
    return request(`/api/hermes/config${query}`);
}
export async function updateConfigSection(section, values) {
    await request('/api/hermes/config', {
        method: 'PUT',
        body: JSON.stringify({ section, values }),
    });
}
export async function saveCredentials(platform, values) {
    await request('/api/hermes/config/credentials', {
        method: 'PUT',
        body: JSON.stringify({ platform, values }),
    });
}
export async function fetchWeixinQrCode() {
    return request('/api/hermes/weixin/qrcode');
}
export async function pollWeixinQrStatus(qrcode) {
    return request(`/api/hermes/weixin/qrcode/status?qrcode=${encodeURIComponent(qrcode)}`);
}
export async function saveWeixinCredentials(data) {
    await request('/api/hermes/weixin/save', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}
