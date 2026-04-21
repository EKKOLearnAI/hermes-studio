import { request } from '../client';
export async function fetchGateways() {
    const res = await request('/api/hermes/gateways');
    return res.gateways;
}
export async function startGateway(name) {
    const res = await request(`/api/hermes/gateways/${name}/start`, { method: 'POST' });
    return res.gateway;
}
export async function stopGateway(name) {
    await request(`/api/hermes/gateways/${name}/stop`, { method: 'POST' });
}
export async function checkGatewayHealth(name) {
    const res = await request(`/api/hermes/gateways/${name}/health`);
    return res.gateway;
}
