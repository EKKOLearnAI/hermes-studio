/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, reactive, onUnmounted } from 'vue';
import { NSwitch, NInput, NButton, useMessage } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/stores/hermes/settings';
import { saveCredentials as saveCredsApi, fetchWeixinQrCode, pollWeixinQrStatus, saveWeixinCredentials } from '@/api/hermes/config';
import PlatformCard from './PlatformCard.vue';
import SettingRow from './SettingRow.vue';
const settingsStore = useSettingsStore();
const message = useMessage();
const { t } = useI18n();
// Track saving state per platform.field
const saving = reactive({});
function savingKey(platform, field) {
    return `${platform}.${field}`;
}
function isSaving(platform, field) {
    return !!saving[savingKey(platform, field)];
}
// Immediate save for switches
async function immediateSave(platform, field, saveFn) {
    const key = savingKey(platform, field);
    saving[key] = true;
    try {
        await saveFn();
        message.success(t('settings.saved'));
    }
    catch (err) {
        message.error(t('settings.saveFailed'));
    }
    finally {
        saving[key] = false;
    }
}
async function saveChannel(platform, field, values) {
    immediateSave(platform, field, () => settingsStore.saveSection(platform, values));
}
// Save credentials to .env (matching hermes gateway setup behavior)
async function saveCredentials(platform, field, values) {
    immediateSave(platform, field, async () => {
        await saveCredsApi(platform, values);
        await settingsStore.fetchSettings();
    });
}
function getCreds(key) {
    return (settingsStore.platforms[key] || {});
}
// Weixin QR code login state
const wxQrUrl = ref('');
const wxQrId = ref('');
const wxQrStatus = ref('idle');
let wxPollTimer = null;
async function startWeixinQrLogin() {
    wxQrStatus.value = 'loading';
    wxQrUrl.value = '';
    wxQrId.value = '';
    stopWeixinPoll();
    try {
        const data = await fetchWeixinQrCode();
        wxQrId.value = data.qrcode;
        wxQrUrl.value = data.qrcode_url;
        window.open(data.qrcode_url, '_blank');
        wxQrStatus.value = 'waiting';
        pollWeixinStatus();
    }
    catch (err) {
        wxQrStatus.value = 'error';
        message.error(err.message || t('platform.qrFetching'));
    }
}
function pollWeixinStatus() {
    if (!wxQrId.value)
        return;
    wxPollTimer = setTimeout(async () => {
        try {
            const data = await pollWeixinQrStatus(wxQrId.value);
            if (data.status === 'wait') {
                pollWeixinStatus();
            }
            else if (data.status === 'scaned') {
                wxQrStatus.value = 'scaned';
                pollWeixinStatus();
            }
            else if (data.status === 'expired') {
                wxQrStatus.value = 'expired';
            }
            else if (data.status === 'confirmed') {
                wxQrStatus.value = 'confirmed';
                await saveWeixinCredentials({
                    account_id: data.account_id,
                    token: data.token,
                    base_url: data.base_url,
                });
                await settingsStore.fetchSettings();
                message.success(t('settings.saved'));
            }
        }
        catch {
            pollWeixinStatus();
        }
    }, 3000);
}
function stopWeixinPoll() {
    if (wxPollTimer) {
        clearTimeout(wxPollTimer);
        wxPollTimer = null;
    }
}
onUnmounted(() => {
    stopWeixinPoll();
});
const platforms = [
    {
        key: 'telegram',
        name: 'Telegram',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>',
    },
    {
        key: 'discord',
        name: 'Discord',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z"/></svg>',
    },
    {
        key: 'slack',
        name: 'Slack',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 0a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V5.042zm-1.27 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.27a2.527 2.527 0 0 1 2.523-2.52h6.313A2.528 2.528 0 0 1 24 18.956a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/></svg>',
    },
    {
        key: 'whatsapp',
        name: 'WhatsApp',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>',
    },
    {
        key: 'matrix',
        name: 'Matrix',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M.632.55v22.9H2.28V24H0V0h2.28v.55zm7.043 7.26v1.157h.033c.309-.443.683-.784 1.117-1.024.433-.245.936-.365 1.5-.365.54 0 1.033.107 1.48.324.448.217.786.619 1.017 1.205.24-.376.558-.702.956-.98.398-.277.872-.414 1.424-.414.41 0 .784.065 1.122.194.34.13.629.325.87.588.241.263.428.59.56.984.132.393.198.85.198 1.368v5.89h-2.49v-4.893c0-.268-.016-.525-.048-.77a1.627 1.627 0 00-.2-.63 1.028 1.028 0 00-.392-.426 1.294 1.294 0 00-.616-.134c-.277 0-.508.05-.693.15a1.043 1.043 0 00-.43.41 1.768 1.768 0 00-.214.616 4.15 4.15 0 00-.06.74v4.937H9.29v-4.937c0-.25-.01-.498-.032-.742a1.84 1.84 0 00-.166-.638.998.998 0 00-.363-.448 1.206 1.206 0 00-.624-.154c-.26 0-.483.048-.67.144a1.055 1.055 0 00-.436.402 1.744 1.744 0 00-.227.616 4.108 4.108 0 00-.063.74v4.937H5.21V7.81zm15.693 15.64V.55H21.72V0H24v24h-2.28v-.55z"/></svg>',
    },
    {
        key: 'feishu',
        name: 'Feishu',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.59 3.41a2.25 2.25 0 0 1 3.182 0L13.5 7.14l-3.182 3.182L6.59 7.59a2.25 2.25 0 0 1 0-3.182zm5.303 5.303L15.075 5.53a2.25 2.25 0 0 1 3.182 3.182L15.075 11.894 11.893 8.713zM3.41 6.59a2.25 2.25 0 0 1 3.182 0l3.182 3.182-3.182 3.182a2.25 2.25 0 0 1-3.182-3.182L3.41 6.59zm5.303 5.303L11.894 15.075a2.25 2.25 0 0 1-3.182 3.182L5.53 15.075 8.713 11.893zm5.303-5.303L17.478 9.778a2.25 2.25 0 0 1-3.182 3.182L10.53 10.075l3.182-3.182 0 .023z"/></svg>',
    },
    {
        key: 'weixin',
        name: 'Weixin',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 01.213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 00.167-.054l1.903-1.114a.864.864 0 01.717-.098 10.16 10.16 0 002.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 01-1.162 1.178A1.17 1.17 0 014.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 01-1.162 1.178 1.17 1.17 0 01-1.162-1.178c0-.651.52-1.18 1.162-1.18zm3.68 4.025c-3.694 0-6.69 2.462-6.69 5.496 0 3.034 2.996 5.496 6.69 5.496.753 0 1.477-.1 2.158-.28a.66.66 0 01.548.074l1.46.854a.25.25 0 00.127.041.224.224 0 00.221-.225c0-.055-.022-.109-.037-.162l-.298-1.131a.453.453 0 01.163-.509C21.81 18.613 22.77 16.973 22.77 15.512c0-3.034-2.996-5.496-6.69-5.496h.198zm-2.454 3.347c.491 0 .889.404.889.902a.896.896 0 01-.889.903.896.896 0 01-.889-.903c0-.498.398-.902.889-.902zm4.912 0c.491 0 .889.404.889.902a.896.896 0 01-.889.903.896.896 0 01-.889-.903c0-.498.398-.902.889-.902z"/></svg>',
    },
    {
        key: 'wecom',
        name: 'WeCom',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 01.213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 00.167-.054l1.903-1.114a.864.864 0 01.717-.098 10.16 10.16 0 002.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 01-1.162 1.178A1.17 1.17 0 014.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 01-1.162 1.178 1.17 1.17 0 01-1.162-1.178c0-.651.52-1.18 1.162-1.18zm3.68 4.025c-3.694 0-6.69 2.462-6.69 5.496 0 3.034 2.996 5.496 6.69 5.496.753 0 1.477-.1 2.158-.28a.66.66 0 01.548.074l1.46.854a.25.25 0 00.127.041.224.224 0 00.221-.225c0-.055-.022-.109-.037-.162l-.298-1.131a.453.453 0 01.163-.509C21.81 18.613 22.77 16.973 22.77 15.512c0-3.034-2.996-5.496-6.69-5.496h.198zm-2.454 3.347c.491 0 .889.404.889.902a.896.896 0 01-.889.903.896.896 0 01-.889-.903c0-.498.398-.902.889-.902zm4.912 0c.491 0 .889.404.889.902a.896.896 0 01-.889.903.896.896 0 01-.889-.903c0-.498.398-.902.889-.902z"/></svg>',
    },
];
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
    ...{ class: "settings-section" },
});
/** @type {__VLS_StyleScopedClasses['settings-section']} */ ;
for (const [p] of __VLS_vFor((__VLS_ctx.platforms))) {
    const __VLS_0 = PlatformCard || PlatformCard;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
        key: (p.key),
        name: (p.name),
        icon: (p.icon),
        config: __VLS_ctx.settingsStore[p.key],
        credentials: (__VLS_ctx.getCreds(p.key)),
    }));
    const __VLS_2 = __VLS_1({
        key: (p.key),
        name: (p.name),
        icon: (p.icon),
        config: __VLS_ctx.settingsStore[p.key],
        credentials: (__VLS_ctx.getCreds(p.key)),
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    const { default: __VLS_5 } = __VLS_3.slots;
    if (p.key === 'telegram') {
        const __VLS_6 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
            label: (__VLS_ctx.t('platform.botToken')),
            hint: (__VLS_ctx.t('platform.botTokenHint')),
        }));
        const __VLS_8 = __VLS_7({
            label: (__VLS_ctx.t('platform.botToken')),
            hint: (__VLS_ctx.t('platform.botTokenHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_7));
        const { default: __VLS_11 } = __VLS_9.slots;
        let __VLS_12;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_13 = __VLS_asFunctionalComponent1(__VLS_12, new __VLS_12({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('telegram').token || ''),
            loading: (__VLS_ctx.isSaving('telegram', 'token')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "123456:ABC-DEF...",
        }));
        const __VLS_14 = __VLS_13({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('telegram').token || ''),
            loading: (__VLS_ctx.isSaving('telegram', 'token')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "123456:ABC-DEF...",
        }, ...__VLS_functionalComponentArgsRest(__VLS_13));
        let __VLS_17;
        const __VLS_18 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveCredentials('telegram', 'token', { token: v })) });
        /** @type {__VLS_StyleScopedClasses['input-lg']} */ ;
        var __VLS_15;
        var __VLS_16;
        // @ts-ignore
        [platforms, settingsStore, settingsStore, getCreds, getCreds, t, t, isSaving, saveCredentials,];
        var __VLS_9;
        const __VLS_19 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_20 = __VLS_asFunctionalComponent1(__VLS_19, new __VLS_19({
            label: (__VLS_ctx.t('platform.requireMention')),
            hint: (__VLS_ctx.t('platform.requireMentionGroup')),
        }));
        const __VLS_21 = __VLS_20({
            label: (__VLS_ctx.t('platform.requireMention')),
            hint: (__VLS_ctx.t('platform.requireMentionGroup')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_20));
        const { default: __VLS_24 } = __VLS_22.slots;
        let __VLS_25;
        /** @ts-ignore @type {typeof __VLS_components.NSwitch} */
        NSwitch;
        // @ts-ignore
        const __VLS_26 = __VLS_asFunctionalComponent1(__VLS_25, new __VLS_25({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.telegram.require_mention),
            loading: (__VLS_ctx.isSaving('telegram', 'require_mention')),
        }));
        const __VLS_27 = __VLS_26({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.telegram.require_mention),
            loading: (__VLS_ctx.isSaving('telegram', 'require_mention')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_26));
        let __VLS_30;
        const __VLS_31 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.saveChannel('telegram', 'require_mention', { require_mention: v })) });
        var __VLS_28;
        var __VLS_29;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_22;
        const __VLS_32 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_33 = __VLS_asFunctionalComponent1(__VLS_32, new __VLS_32({
            label: (__VLS_ctx.t('platform.reactions')),
            hint: (__VLS_ctx.t('platform.reactionsHint')),
        }));
        const __VLS_34 = __VLS_33({
            label: (__VLS_ctx.t('platform.reactions')),
            hint: (__VLS_ctx.t('platform.reactionsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_33));
        const { default: __VLS_37 } = __VLS_35.slots;
        let __VLS_38;
        /** @ts-ignore @type {typeof __VLS_components.NSwitch} */
        NSwitch;
        // @ts-ignore
        const __VLS_39 = __VLS_asFunctionalComponent1(__VLS_38, new __VLS_38({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.telegram.reactions),
            loading: (__VLS_ctx.isSaving('telegram', 'reactions')),
        }));
        const __VLS_40 = __VLS_39({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.telegram.reactions),
            loading: (__VLS_ctx.isSaving('telegram', 'reactions')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_39));
        let __VLS_43;
        const __VLS_44 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.saveChannel('telegram', 'reactions', { reactions: v })) });
        var __VLS_41;
        var __VLS_42;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_35;
        const __VLS_45 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_46 = __VLS_asFunctionalComponent1(__VLS_45, new __VLS_45({
            label: (__VLS_ctx.t('platform.freeResponseChats')),
            hint: (__VLS_ctx.t('platform.freeResponseChatsHint')),
        }));
        const __VLS_47 = __VLS_46({
            label: (__VLS_ctx.t('platform.freeResponseChats')),
            hint: (__VLS_ctx.t('platform.freeResponseChatsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_46));
        const { default: __VLS_50 } = __VLS_48.slots;
        let __VLS_51;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_52 = __VLS_asFunctionalComponent1(__VLS_51, new __VLS_51({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.telegram.free_response_chats || ''),
            loading: (__VLS_ctx.isSaving('telegram', 'free_response_chats')),
            size: "small",
            placeholder: "chat_id1,chat_id2",
        }));
        const __VLS_53 = __VLS_52({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.telegram.free_response_chats || ''),
            loading: (__VLS_ctx.isSaving('telegram', 'free_response_chats')),
            size: "small",
            placeholder: "chat_id1,chat_id2",
        }, ...__VLS_functionalComponentArgsRest(__VLS_52));
        let __VLS_56;
        const __VLS_57 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveChannel('telegram', 'free_response_chats', { free_response_chats: v })) });
        var __VLS_54;
        var __VLS_55;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_48;
        const __VLS_58 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_59 = __VLS_asFunctionalComponent1(__VLS_58, new __VLS_58({
            label: (__VLS_ctx.t('platform.mentionPatterns')),
            hint: (__VLS_ctx.t('platform.mentionPatternsHint')),
        }));
        const __VLS_60 = __VLS_59({
            label: (__VLS_ctx.t('platform.mentionPatterns')),
            hint: (__VLS_ctx.t('platform.mentionPatternsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_59));
        const { default: __VLS_63 } = __VLS_61.slots;
        let __VLS_64;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_65 = __VLS_asFunctionalComponent1(__VLS_64, new __VLS_64({
            ...{ 'onChange': {} },
            defaultValue: ((__VLS_ctx.settingsStore.telegram.mention_patterns || []).join(', ')),
            loading: (__VLS_ctx.isSaving('telegram', 'mention_patterns')),
            size: "small",
            placeholder: "pattern1, pattern2",
        }));
        const __VLS_66 = __VLS_65({
            ...{ 'onChange': {} },
            defaultValue: ((__VLS_ctx.settingsStore.telegram.mention_patterns || []).join(', ')),
            loading: (__VLS_ctx.isSaving('telegram', 'mention_patterns')),
            size: "small",
            placeholder: "pattern1, pattern2",
        }, ...__VLS_functionalComponentArgsRest(__VLS_65));
        let __VLS_69;
        const __VLS_70 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveChannel('telegram', 'mention_patterns', { mention_patterns: v ? v.split(',').map(s => s.trim()) : [] })) });
        var __VLS_67;
        var __VLS_68;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_61;
    }
    if (p.key === 'discord') {
        const __VLS_71 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_72 = __VLS_asFunctionalComponent1(__VLS_71, new __VLS_71({
            label: (__VLS_ctx.t('platform.botToken')),
            hint: (__VLS_ctx.t('platform.botTokenHint')),
        }));
        const __VLS_73 = __VLS_72({
            label: (__VLS_ctx.t('platform.botToken')),
            hint: (__VLS_ctx.t('platform.botTokenHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_72));
        const { default: __VLS_76 } = __VLS_74.slots;
        let __VLS_77;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_78 = __VLS_asFunctionalComponent1(__VLS_77, new __VLS_77({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('discord').token || ''),
            loading: (__VLS_ctx.isSaving('discord', 'token')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "Bot token...",
        }));
        const __VLS_79 = __VLS_78({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('discord').token || ''),
            loading: (__VLS_ctx.isSaving('discord', 'token')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "Bot token...",
        }, ...__VLS_functionalComponentArgsRest(__VLS_78));
        let __VLS_82;
        const __VLS_83 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveCredentials('discord', 'token', { token: v })) });
        /** @type {__VLS_StyleScopedClasses['input-lg']} */ ;
        var __VLS_80;
        var __VLS_81;
        // @ts-ignore
        [getCreds, t, t, isSaving, saveCredentials,];
        var __VLS_74;
        const __VLS_84 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_85 = __VLS_asFunctionalComponent1(__VLS_84, new __VLS_84({
            label: (__VLS_ctx.t('platform.requireMention')),
            hint: (__VLS_ctx.t('platform.requireMentionChannel')),
        }));
        const __VLS_86 = __VLS_85({
            label: (__VLS_ctx.t('platform.requireMention')),
            hint: (__VLS_ctx.t('platform.requireMentionChannel')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_85));
        const { default: __VLS_89 } = __VLS_87.slots;
        let __VLS_90;
        /** @ts-ignore @type {typeof __VLS_components.NSwitch} */
        NSwitch;
        // @ts-ignore
        const __VLS_91 = __VLS_asFunctionalComponent1(__VLS_90, new __VLS_90({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.discord.require_mention),
            loading: (__VLS_ctx.isSaving('discord', 'require_mention')),
        }));
        const __VLS_92 = __VLS_91({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.discord.require_mention),
            loading: (__VLS_ctx.isSaving('discord', 'require_mention')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_91));
        let __VLS_95;
        const __VLS_96 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.saveChannel('discord', 'require_mention', { require_mention: v })) });
        var __VLS_93;
        var __VLS_94;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_87;
        const __VLS_97 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_98 = __VLS_asFunctionalComponent1(__VLS_97, new __VLS_97({
            label: (__VLS_ctx.t('platform.autoThread')),
            hint: (__VLS_ctx.t('platform.autoThreadHint')),
        }));
        const __VLS_99 = __VLS_98({
            label: (__VLS_ctx.t('platform.autoThread')),
            hint: (__VLS_ctx.t('platform.autoThreadHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_98));
        const { default: __VLS_102 } = __VLS_100.slots;
        let __VLS_103;
        /** @ts-ignore @type {typeof __VLS_components.NSwitch} */
        NSwitch;
        // @ts-ignore
        const __VLS_104 = __VLS_asFunctionalComponent1(__VLS_103, new __VLS_103({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.discord.auto_thread),
            loading: (__VLS_ctx.isSaving('discord', 'auto_thread')),
        }));
        const __VLS_105 = __VLS_104({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.discord.auto_thread),
            loading: (__VLS_ctx.isSaving('discord', 'auto_thread')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_104));
        let __VLS_108;
        const __VLS_109 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.saveChannel('discord', 'auto_thread', { auto_thread: v })) });
        var __VLS_106;
        var __VLS_107;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_100;
        const __VLS_110 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_111 = __VLS_asFunctionalComponent1(__VLS_110, new __VLS_110({
            label: (__VLS_ctx.t('platform.reactions')),
            hint: (__VLS_ctx.t('platform.reactionsHint')),
        }));
        const __VLS_112 = __VLS_111({
            label: (__VLS_ctx.t('platform.reactions')),
            hint: (__VLS_ctx.t('platform.reactionsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_111));
        const { default: __VLS_115 } = __VLS_113.slots;
        let __VLS_116;
        /** @ts-ignore @type {typeof __VLS_components.NSwitch} */
        NSwitch;
        // @ts-ignore
        const __VLS_117 = __VLS_asFunctionalComponent1(__VLS_116, new __VLS_116({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.discord.reactions),
            loading: (__VLS_ctx.isSaving('discord', 'reactions')),
        }));
        const __VLS_118 = __VLS_117({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.discord.reactions),
            loading: (__VLS_ctx.isSaving('discord', 'reactions')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_117));
        let __VLS_121;
        const __VLS_122 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.saveChannel('discord', 'reactions', { reactions: v })) });
        var __VLS_119;
        var __VLS_120;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_113;
        const __VLS_123 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_124 = __VLS_asFunctionalComponent1(__VLS_123, new __VLS_123({
            label: (__VLS_ctx.t('platform.freeResponseChannels')),
            hint: (__VLS_ctx.t('platform.freeResponseChannelsHint')),
        }));
        const __VLS_125 = __VLS_124({
            label: (__VLS_ctx.t('platform.freeResponseChannels')),
            hint: (__VLS_ctx.t('platform.freeResponseChannelsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_124));
        const { default: __VLS_128 } = __VLS_126.slots;
        let __VLS_129;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_130 = __VLS_asFunctionalComponent1(__VLS_129, new __VLS_129({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.discord.free_response_channels || ''),
            loading: (__VLS_ctx.isSaving('discord', 'free_response_channels')),
            size: "small",
            placeholder: "channel_id1,channel_id2",
        }));
        const __VLS_131 = __VLS_130({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.discord.free_response_channels || ''),
            loading: (__VLS_ctx.isSaving('discord', 'free_response_channels')),
            size: "small",
            placeholder: "channel_id1,channel_id2",
        }, ...__VLS_functionalComponentArgsRest(__VLS_130));
        let __VLS_134;
        const __VLS_135 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveChannel('discord', 'free_response_channels', { free_response_channels: v })) });
        var __VLS_132;
        var __VLS_133;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_126;
        const __VLS_136 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_137 = __VLS_asFunctionalComponent1(__VLS_136, new __VLS_136({
            label: (__VLS_ctx.t('platform.allowedChannels')),
            hint: (__VLS_ctx.t('platform.allowedChannelsHint')),
        }));
        const __VLS_138 = __VLS_137({
            label: (__VLS_ctx.t('platform.allowedChannels')),
            hint: (__VLS_ctx.t('platform.allowedChannelsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_137));
        const { default: __VLS_141 } = __VLS_139.slots;
        let __VLS_142;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_143 = __VLS_asFunctionalComponent1(__VLS_142, new __VLS_142({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.discord.allowed_channels || ''),
            loading: (__VLS_ctx.isSaving('discord', 'allowed_channels')),
            size: "small",
            placeholder: "channel_id1,channel_id2",
        }));
        const __VLS_144 = __VLS_143({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.discord.allowed_channels || ''),
            loading: (__VLS_ctx.isSaving('discord', 'allowed_channels')),
            size: "small",
            placeholder: "channel_id1,channel_id2",
        }, ...__VLS_functionalComponentArgsRest(__VLS_143));
        let __VLS_147;
        const __VLS_148 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveChannel('discord', 'allowed_channels', { allowed_channels: v })) });
        var __VLS_145;
        var __VLS_146;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_139;
        const __VLS_149 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_150 = __VLS_asFunctionalComponent1(__VLS_149, new __VLS_149({
            label: (__VLS_ctx.t('platform.ignoredChannels')),
            hint: (__VLS_ctx.t('platform.ignoredChannelsHint')),
        }));
        const __VLS_151 = __VLS_150({
            label: (__VLS_ctx.t('platform.ignoredChannels')),
            hint: (__VLS_ctx.t('platform.ignoredChannelsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_150));
        const { default: __VLS_154 } = __VLS_152.slots;
        let __VLS_155;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_156 = __VLS_asFunctionalComponent1(__VLS_155, new __VLS_155({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.discord.ignored_channels || ''),
            loading: (__VLS_ctx.isSaving('discord', 'ignored_channels')),
            size: "small",
            placeholder: "channel_id1,channel_id2",
        }));
        const __VLS_157 = __VLS_156({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.discord.ignored_channels || ''),
            loading: (__VLS_ctx.isSaving('discord', 'ignored_channels')),
            size: "small",
            placeholder: "channel_id1,channel_id2",
        }, ...__VLS_functionalComponentArgsRest(__VLS_156));
        let __VLS_160;
        const __VLS_161 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveChannel('discord', 'ignored_channels', { ignored_channels: v })) });
        var __VLS_158;
        var __VLS_159;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_152;
        const __VLS_162 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_163 = __VLS_asFunctionalComponent1(__VLS_162, new __VLS_162({
            label: (__VLS_ctx.t('platform.noThreadChannels')),
            hint: (__VLS_ctx.t('platform.noThreadChannelsHint')),
        }));
        const __VLS_164 = __VLS_163({
            label: (__VLS_ctx.t('platform.noThreadChannels')),
            hint: (__VLS_ctx.t('platform.noThreadChannelsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_163));
        const { default: __VLS_167 } = __VLS_165.slots;
        let __VLS_168;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_169 = __VLS_asFunctionalComponent1(__VLS_168, new __VLS_168({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.discord.no_thread_channels || ''),
            loading: (__VLS_ctx.isSaving('discord', 'no_thread_channels')),
            size: "small",
            placeholder: "channel_id1,channel_id2",
        }));
        const __VLS_170 = __VLS_169({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.discord.no_thread_channels || ''),
            loading: (__VLS_ctx.isSaving('discord', 'no_thread_channels')),
            size: "small",
            placeholder: "channel_id1,channel_id2",
        }, ...__VLS_functionalComponentArgsRest(__VLS_169));
        let __VLS_173;
        const __VLS_174 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveChannel('discord', 'no_thread_channels', { no_thread_channels: v })) });
        var __VLS_171;
        var __VLS_172;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_165;
    }
    if (p.key === 'slack') {
        const __VLS_175 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_176 = __VLS_asFunctionalComponent1(__VLS_175, new __VLS_175({
            label: (__VLS_ctx.t('platform.botToken')),
            hint: (__VLS_ctx.t('platform.botTokenHint')),
        }));
        const __VLS_177 = __VLS_176({
            label: (__VLS_ctx.t('platform.botToken')),
            hint: (__VLS_ctx.t('platform.botTokenHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_176));
        const { default: __VLS_180 } = __VLS_178.slots;
        let __VLS_181;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_182 = __VLS_asFunctionalComponent1(__VLS_181, new __VLS_181({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('slack').token || ''),
            loading: (__VLS_ctx.isSaving('slack', 'token')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "xoxb-...",
        }));
        const __VLS_183 = __VLS_182({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('slack').token || ''),
            loading: (__VLS_ctx.isSaving('slack', 'token')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "xoxb-...",
        }, ...__VLS_functionalComponentArgsRest(__VLS_182));
        let __VLS_186;
        const __VLS_187 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveCredentials('slack', 'token', { token: v })) });
        /** @type {__VLS_StyleScopedClasses['input-lg']} */ ;
        var __VLS_184;
        var __VLS_185;
        // @ts-ignore
        [getCreds, t, t, isSaving, saveCredentials,];
        var __VLS_178;
        const __VLS_188 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_189 = __VLS_asFunctionalComponent1(__VLS_188, new __VLS_188({
            label: (__VLS_ctx.t('platform.requireMention')),
            hint: (__VLS_ctx.t('platform.requireMentionChannel')),
        }));
        const __VLS_190 = __VLS_189({
            label: (__VLS_ctx.t('platform.requireMention')),
            hint: (__VLS_ctx.t('platform.requireMentionChannel')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_189));
        const { default: __VLS_193 } = __VLS_191.slots;
        let __VLS_194;
        /** @ts-ignore @type {typeof __VLS_components.NSwitch} */
        NSwitch;
        // @ts-ignore
        const __VLS_195 = __VLS_asFunctionalComponent1(__VLS_194, new __VLS_194({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.slack.require_mention),
            loading: (__VLS_ctx.isSaving('slack', 'require_mention')),
        }));
        const __VLS_196 = __VLS_195({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.slack.require_mention),
            loading: (__VLS_ctx.isSaving('slack', 'require_mention')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_195));
        let __VLS_199;
        const __VLS_200 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.saveChannel('slack', 'require_mention', { require_mention: v })) });
        var __VLS_197;
        var __VLS_198;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_191;
        const __VLS_201 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_202 = __VLS_asFunctionalComponent1(__VLS_201, new __VLS_201({
            label: (__VLS_ctx.t('platform.allowBots')),
            hint: (__VLS_ctx.t('platform.allowBotsHint')),
        }));
        const __VLS_203 = __VLS_202({
            label: (__VLS_ctx.t('platform.allowBots')),
            hint: (__VLS_ctx.t('platform.allowBotsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_202));
        const { default: __VLS_206 } = __VLS_204.slots;
        let __VLS_207;
        /** @ts-ignore @type {typeof __VLS_components.NSwitch} */
        NSwitch;
        // @ts-ignore
        const __VLS_208 = __VLS_asFunctionalComponent1(__VLS_207, new __VLS_207({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.slack.allow_bots),
            loading: (__VLS_ctx.isSaving('slack', 'allow_bots')),
        }));
        const __VLS_209 = __VLS_208({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.slack.allow_bots),
            loading: (__VLS_ctx.isSaving('slack', 'allow_bots')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_208));
        let __VLS_212;
        const __VLS_213 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.saveChannel('slack', 'allow_bots', { allow_bots: v })) });
        var __VLS_210;
        var __VLS_211;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_204;
        const __VLS_214 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_215 = __VLS_asFunctionalComponent1(__VLS_214, new __VLS_214({
            label: (__VLS_ctx.t('platform.freeResponseChannels')),
            hint: (__VLS_ctx.t('platform.freeResponseChannelsHint')),
        }));
        const __VLS_216 = __VLS_215({
            label: (__VLS_ctx.t('platform.freeResponseChannels')),
            hint: (__VLS_ctx.t('platform.freeResponseChannelsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_215));
        const { default: __VLS_219 } = __VLS_217.slots;
        let __VLS_220;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_221 = __VLS_asFunctionalComponent1(__VLS_220, new __VLS_220({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.slack.free_response_channels || ''),
            loading: (__VLS_ctx.isSaving('slack', 'free_response_channels')),
            size: "small",
            placeholder: "channel_id1,channel_id2",
        }));
        const __VLS_222 = __VLS_221({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.slack.free_response_channels || ''),
            loading: (__VLS_ctx.isSaving('slack', 'free_response_channels')),
            size: "small",
            placeholder: "channel_id1,channel_id2",
        }, ...__VLS_functionalComponentArgsRest(__VLS_221));
        let __VLS_225;
        const __VLS_226 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveChannel('slack', 'free_response_channels', { free_response_channels: v })) });
        var __VLS_223;
        var __VLS_224;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_217;
    }
    if (p.key === 'whatsapp') {
        const __VLS_227 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_228 = __VLS_asFunctionalComponent1(__VLS_227, new __VLS_227({
            label: (__VLS_ctx.t('platform.waEnabled')),
            hint: (__VLS_ctx.t('platform.waEnabledHint')),
        }));
        const __VLS_229 = __VLS_228({
            label: (__VLS_ctx.t('platform.waEnabled')),
            hint: (__VLS_ctx.t('platform.waEnabledHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_228));
        const { default: __VLS_232 } = __VLS_230.slots;
        let __VLS_233;
        /** @ts-ignore @type {typeof __VLS_components.NSwitch} */
        NSwitch;
        // @ts-ignore
        const __VLS_234 = __VLS_asFunctionalComponent1(__VLS_233, new __VLS_233({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.getCreds('whatsapp').enabled),
            loading: (__VLS_ctx.isSaving('whatsapp', 'enabled')),
        }));
        const __VLS_235 = __VLS_234({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.getCreds('whatsapp').enabled),
            loading: (__VLS_ctx.isSaving('whatsapp', 'enabled')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_234));
        let __VLS_238;
        const __VLS_239 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.saveCredentials('whatsapp', 'enabled', { enabled: v })) });
        var __VLS_236;
        var __VLS_237;
        // @ts-ignore
        [getCreds, t, t, isSaving, saveCredentials,];
        var __VLS_230;
        const __VLS_240 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_241 = __VLS_asFunctionalComponent1(__VLS_240, new __VLS_240({
            label: (__VLS_ctx.t('platform.requireMention')),
            hint: (__VLS_ctx.t('platform.requireMentionGroup')),
        }));
        const __VLS_242 = __VLS_241({
            label: (__VLS_ctx.t('platform.requireMention')),
            hint: (__VLS_ctx.t('platform.requireMentionGroup')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_241));
        const { default: __VLS_245 } = __VLS_243.slots;
        let __VLS_246;
        /** @ts-ignore @type {typeof __VLS_components.NSwitch} */
        NSwitch;
        // @ts-ignore
        const __VLS_247 = __VLS_asFunctionalComponent1(__VLS_246, new __VLS_246({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.whatsapp.require_mention),
            loading: (__VLS_ctx.isSaving('whatsapp', 'require_mention')),
        }));
        const __VLS_248 = __VLS_247({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.whatsapp.require_mention),
            loading: (__VLS_ctx.isSaving('whatsapp', 'require_mention')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_247));
        let __VLS_251;
        const __VLS_252 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.saveChannel('whatsapp', 'require_mention', { require_mention: v })) });
        var __VLS_249;
        var __VLS_250;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_243;
        const __VLS_253 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_254 = __VLS_asFunctionalComponent1(__VLS_253, new __VLS_253({
            label: (__VLS_ctx.t('platform.freeResponseChats')),
            hint: (__VLS_ctx.t('platform.freeResponseChatsHint')),
        }));
        const __VLS_255 = __VLS_254({
            label: (__VLS_ctx.t('platform.freeResponseChats')),
            hint: (__VLS_ctx.t('platform.freeResponseChatsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_254));
        const { default: __VLS_258 } = __VLS_256.slots;
        let __VLS_259;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_260 = __VLS_asFunctionalComponent1(__VLS_259, new __VLS_259({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.whatsapp.free_response_chats || ''),
            loading: (__VLS_ctx.isSaving('whatsapp', 'free_response_chats')),
            size: "small",
            placeholder: "chat_id1,chat_id2",
        }));
        const __VLS_261 = __VLS_260({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.whatsapp.free_response_chats || ''),
            loading: (__VLS_ctx.isSaving('whatsapp', 'free_response_chats')),
            size: "small",
            placeholder: "chat_id1,chat_id2",
        }, ...__VLS_functionalComponentArgsRest(__VLS_260));
        let __VLS_264;
        const __VLS_265 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveChannel('whatsapp', 'free_response_chats', { free_response_chats: v })) });
        var __VLS_262;
        var __VLS_263;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_256;
        const __VLS_266 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_267 = __VLS_asFunctionalComponent1(__VLS_266, new __VLS_266({
            label: (__VLS_ctx.t('platform.mentionPatterns')),
            hint: (__VLS_ctx.t('platform.mentionPatternsHint')),
        }));
        const __VLS_268 = __VLS_267({
            label: (__VLS_ctx.t('platform.mentionPatterns')),
            hint: (__VLS_ctx.t('platform.mentionPatternsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_267));
        const { default: __VLS_271 } = __VLS_269.slots;
        let __VLS_272;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_273 = __VLS_asFunctionalComponent1(__VLS_272, new __VLS_272({
            ...{ 'onChange': {} },
            defaultValue: ((__VLS_ctx.settingsStore.whatsapp.mention_patterns || []).join(', ')),
            loading: (__VLS_ctx.isSaving('whatsapp', 'mention_patterns')),
            size: "small",
            placeholder: "pattern1, pattern2",
        }));
        const __VLS_274 = __VLS_273({
            ...{ 'onChange': {} },
            defaultValue: ((__VLS_ctx.settingsStore.whatsapp.mention_patterns || []).join(', ')),
            loading: (__VLS_ctx.isSaving('whatsapp', 'mention_patterns')),
            size: "small",
            placeholder: "pattern1, pattern2",
        }, ...__VLS_functionalComponentArgsRest(__VLS_273));
        let __VLS_277;
        const __VLS_278 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveChannel('whatsapp', 'mention_patterns', { mention_patterns: v ? v.split(',').map(s => s.trim()) : [] })) });
        var __VLS_275;
        var __VLS_276;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_269;
    }
    if (p.key === 'matrix') {
        const __VLS_279 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_280 = __VLS_asFunctionalComponent1(__VLS_279, new __VLS_279({
            label: (__VLS_ctx.t('platform.accessToken')),
            hint: (__VLS_ctx.t('platform.accessTokenHint')),
        }));
        const __VLS_281 = __VLS_280({
            label: (__VLS_ctx.t('platform.accessToken')),
            hint: (__VLS_ctx.t('platform.accessTokenHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_280));
        const { default: __VLS_284 } = __VLS_282.slots;
        let __VLS_285;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_286 = __VLS_asFunctionalComponent1(__VLS_285, new __VLS_285({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('matrix').token || ''),
            loading: (__VLS_ctx.isSaving('matrix', 'token')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "syt_...",
        }));
        const __VLS_287 = __VLS_286({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('matrix').token || ''),
            loading: (__VLS_ctx.isSaving('matrix', 'token')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "syt_...",
        }, ...__VLS_functionalComponentArgsRest(__VLS_286));
        let __VLS_290;
        const __VLS_291 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveCredentials('matrix', 'token', { token: v })) });
        /** @type {__VLS_StyleScopedClasses['input-lg']} */ ;
        var __VLS_288;
        var __VLS_289;
        // @ts-ignore
        [getCreds, t, t, isSaving, saveCredentials,];
        var __VLS_282;
        const __VLS_292 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_293 = __VLS_asFunctionalComponent1(__VLS_292, new __VLS_292({
            label: (__VLS_ctx.t('platform.homeserver')),
            hint: (__VLS_ctx.t('platform.homeserverHint')),
        }));
        const __VLS_294 = __VLS_293({
            label: (__VLS_ctx.t('platform.homeserver')),
            hint: (__VLS_ctx.t('platform.homeserverHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_293));
        const { default: __VLS_297 } = __VLS_295.slots;
        let __VLS_298;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_299 = __VLS_asFunctionalComponent1(__VLS_298, new __VLS_298({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('matrix').extra?.homeserver || ''),
            loading: (__VLS_ctx.isSaving('matrix', 'homeserver')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "https://matrix.org",
        }));
        const __VLS_300 = __VLS_299({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('matrix').extra?.homeserver || ''),
            loading: (__VLS_ctx.isSaving('matrix', 'homeserver')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "https://matrix.org",
        }, ...__VLS_functionalComponentArgsRest(__VLS_299));
        let __VLS_303;
        const __VLS_304 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveCredentials('matrix', 'homeserver', { extra: { ...__VLS_ctx.getCreds('matrix').extra, homeserver: v } })) });
        /** @type {__VLS_StyleScopedClasses['input-lg']} */ ;
        var __VLS_301;
        var __VLS_302;
        // @ts-ignore
        [getCreds, getCreds, t, t, isSaving, saveCredentials,];
        var __VLS_295;
        const __VLS_305 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_306 = __VLS_asFunctionalComponent1(__VLS_305, new __VLS_305({
            label: (__VLS_ctx.t('platform.requireMention')),
            hint: (__VLS_ctx.t('platform.requireMentionRoom')),
        }));
        const __VLS_307 = __VLS_306({
            label: (__VLS_ctx.t('platform.requireMention')),
            hint: (__VLS_ctx.t('platform.requireMentionRoom')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_306));
        const { default: __VLS_310 } = __VLS_308.slots;
        let __VLS_311;
        /** @ts-ignore @type {typeof __VLS_components.NSwitch} */
        NSwitch;
        // @ts-ignore
        const __VLS_312 = __VLS_asFunctionalComponent1(__VLS_311, new __VLS_311({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.matrix.require_mention),
            loading: (__VLS_ctx.isSaving('matrix', 'require_mention')),
        }));
        const __VLS_313 = __VLS_312({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.matrix.require_mention),
            loading: (__VLS_ctx.isSaving('matrix', 'require_mention')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_312));
        let __VLS_316;
        const __VLS_317 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.saveChannel('matrix', 'require_mention', { require_mention: v })) });
        var __VLS_314;
        var __VLS_315;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_308;
        const __VLS_318 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_319 = __VLS_asFunctionalComponent1(__VLS_318, new __VLS_318({
            label: (__VLS_ctx.t('platform.autoThread')),
            hint: (__VLS_ctx.t('platform.autoThreadHintRoom')),
        }));
        const __VLS_320 = __VLS_319({
            label: (__VLS_ctx.t('platform.autoThread')),
            hint: (__VLS_ctx.t('platform.autoThreadHintRoom')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_319));
        const { default: __VLS_323 } = __VLS_321.slots;
        let __VLS_324;
        /** @ts-ignore @type {typeof __VLS_components.NSwitch} */
        NSwitch;
        // @ts-ignore
        const __VLS_325 = __VLS_asFunctionalComponent1(__VLS_324, new __VLS_324({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.matrix.auto_thread),
            loading: (__VLS_ctx.isSaving('matrix', 'auto_thread')),
        }));
        const __VLS_326 = __VLS_325({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.matrix.auto_thread),
            loading: (__VLS_ctx.isSaving('matrix', 'auto_thread')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_325));
        let __VLS_329;
        const __VLS_330 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.saveChannel('matrix', 'auto_thread', { auto_thread: v })) });
        var __VLS_327;
        var __VLS_328;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_321;
        const __VLS_331 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_332 = __VLS_asFunctionalComponent1(__VLS_331, new __VLS_331({
            label: (__VLS_ctx.t('platform.dmMentionThreads')),
            hint: (__VLS_ctx.t('platform.dmMentionThreadsHint')),
        }));
        const __VLS_333 = __VLS_332({
            label: (__VLS_ctx.t('platform.dmMentionThreads')),
            hint: (__VLS_ctx.t('platform.dmMentionThreadsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_332));
        const { default: __VLS_336 } = __VLS_334.slots;
        let __VLS_337;
        /** @ts-ignore @type {typeof __VLS_components.NSwitch} */
        NSwitch;
        // @ts-ignore
        const __VLS_338 = __VLS_asFunctionalComponent1(__VLS_337, new __VLS_337({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.matrix.dm_mention_threads),
            loading: (__VLS_ctx.isSaving('matrix', 'dm_mention_threads')),
        }));
        const __VLS_339 = __VLS_338({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.matrix.dm_mention_threads),
            loading: (__VLS_ctx.isSaving('matrix', 'dm_mention_threads')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_338));
        let __VLS_342;
        const __VLS_343 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.saveChannel('matrix', 'dm_mention_threads', { dm_mention_threads: v })) });
        var __VLS_340;
        var __VLS_341;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_334;
        const __VLS_344 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_345 = __VLS_asFunctionalComponent1(__VLS_344, new __VLS_344({
            label: (__VLS_ctx.t('platform.freeResponseRooms')),
            hint: (__VLS_ctx.t('platform.freeResponseRoomsHint')),
        }));
        const __VLS_346 = __VLS_345({
            label: (__VLS_ctx.t('platform.freeResponseRooms')),
            hint: (__VLS_ctx.t('platform.freeResponseRoomsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_345));
        const { default: __VLS_349 } = __VLS_347.slots;
        let __VLS_350;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_351 = __VLS_asFunctionalComponent1(__VLS_350, new __VLS_350({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.matrix.free_response_rooms || ''),
            loading: (__VLS_ctx.isSaving('matrix', 'free_response_rooms')),
            size: "small",
            placeholder: "room_id1,room_id2",
        }));
        const __VLS_352 = __VLS_351({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.matrix.free_response_rooms || ''),
            loading: (__VLS_ctx.isSaving('matrix', 'free_response_rooms')),
            size: "small",
            placeholder: "room_id1,room_id2",
        }, ...__VLS_functionalComponentArgsRest(__VLS_351));
        let __VLS_355;
        const __VLS_356 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveChannel('matrix', 'free_response_rooms', { free_response_rooms: v })) });
        var __VLS_353;
        var __VLS_354;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_347;
    }
    if (p.key === 'feishu') {
        const __VLS_357 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_358 = __VLS_asFunctionalComponent1(__VLS_357, new __VLS_357({
            label: (__VLS_ctx.t('platform.appId')),
            hint: (__VLS_ctx.t('platform.appIdHint')),
        }));
        const __VLS_359 = __VLS_358({
            label: (__VLS_ctx.t('platform.appId')),
            hint: (__VLS_ctx.t('platform.appIdHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_358));
        const { default: __VLS_362 } = __VLS_360.slots;
        let __VLS_363;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_364 = __VLS_asFunctionalComponent1(__VLS_363, new __VLS_363({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('feishu').extra?.app_id || ''),
            loading: (__VLS_ctx.isSaving('feishu', 'app_id')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "cli_...",
        }));
        const __VLS_365 = __VLS_364({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('feishu').extra?.app_id || ''),
            loading: (__VLS_ctx.isSaving('feishu', 'app_id')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "cli_...",
        }, ...__VLS_functionalComponentArgsRest(__VLS_364));
        let __VLS_368;
        const __VLS_369 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveCredentials('feishu', 'app_id', { extra: { ...__VLS_ctx.getCreds('feishu').extra, app_id: v } })) });
        /** @type {__VLS_StyleScopedClasses['input-lg']} */ ;
        var __VLS_366;
        var __VLS_367;
        // @ts-ignore
        [getCreds, getCreds, t, t, isSaving, saveCredentials,];
        var __VLS_360;
        const __VLS_370 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_371 = __VLS_asFunctionalComponent1(__VLS_370, new __VLS_370({
            label: (__VLS_ctx.t('platform.appSecret')),
            hint: (__VLS_ctx.t('platform.appSecretHint')),
        }));
        const __VLS_372 = __VLS_371({
            label: (__VLS_ctx.t('platform.appSecret')),
            hint: (__VLS_ctx.t('platform.appSecretHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_371));
        const { default: __VLS_375 } = __VLS_373.slots;
        let __VLS_376;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_377 = __VLS_asFunctionalComponent1(__VLS_376, new __VLS_376({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('feishu').extra?.app_secret || ''),
            loading: (__VLS_ctx.isSaving('feishu', 'app_secret')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "App Secret",
        }));
        const __VLS_378 = __VLS_377({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('feishu').extra?.app_secret || ''),
            loading: (__VLS_ctx.isSaving('feishu', 'app_secret')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "App Secret",
        }, ...__VLS_functionalComponentArgsRest(__VLS_377));
        let __VLS_381;
        const __VLS_382 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveCredentials('feishu', 'app_secret', { extra: { ...__VLS_ctx.getCreds('feishu').extra, app_secret: v } })) });
        /** @type {__VLS_StyleScopedClasses['input-lg']} */ ;
        var __VLS_379;
        var __VLS_380;
        // @ts-ignore
        [getCreds, getCreds, t, t, isSaving, saveCredentials,];
        var __VLS_373;
        const __VLS_383 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_384 = __VLS_asFunctionalComponent1(__VLS_383, new __VLS_383({
            label: (__VLS_ctx.t('platform.requireMention')),
            hint: (__VLS_ctx.t('platform.requireMentionGroup')),
        }));
        const __VLS_385 = __VLS_384({
            label: (__VLS_ctx.t('platform.requireMention')),
            hint: (__VLS_ctx.t('platform.requireMentionGroup')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_384));
        const { default: __VLS_388 } = __VLS_386.slots;
        let __VLS_389;
        /** @ts-ignore @type {typeof __VLS_components.NSwitch} */
        NSwitch;
        // @ts-ignore
        const __VLS_390 = __VLS_asFunctionalComponent1(__VLS_389, new __VLS_389({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.feishu.require_mention),
            loading: (__VLS_ctx.isSaving('feishu', 'require_mention')),
        }));
        const __VLS_391 = __VLS_390({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.feishu.require_mention),
            loading: (__VLS_ctx.isSaving('feishu', 'require_mention')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_390));
        let __VLS_394;
        const __VLS_395 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.saveChannel('feishu', 'require_mention', { require_mention: v })) });
        var __VLS_392;
        var __VLS_393;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_386;
        const __VLS_396 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_397 = __VLS_asFunctionalComponent1(__VLS_396, new __VLS_396({
            label: (__VLS_ctx.t('platform.freeResponseChats')),
            hint: (__VLS_ctx.t('platform.freeResponseChatsHint')),
        }));
        const __VLS_398 = __VLS_397({
            label: (__VLS_ctx.t('platform.freeResponseChats')),
            hint: (__VLS_ctx.t('platform.freeResponseChatsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_397));
        const { default: __VLS_401 } = __VLS_399.slots;
        let __VLS_402;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_403 = __VLS_asFunctionalComponent1(__VLS_402, new __VLS_402({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.feishu.free_response_chats || ''),
            loading: (__VLS_ctx.isSaving('feishu', 'free_response_chats')),
            size: "small",
            placeholder: "chat_id1,chat_id2",
        }));
        const __VLS_404 = __VLS_403({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.feishu.free_response_chats || ''),
            loading: (__VLS_ctx.isSaving('feishu', 'free_response_chats')),
            size: "small",
            placeholder: "chat_id1,chat_id2",
        }, ...__VLS_functionalComponentArgsRest(__VLS_403));
        let __VLS_407;
        const __VLS_408 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveChannel('feishu', 'free_response_chats', { free_response_chats: v })) });
        var __VLS_405;
        var __VLS_406;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_399;
    }
    if (p.key === 'dingtalk') {
        const __VLS_409 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_410 = __VLS_asFunctionalComponent1(__VLS_409, new __VLS_409({
            label: (__VLS_ctx.t('platform.clientId')),
            hint: (__VLS_ctx.t('platform.clientIdHint')),
        }));
        const __VLS_411 = __VLS_410({
            label: (__VLS_ctx.t('platform.clientId')),
            hint: (__VLS_ctx.t('platform.clientIdHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_410));
        const { default: __VLS_414 } = __VLS_412.slots;
        let __VLS_415;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_416 = __VLS_asFunctionalComponent1(__VLS_415, new __VLS_415({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('dingtalk').extra?.client_id || ''),
            loading: (__VLS_ctx.isSaving('dingtalk', 'client_id')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "Client ID",
        }));
        const __VLS_417 = __VLS_416({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('dingtalk').extra?.client_id || ''),
            loading: (__VLS_ctx.isSaving('dingtalk', 'client_id')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "Client ID",
        }, ...__VLS_functionalComponentArgsRest(__VLS_416));
        let __VLS_420;
        const __VLS_421 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveCredentials('dingtalk', 'client_id', { extra: { ...__VLS_ctx.getCreds('dingtalk').extra, client_id: v } })) });
        /** @type {__VLS_StyleScopedClasses['input-lg']} */ ;
        var __VLS_418;
        var __VLS_419;
        // @ts-ignore
        [getCreds, getCreds, t, t, isSaving, saveCredentials,];
        var __VLS_412;
        const __VLS_422 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_423 = __VLS_asFunctionalComponent1(__VLS_422, new __VLS_422({
            label: (__VLS_ctx.t('platform.clientSecret')),
            hint: (__VLS_ctx.t('platform.clientSecretHint')),
        }));
        const __VLS_424 = __VLS_423({
            label: (__VLS_ctx.t('platform.clientSecret')),
            hint: (__VLS_ctx.t('platform.clientSecretHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_423));
        const { default: __VLS_427 } = __VLS_425.slots;
        let __VLS_428;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_429 = __VLS_asFunctionalComponent1(__VLS_428, new __VLS_428({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('dingtalk').extra?.client_secret || ''),
            loading: (__VLS_ctx.isSaving('dingtalk', 'client_secret')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "Client Secret",
        }));
        const __VLS_430 = __VLS_429({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('dingtalk').extra?.client_secret || ''),
            loading: (__VLS_ctx.isSaving('dingtalk', 'client_secret')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "Client Secret",
        }, ...__VLS_functionalComponentArgsRest(__VLS_429));
        let __VLS_433;
        const __VLS_434 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveCredentials('dingtalk', 'client_secret', { extra: { ...__VLS_ctx.getCreds('dingtalk').extra, client_secret: v } })) });
        /** @type {__VLS_StyleScopedClasses['input-lg']} */ ;
        var __VLS_431;
        var __VLS_432;
        // @ts-ignore
        [getCreds, getCreds, t, t, isSaving, saveCredentials,];
        var __VLS_425;
        const __VLS_435 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_436 = __VLS_asFunctionalComponent1(__VLS_435, new __VLS_435({
            label: (__VLS_ctx.t('platform.requireMention')),
            hint: (__VLS_ctx.t('platform.requireMentionGroup')),
        }));
        const __VLS_437 = __VLS_436({
            label: (__VLS_ctx.t('platform.requireMention')),
            hint: (__VLS_ctx.t('platform.requireMentionGroup')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_436));
        const { default: __VLS_440 } = __VLS_438.slots;
        let __VLS_441;
        /** @ts-ignore @type {typeof __VLS_components.NSwitch} */
        NSwitch;
        // @ts-ignore
        const __VLS_442 = __VLS_asFunctionalComponent1(__VLS_441, new __VLS_441({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.dingtalk.require_mention),
            loading: (__VLS_ctx.isSaving('dingtalk', 'require_mention')),
        }));
        const __VLS_443 = __VLS_442({
            ...{ 'onUpdate:value': {} },
            value: (__VLS_ctx.settingsStore.dingtalk.require_mention),
            loading: (__VLS_ctx.isSaving('dingtalk', 'require_mention')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_442));
        let __VLS_446;
        const __VLS_447 = ({ 'update:value': {} },
            { 'onUpdate:value': (v => __VLS_ctx.saveChannel('dingtalk', 'require_mention', { require_mention: v })) });
        var __VLS_444;
        var __VLS_445;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_438;
        const __VLS_448 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_449 = __VLS_asFunctionalComponent1(__VLS_448, new __VLS_448({
            label: (__VLS_ctx.t('platform.freeResponseChats')),
            hint: (__VLS_ctx.t('platform.freeResponseChatsHint')),
        }));
        const __VLS_450 = __VLS_449({
            label: (__VLS_ctx.t('platform.freeResponseChats')),
            hint: (__VLS_ctx.t('platform.freeResponseChatsHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_449));
        const { default: __VLS_453 } = __VLS_451.slots;
        let __VLS_454;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_455 = __VLS_asFunctionalComponent1(__VLS_454, new __VLS_454({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.dingtalk.free_response_chats || ''),
            loading: (__VLS_ctx.isSaving('dingtalk', 'free_response_chats')),
            size: "small",
            placeholder: "chat_id1,chat_id2",
        }));
        const __VLS_456 = __VLS_455({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.settingsStore.dingtalk.free_response_chats || ''),
            loading: (__VLS_ctx.isSaving('dingtalk', 'free_response_chats')),
            size: "small",
            placeholder: "chat_id1,chat_id2",
        }, ...__VLS_functionalComponentArgsRest(__VLS_455));
        let __VLS_459;
        const __VLS_460 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveChannel('dingtalk', 'free_response_chats', { free_response_chats: v })) });
        var __VLS_457;
        var __VLS_458;
        // @ts-ignore
        [settingsStore, t, t, isSaving, saveChannel,];
        var __VLS_451;
    }
    if (p.key === 'weixin') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "weixin-qr-section" },
        });
        /** @type {__VLS_StyleScopedClasses['weixin-qr-section']} */ ;
        if (__VLS_ctx.wxQrStatus === 'idle' || __VLS_ctx.wxQrStatus === 'error' || __VLS_ctx.wxQrStatus === 'expired' || __VLS_ctx.wxQrStatus === 'confirmed') {
            let __VLS_461;
            /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
            NButton;
            // @ts-ignore
            const __VLS_462 = __VLS_asFunctionalComponent1(__VLS_461, new __VLS_461({
                ...{ 'onClick': {} },
                type: "primary",
                size: "small",
            }));
            const __VLS_463 = __VLS_462({
                ...{ 'onClick': {} },
                type: "primary",
                size: "small",
            }, ...__VLS_functionalComponentArgsRest(__VLS_462));
            let __VLS_466;
            const __VLS_467 = ({ click: {} },
                { onClick: (__VLS_ctx.startWeixinQrLogin) });
            const { default: __VLS_468 } = __VLS_464.slots;
            (__VLS_ctx.wxQrStatus === 'confirmed' ? __VLS_ctx.t('platform.qrRelogin') : __VLS_ctx.t('platform.qrLogin'));
            // @ts-ignore
            [t, t, wxQrStatus, wxQrStatus, wxQrStatus, wxQrStatus, wxQrStatus, startWeixinQrLogin,];
            var __VLS_464;
            var __VLS_465;
        }
        if (__VLS_ctx.wxQrStatus === 'loading') {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "weixin-qr-loading" },
            });
            /** @type {__VLS_StyleScopedClasses['weixin-qr-loading']} */ ;
            let __VLS_469;
            /** @ts-ignore @type {typeof __VLS_components.NSpin} */
            NSpin;
            // @ts-ignore
            const __VLS_470 = __VLS_asFunctionalComponent1(__VLS_469, new __VLS_469({
                size: "small",
            }));
            const __VLS_471 = __VLS_470({
                size: "small",
            }, ...__VLS_functionalComponentArgsRest(__VLS_470));
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
            (__VLS_ctx.t('platform.qrFetching'));
        }
        if (__VLS_ctx.wxQrStatus === 'waiting' || __VLS_ctx.wxQrStatus === 'scaned') {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "weixin-qr-hint" },
            });
            /** @type {__VLS_StyleScopedClasses['weixin-qr-hint']} */ ;
            (__VLS_ctx.wxQrStatus === 'scaned' ? __VLS_ctx.t('platform.qrScanedHint') : __VLS_ctx.t('platform.qrScanHint'));
        }
        const __VLS_474 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_475 = __VLS_asFunctionalComponent1(__VLS_474, new __VLS_474({
            label: (__VLS_ctx.t('platform.weixinToken')),
            hint: (__VLS_ctx.t('platform.weixinTokenHint')),
        }));
        const __VLS_476 = __VLS_475({
            label: (__VLS_ctx.t('platform.weixinToken')),
            hint: (__VLS_ctx.t('platform.weixinTokenHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_475));
        const { default: __VLS_479 } = __VLS_477.slots;
        let __VLS_480;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_481 = __VLS_asFunctionalComponent1(__VLS_480, new __VLS_480({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('weixin').token || ''),
            loading: (__VLS_ctx.isSaving('weixin', 'token')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "Token",
        }));
        const __VLS_482 = __VLS_481({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('weixin').token || ''),
            loading: (__VLS_ctx.isSaving('weixin', 'token')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "Token",
        }, ...__VLS_functionalComponentArgsRest(__VLS_481));
        let __VLS_485;
        const __VLS_486 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveCredentials('weixin', 'token', { token: v })) });
        /** @type {__VLS_StyleScopedClasses['input-lg']} */ ;
        var __VLS_483;
        var __VLS_484;
        // @ts-ignore
        [getCreds, t, t, t, t, t, isSaving, saveCredentials, wxQrStatus, wxQrStatus, wxQrStatus, wxQrStatus,];
        var __VLS_477;
        const __VLS_487 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_488 = __VLS_asFunctionalComponent1(__VLS_487, new __VLS_487({
            label: (__VLS_ctx.t('platform.accountId')),
            hint: (__VLS_ctx.t('platform.accountIdHint')),
        }));
        const __VLS_489 = __VLS_488({
            label: (__VLS_ctx.t('platform.accountId')),
            hint: (__VLS_ctx.t('platform.accountIdHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_488));
        const { default: __VLS_492 } = __VLS_490.slots;
        let __VLS_493;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_494 = __VLS_asFunctionalComponent1(__VLS_493, new __VLS_493({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('weixin').extra?.account_id || ''),
            loading: (__VLS_ctx.isSaving('weixin', 'account_id')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "Account ID",
        }));
        const __VLS_495 = __VLS_494({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('weixin').extra?.account_id || ''),
            loading: (__VLS_ctx.isSaving('weixin', 'account_id')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "Account ID",
        }, ...__VLS_functionalComponentArgsRest(__VLS_494));
        let __VLS_498;
        const __VLS_499 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveCredentials('weixin', 'account_id', { extra: { ...__VLS_ctx.getCreds('weixin').extra, account_id: v } })) });
        /** @type {__VLS_StyleScopedClasses['input-lg']} */ ;
        var __VLS_496;
        var __VLS_497;
        // @ts-ignore
        [getCreds, getCreds, t, t, isSaving, saveCredentials,];
        var __VLS_490;
    }
    if (p.key === 'wecom') {
        const __VLS_500 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_501 = __VLS_asFunctionalComponent1(__VLS_500, new __VLS_500({
            label: (__VLS_ctx.t('platform.botId')),
            hint: (__VLS_ctx.t('platform.botIdHint')),
        }));
        const __VLS_502 = __VLS_501({
            label: (__VLS_ctx.t('platform.botId')),
            hint: (__VLS_ctx.t('platform.botIdHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_501));
        const { default: __VLS_505 } = __VLS_503.slots;
        let __VLS_506;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_507 = __VLS_asFunctionalComponent1(__VLS_506, new __VLS_506({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('wecom').extra?.bot_id || ''),
            loading: (__VLS_ctx.isSaving('wecom', 'bot_id')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "Bot ID",
        }));
        const __VLS_508 = __VLS_507({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('wecom').extra?.bot_id || ''),
            loading: (__VLS_ctx.isSaving('wecom', 'bot_id')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "Bot ID",
        }, ...__VLS_functionalComponentArgsRest(__VLS_507));
        let __VLS_511;
        const __VLS_512 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveCredentials('wecom', 'bot_id', { extra: { ...__VLS_ctx.getCreds('wecom').extra, bot_id: v } })) });
        /** @type {__VLS_StyleScopedClasses['input-lg']} */ ;
        var __VLS_509;
        var __VLS_510;
        // @ts-ignore
        [getCreds, getCreds, t, t, isSaving, saveCredentials,];
        var __VLS_503;
        const __VLS_513 = SettingRow || SettingRow;
        // @ts-ignore
        const __VLS_514 = __VLS_asFunctionalComponent1(__VLS_513, new __VLS_513({
            label: (__VLS_ctx.t('platform.appSecret')),
            hint: (__VLS_ctx.t('platform.wecomSecretHint')),
        }));
        const __VLS_515 = __VLS_514({
            label: (__VLS_ctx.t('platform.appSecret')),
            hint: (__VLS_ctx.t('platform.wecomSecretHint')),
        }, ...__VLS_functionalComponentArgsRest(__VLS_514));
        const { default: __VLS_518 } = __VLS_516.slots;
        let __VLS_519;
        /** @ts-ignore @type {typeof __VLS_components.NInput} */
        NInput;
        // @ts-ignore
        const __VLS_520 = __VLS_asFunctionalComponent1(__VLS_519, new __VLS_519({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('wecom').extra?.secret || ''),
            loading: (__VLS_ctx.isSaving('wecom', 'secret')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "Secret",
        }));
        const __VLS_521 = __VLS_520({
            ...{ 'onChange': {} },
            defaultValue: (__VLS_ctx.getCreds('wecom').extra?.secret || ''),
            loading: (__VLS_ctx.isSaving('wecom', 'secret')),
            clearable: true,
            size: "small",
            ...{ class: "input-lg" },
            placeholder: "Secret",
        }, ...__VLS_functionalComponentArgsRest(__VLS_520));
        let __VLS_524;
        const __VLS_525 = ({ change: {} },
            { onChange: (v => __VLS_ctx.saveCredentials('wecom', 'secret', { extra: { ...__VLS_ctx.getCreds('wecom').extra, secret: v } })) });
        /** @type {__VLS_StyleScopedClasses['input-lg']} */ ;
        var __VLS_522;
        var __VLS_523;
        // @ts-ignore
        [getCreds, getCreds, t, t, isSaving, saveCredentials,];
        var __VLS_516;
    }
    // @ts-ignore
    [];
    var __VLS_3;
    // @ts-ignore
    [];
}
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
