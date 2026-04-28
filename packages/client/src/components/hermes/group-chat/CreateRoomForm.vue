<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { NInput, NButton, NSpace, NInputNumber, NCollapse, NCollapseItem } from 'naive-ui'

type InputLikeInstance = {
    focus: () => void
}

const { t } = useI18n()
const emit = defineEmits<{
    submit: [name: string, inviteCode: string, userName: string, description: string, compression: { triggerTokens: number; maxHistoryTokens: number; tailMessageCount: number }]
    cancel: []
}>()

const roomName = ref('')
const inviteCode = ref('')
const userName = ref('')
const description = ref('')
const roomInput = ref<InputLikeInstance | null>(null)

const compression = ref({
    triggerTokens: 100000,
    maxHistoryTokens: 32000,
    tailMessageCount: 20,
})

function generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let code = ''
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)]
    }
    return code
}

function handleCreate() {
    const name = roomName.value.trim()
    const code = inviteCode.value.trim() || generateCode()
    const user = userName.value.trim()
    if (!name || !user) return
    emit('submit', name, code, user, description.value.trim(), { ...compression.value })
}

function focusRoomInput() {
    nextTick(() => roomInput.value?.focus())
}
</script>

<template>
    <div class="create-form">
        <div class="form-group">
            <label class="form-label">{{ t('groupChat.yourName') }}</label>
            <NInput
                v-model:value="userName"
                :placeholder="t('groupChat.yourNamePlaceholder')"
                @keyup.enter="focusRoomInput"
            />
        </div>
        <div class="form-group">
            <label class="form-label">{{ t('groupChat.yourDescription') }}</label>
            <NInput
                v-model:value="description"
                type="textarea"
                :rows="2"
                :placeholder="t('groupChat.yourDescriptionPlaceholder')"
            />
        </div>
        <div class="form-group">
            <label class="form-label">{{ t('groupChat.roomName') }}</label>
            <NInput
                ref="roomInput"
                v-model:value="roomName"
                :placeholder="t('groupChat.roomNamePlaceholder')"
                @keyup.enter="handleCreate"
            />
        </div>
        <div class="form-group">
            <label class="form-label">{{ t('groupChat.inviteCode') }}</label>
            <div class="code-row">
                <NInput
                    v-model:value="inviteCode"
                    :placeholder="t('groupChat.autoGenerate')"
                />
                <NButton size="small" @click="inviteCode = generateCode()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                </NButton>
            </div>
        </div>

        <NCollapse class="compression-collapse">
            <NCollapseItem :title="t('groupChat.compressionSettings')" name="compression">
                <div class="compression-fields">
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.triggerTokens') }}</label>
                        <NInputNumber v-model:value="compression.triggerTokens" :min="1000" :step="1000" style="width: 100%" />
                        <p class="form-hint">{{ t('groupChat.triggerTokensDesc') }}</p>
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.maxHistoryTokens') }}</label>
                        <NInputNumber v-model:value="compression.maxHistoryTokens" :min="1000" :step="1000" style="width: 100%" />
                        <p class="form-hint">{{ t('groupChat.maxHistoryTokensDesc') }}</p>
                    </div>
                    <div class="form-group">
                        <label class="form-label">{{ t('groupChat.tailMessageCount') }}</label>
                        <NInputNumber v-model:value="compression.tailMessageCount" :min="1" :step="5" style="width: 100%" />
                        <p class="form-hint">{{ t('groupChat.tailMessageCountDesc') }}</p>
                    </div>
                </div>
            </NCollapseItem>
        </NCollapse>

        <div class="modal-actions">
            <NSpace justify="end">
                <NButton @click="emit('cancel')">{{ t('common.cancel') }}</NButton>
                <NButton type="primary" :disabled="!roomName.trim() || !userName.trim()" @click="handleCreate">{{ t('common.create') }}</NButton>
            </NSpace>
        </div>
    </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.create-form {
    .form-group {
        margin-bottom: 16px;
    }
}

.form-label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: $text-secondary;
    margin-bottom: 6px;
}

.form-hint {
    font-size: 11px;
    color: $text-muted;
    margin: 4px 0 0;
}

.code-row {
    display: flex;
    gap: 8px;
    align-items: center;
}

.compression-collapse {
    margin-bottom: 16px;
}

.compression-fields {
    padding-top: 8px;
}
</style>
