/// <reference types="../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { setApiKey, hasApiKey } from "@/api/client";
const { t } = useI18n();
const router = useRouter();
// Read token saved by main.ts (before router strips URL params)
const urlToken = window.__LOGIN_TOKEN__ || "";
const token = ref(urlToken);
const loading = ref(false);
const errorMsg = ref("");
// If already has a key, try to go to main page
if (hasApiKey()) {
    router.replace("/hermes/chat");
}
async function handleLogin() {
    const key = token.value.trim();
    if (!key) {
        errorMsg.value = t("login.tokenRequired");
        return;
    }
    loading.value = true;
    errorMsg.value = "";
    try {
        // Validate token by calling an auth-required endpoint
        const res = await fetch("/api/sessions", {
            headers: { Authorization: `Bearer ${key}` },
        });
        if (res.status === 401) {
            errorMsg.value = t("login.invalidToken");
            loading.value = false;
            return;
        }
        setApiKey(key);
        router.replace("/hermes/chat");
    }
    catch {
        errorMsg.value = t("login.connectionFailed");
    }
    finally {
        loading.value = false;
    }
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "login-view" },
});
/** @type {__VLS_StyleScopedClasses['login-view']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "login-card" },
});
/** @type {__VLS_StyleScopedClasses['login-card']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "login-logo" },
});
/** @type {__VLS_StyleScopedClasses['login-logo']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.img)({
    src: "/logo.png",
    alt: "Hermes",
    width: "80",
    height: "80",
});
__VLS_asFunctionalElement1(__VLS_intrinsics.h1, __VLS_intrinsics.h1)({
    ...{ class: "login-title" },
});
/** @type {__VLS_StyleScopedClasses['login-title']} */ ;
(__VLS_ctx.t('login.title'));
__VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
    ...{ class: "login-desc" },
});
/** @type {__VLS_StyleScopedClasses['login-desc']} */ ;
(__VLS_ctx.t("login.description"));
__VLS_asFunctionalElement1(__VLS_intrinsics.form, __VLS_intrinsics.form)({
    ...{ onSubmit: (__VLS_ctx.handleLogin) },
    ...{ class: "login-form" },
});
/** @type {__VLS_StyleScopedClasses['login-form']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    type: "password",
    ...{ class: "login-input" },
    placeholder: (__VLS_ctx.t('login.placeholder')),
    autofocus: true,
});
(__VLS_ctx.token);
/** @type {__VLS_StyleScopedClasses['login-input']} */ ;
if (__VLS_ctx.errorMsg) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "login-error" },
    });
    /** @type {__VLS_StyleScopedClasses['login-error']} */ ;
    (__VLS_ctx.errorMsg);
}
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    type: "submit",
    ...{ class: "login-btn" },
    disabled: (__VLS_ctx.loading),
});
/** @type {__VLS_StyleScopedClasses['login-btn']} */ ;
(__VLS_ctx.loading ? "..." : __VLS_ctx.t("login.submit"));
// @ts-ignore
[t, t, t, t, handleLogin, token, errorMsg, errorMsg, loading, loading,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
