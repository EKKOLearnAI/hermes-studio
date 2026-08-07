<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NInput } from 'naive-ui'
import GroupChatPanel from '@/components/hermes/group-chat/GroupChatPanel.vue'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import { getStoredUserId } from '@/api/hermes/group-chat'
import type { ProfileAvatar as ProfileAvatarData } from '@/api/hermes/profiles'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { parseStoredAvatar } from '@/utils/group-agent-avatar'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useGroupChatStore()

const inviteCodeDraft = ref('')
const guestNameDraft = ref(localStorage.getItem('gc_user_name')?.trim() || '')
const guestAvatarFileInput = ref<HTMLInputElement | null>(null)
const guestAvatarError = ref('')
const defaultGuestAvatar = (): ProfileAvatarData => ({
    type: 'generated',
    seed: `guest-${getStoredUserId()}`,
})
const guestAvatarDraft = ref<ProfileAvatarData>(
    parseStoredAvatar(localStorage.getItem('gc_user_avatar')) || defaultGuestAvatar(),
)
const joinedInviteCode = ref('')
const joining = ref(false)
const joinError = ref<'' | 'invite' | 'name-conflict' | 'name-reserved'>('')
let joinGeneration = 0

const routeInviteCode = computed(() => {
    const value = route.params.inviteCode
    return typeof value === 'string' ? value.trim() : ''
})
const joined = computed(() => !!joinedInviteCode.value && !!store.currentRoomId)
const collectingGuestName = computed(() => !!routeInviteCode.value && joinError.value !== 'invite')

async function joinInvite(code: string): Promise<void> {
    const normalizedCode = code.trim()
    if (!normalizedCode || joining.value) return

    const generation = ++joinGeneration
    joining.value = true
    joinError.value = ''
    joinedInviteCode.value = ''
    store.disconnect()

    try {
        await store.joinByCode(normalizedCode, { guest: true })
        if (generation !== joinGeneration) return
        joinedInviteCode.value = normalizedCode
    } catch (err: any) {
        if (generation !== joinGeneration) return
        store.disconnect()
        if (err?.code === 'ROOM_PARTICIPANT_NAME_CONFLICT') joinError.value = 'name-conflict'
        else if (err?.code === 'ROOM_PARTICIPANT_NAME_RESERVED') joinError.value = 'name-reserved'
        else joinError.value = 'invite'
    } finally {
        if (generation === joinGeneration) joining.value = false
    }
}

async function submitInvite(): Promise<void> {
    const code = inviteCodeDraft.value.trim()
    if (!code) return
    if (routeInviteCode.value === code) {
        joinError.value = ''
        return
    }
    await router.replace({ name: 'share.groupChat', params: { inviteCode: code } })
}

async function submitGuestName(): Promise<void> {
    const name = guestNameDraft.value.trim()
    if (!name || !routeInviteCode.value) return
    store.setUserInfo(
        name,
        localStorage.getItem('gc_user_description') || '',
        JSON.stringify(guestAvatarDraft.value),
    )
    await joinInvite(routeInviteCode.value)
}

function randomizeGuestAvatar(): void {
    const randomPart = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2)
    guestAvatarDraft.value = { type: 'generated', seed: `guest-${randomPart}` }
    guestAvatarError.value = ''
}

function resetGuestAvatar(): void {
    guestAvatarDraft.value = defaultGuestAvatar()
    guestAvatarError.value = ''
}

async function handleGuestAvatarFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        guestAvatarError.value = t('profiles.avatar.invalidType')
        return
    }
    if (file.size > 1024 * 1024) {
        guestAvatarError.value = t('profiles.avatar.tooLarge')
        return
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error || new Error('Failed to read avatar'))
        reader.readAsDataURL(file)
    })
    guestAvatarDraft.value = { type: 'image', dataUrl }
    guestAvatarError.value = ''
}

watch(routeInviteCode, (code) => {
    inviteCodeDraft.value = code
    joinGeneration += 1
    store.disconnect()
    joinedInviteCode.value = ''
    joinError.value = ''
    joining.value = false
}, { immediate: true })

onUnmounted(() => {
    joinGeneration += 1
    store.disconnect()
})
</script>

