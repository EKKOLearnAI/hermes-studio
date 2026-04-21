import { defineStore } from 'pinia';
import { ref } from 'vue';
import { fetchGateways, startGateway, stopGateway } from '@/api/hermes/gateways';
export const useGatewayStore = defineStore('gateways', () => {
    const gateways = ref([]);
    const loading = ref(false);
    async function fetchStatus() {
        loading.value = true;
        try {
            const data = await fetchGateways();
            gateways.value = Array.isArray(data) ? data : Object.values(data || {});
        }
        finally {
            loading.value = false;
        }
    }
    async function start(name) {
        loading.value = true;
        try {
            const status = await startGateway(name);
            // Update the specific gateway in the list
            const idx = gateways.value.findIndex(g => g.profile === name);
            if (idx >= 0) {
                gateways.value[idx] = status;
            }
            else {
                gateways.value.push(status);
            }
        }
        finally {
            loading.value = false;
        }
    }
    async function stop(name) {
        loading.value = true;
        try {
            await stopGateway(name);
            // Update the specific gateway in the list
            const gw = gateways.value.find(g => g.profile === name);
            if (gw) {
                gw.running = false;
                gw.pid = undefined;
            }
        }
        finally {
            loading.value = false;
        }
    }
    return { gateways, loading, fetchStatus, start, stop };
});