<template>
    <div class="shared-group-chat-view">
        <GroupChatPanel v-if="joined" standalone />

        <main
            v-else-if="joining"
            class="invite-loading"
            :aria-label="t('groupChat.shareJoining')"
            aria-busy="true"
        >
            <span class="invite-loading-spinner" aria-hidden="true" />
        </main>

        <main v-else class="invite-gate">
            <section class="invite-card" aria-labelledby="shared-group-chat-title">
                <img class="invite-logo" src="/logo.png" alt="" />
                <div class="invite-heading">
                    <p class="invite-kicker">{{ t('groupChat.title') }}</p>
                    <h1 id="shared-group-chat-title">{{ t('groupChat.shareTitle') }}</h1>
                    <p>
                        {{ collectingGuestName ? t('groupChat.shareNameSubtitle') : t('groupChat.shareSubtitle') }}
                    </p>
                </div>

                <form v-if="collectingGuestName" class="invite-form" @submit.prevent="submitGuestName">
                    <div class="guest-avatar-editor">
                        <ProfileAvatar
                            :name="guestNameDraft || 'guest'"
                            :avatar="guestAvatarDraft"
                            :size="72"
                        />
                        <div class="guest-avatar-controls">
                            <span class="guest-avatar-label">{{ t('profiles.avatar.customize') }}</span>
                            <div class="guest-avatar-actions">
                                <NButton size="small" attr-type="button" @click="guestAvatarFileInput?.click()">
                                    {{ t('profiles.avatar.upload') }}
                                </NButton>
                                <NButton size="small" attr-type="button" @click="randomizeGuestAvatar">
                                    {{ t('profiles.avatar.random') }}
                                </NButton>
                                <NButton size="small" attr-type="button" @click="resetGuestAvatar">
                                    {{ t('profiles.avatar.reset') }}
                                </NButton>
                            </div>
                            <span class="guest-avatar-hint">{{ t('profiles.avatar.hint') }}</span>
                        </div>
                        <input
                            ref="guestAvatarFileInput"
                            class="guest-avatar-file"
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            @change="handleGuestAvatarFile"
                        >
                    </div>
                    <p v-if="guestAvatarError" class="invite-error" role="alert">
                        {{ guestAvatarError }}
                    </p>
                    <label for="group-chat-guest-name">{{ t('groupChat.yourName') }}</label>
                    <NInput
                        id="group-chat-guest-name"
                        v-model:value="guestNameDraft"
                        size="large"
                        :disabled="joining"
                        :placeholder="t('groupChat.yourName')"
                        autocomplete="name"
                        autofocus
                        clearable
                        :maxlength="120"
                    />
                    <p v-if="joinError === 'name-conflict'" class="invite-error" role="alert">
                        {{ t('groupChat.shareNameConflict') }}
                    </p>
                    <p v-else-if="joinError === 'name-reserved'" class="invite-error" role="alert">
                        {{ t('groupChat.shareNameReserved') }}
                    </p>
                    <NButton
                        attr-type="submit"
                        type="primary"
                        size="large"
                        block
                        :loading="joining"
                        :disabled="!guestNameDraft.trim()"
                    >
                        {{ t('groupChat.shareEnterRoom') }}
                    </NButton>
                </form>

                <form v-else class="invite-form" @submit.prevent="submitInvite">
                    <label for="group-chat-invite-code">{{ t('groupChat.inviteCode') }}</label>
                    <NInput
                        id="group-chat-invite-code"
                        v-model:value="inviteCodeDraft"
                        size="large"
                        :disabled="joining"
                        :placeholder="t('groupChat.inviteCodePlaceholder')"
                        autocomplete="one-time-code"
                        autofocus
                        clearable
                    />
                    <p v-if="joinError === 'invite'" class="invite-error" role="alert">
                        {{ t('groupChat.shareInvalidCode') }}
                    </p>
                    <NButton
                        attr-type="submit"
                        type="primary"
                        size="large"
                        block
                        :loading="joining"
                        :disabled="!inviteCodeDraft.trim()"
                    >
                        {{ joining ? t('groupChat.shareJoining') : t('groupChat.joinByCode') }}
                    </NButton>
                </form>

                <p class="invite-hint">{{ t('groupChat.shareCodeHint') }}</p>
            </section>
        </main>
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.shared-group-chat-view {
    width: 100%;
    height: calc(100 * var(--vh));
    min-height: 0;
}

.invite-loading {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    background: $bg-main-surface;
}

.invite-loading-spinner {
    width: 24px;
    height: 24px;
    box-sizing: border-box;
    border: 2px solid $border-color;
    border-top-color: var(--accent-primary);
    border-radius: 50%;
    opacity: 0;
    animation:
        invite-loading-reveal 0s linear 200ms forwards,
        invite-loading-spin 0.7s linear infinite;
}

.invite-gate {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
    overflow-y: auto;
    background:
        radial-gradient(circle at 15% 15%, rgba(var(--accent-primary-rgb), 0.16), transparent 34%),
        radial-gradient(circle at 85% 80%, rgba(var(--accent-primary-rgb), 0.1), transparent 30%),
        $bg-primary;
}

.invite-card {
    box-sizing: border-box;
    width: min(100%, 430px);
    padding: 38px;
    border: 1px solid $border-color;
    border-radius: 24px;
    background: $bg-main-surface;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.14);
}

.invite-logo {
    display: block;
    width: 52px;
    height: 52px;
    margin-bottom: 24px;
    border-radius: 14px;
}

.invite-heading {
    margin-bottom: 28px;

    h1 {
        margin: 5px 0 10px;
        color: $text-primary;
        font-size: clamp(26px, 5vw, 34px);
        line-height: 1.15;
        letter-spacing: -0.025em;
    }

    p {
        margin: 0;
        color: $text-secondary;
        font-size: 14px;
        line-height: 1.65;
    }

    .invite-kicker {
        color: var(--accent-primary);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
    }
}

.invite-form {
    display: grid;
    gap: 12px;

    label {
        color: $text-secondary;
        font-size: 13px;
        font-weight: 600;
    }
}

.guest-avatar-editor {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 4px;
}

.guest-avatar-controls {
    display: grid;
    min-width: 0;
    gap: 7px;
}

.guest-avatar-label {
    color: $text-primary;
    font-size: 13px;
    font-weight: 600;
}

.guest-avatar-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.guest-avatar-hint {
    color: $text-muted;
    font-size: 11px;
}

.guest-avatar-file {
    display: none;
}

.invite-error {
    margin: 0;
    color: $error;
    font-size: 13px;
    line-height: 1.5;
}

.invite-hint {
    margin: 18px 0 0;
    color: $text-muted;
    font-size: 12px;
    line-height: 1.55;
    text-align: center;
}

@keyframes invite-loading-reveal {
    to {
        opacity: 1;
    }
}

@keyframes invite-loading-spin {
    to {
        transform: rotate(360deg);
    }
}

@media (max-width: 520px) {
    .invite-gate {
        padding: 16px;
    }

    .invite-card {
        padding: 28px 22px;
        border-radius: 20px;
    }

    .guest-avatar-editor {
        align-items: flex-start;
    }
}
</style>
