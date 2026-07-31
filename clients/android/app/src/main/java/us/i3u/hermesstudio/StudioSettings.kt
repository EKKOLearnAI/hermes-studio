package us.i3u.hermesstudio

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.RestartAlt
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.WbSunny
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

@Composable
internal fun AccountStudioSettings(state: UiState, viewModel: AppViewModel) {
    var passwordDialog by remember { mutableStateOf(false) }
    var usernameDialog by remember { mutableStateOf(false) }
    var confirmUnlockAll by remember { mutableStateOf(false) }
    val pickAvatar = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        val context = viewModel.getApplication<android.app.Application>()
        val mime = context.contentResolver.getType(uri) ?: "image/jpeg"
        val bytes = runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
        if (bytes != null && bytes.isNotEmpty()) viewModel.setAccountAvatar(bytes, mime)
    }

    if (passwordDialog) {
        ChangePasswordDialog(
            onDismiss = { passwordDialog = false },
            onSave = { current, next -> viewModel.changeAccountPassword(current, next) },
        )
    }
    if (usernameDialog) {
        ChangeUsernameDialog(
            currentUsername = state.account.orEmpty(),
            onDismiss = { usernameDialog = false },
            onSave = { current, next -> viewModel.changeAccountUsername(current, next) },
        )
    }
    if (confirmUnlockAll) {
        ConfirmDialog(
            title = stringResource(R.string.account_unlock_all),
            body = stringResource(R.string.account_unlock_all_confirm),
            action = stringResource(R.string.account_unlock_all),
            onConfirm = { viewModel.unlockAllIps() },
            onDismiss = { confirmUnlockAll = false },
        )
    }

    SettingsSection(stringResource(R.string.account_security_title))
    SettingsRow(
        icon = Icons.Filled.Edit,
        label = stringResource(R.string.account_change_username),
        value = stringResource(R.string.account_change_username_note),
        onClick = { usernameDialog = true },
    )
    SettingsRow(
        icon = Icons.Filled.Check,
        label = stringResource(R.string.account_change_password),
        value = stringResource(R.string.account_change_password_note),
        onClick = { passwordDialog = true },
    )

    SettingsSection(stringResource(R.string.account_avatar_title))
    SettingsRow(
        icon = Icons.Filled.Image,
        label = stringResource(R.string.account_avatar_upload),
        value = stringResource(R.string.account_avatar_note),
        onClick = { pickAvatar.launch("image/*") },
        trailing = {
            ProfileAvatar(
                name = "account-${state.currentUser?.id ?: state.account.orEmpty()}",
                spec = state.accountAvatar,
                size = 42.dp,
            )
        },
    )
    SettingsRow(
        icon = Icons.Filled.Refresh,
        label = stringResource(R.string.account_avatar_random),
        value = stringResource(R.string.account_avatar_random_note),
        onClick = { viewModel.randomizeAccountAvatar() },
    )
    SettingsRow(
        icon = Icons.Filled.Refresh,
        label = stringResource(R.string.account_avatar_reset),
        value = stringResource(R.string.account_avatar_reset_note),
        onClick = { viewModel.resetAccountAvatar() },
    )

    SettingsSection(stringResource(R.string.account_locked_ips))
    if (state.lockedIps.isEmpty()) {
        SettingsRow(
            icon = Icons.Filled.Check,
            label = stringResource(R.string.account_no_locked_ips),
            value = stringResource(R.string.account_no_locked_ips_note),
        )
    } else {
        state.lockedIps.forEach { lock ->
            val remainingMinutes = ((lock.lockedUntil - System.currentTimeMillis()).coerceAtLeast(0) / 60_000)
            val typeLabel = stringResource(
                when (lock.type) {
                    "token" -> R.string.account_lock_token
                    "pairing" -> R.string.account_lock_pairing
                    else -> R.string.account_lock_password
                },
            )
            SettingsRow(
                icon = Icons.Filled.Dns,
                label = lock.ip,
                value = stringResource(
                    R.string.account_locked_ip_detail,
                    typeLabel,
                    lock.failures,
                    remainingMinutes,
                ),
                onClick = { viewModel.unlockIp(lock.ip) },
            )
        }
        SettingsRow(
            icon = Icons.Filled.Delete,
            label = stringResource(R.string.account_unlock_all),
            value = stringResource(R.string.account_unlock_all_note, state.lockedIps.size),
            onClick = { confirmUnlockAll = true },
        )
    }
}

@Composable
private fun ChangePasswordDialog(onDismiss: () -> Unit, onSave: (String, String) -> Unit) {
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    val valid = current.isNotBlank() && next.length >= 6 && next == confirm
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.account_change_password)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                PasswordField(current, { current = it }, R.string.account_current_password)
                PasswordField(next, { next = it }, R.string.account_new_password)
                PasswordField(confirm, { confirm = it }, R.string.account_confirm_password)
                if (confirm.isNotBlank() && next != confirm) {
                    Text(stringResource(R.string.account_password_mismatch), color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = valid,
                onClick = { onDismiss(); onSave(current, next) },
            ) { Text(stringResource(R.string.action_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

@Composable
private fun ChangeUsernameDialog(
    currentUsername: String,
    onDismiss: () -> Unit,
    onSave: (String, String) -> Unit,
) {
    var currentPassword by remember { mutableStateOf("") }
    var username by remember { mutableStateOf(currentUsername) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.account_change_username)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                PasswordField(currentPassword, { currentPassword = it }, R.string.account_current_password)
                OutlinedTextField(
                    value = username,
                    onValueChange = { username = it },
                    label = { Text(stringResource(R.string.account_new_username)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = currentPassword.isNotBlank() && username.trim().length >= 2,
                onClick = { onDismiss(); onSave(currentPassword, username.trim()) },
            ) { Text(stringResource(R.string.action_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

@Composable
private fun PasswordField(value: String, onValueChange: (String) -> Unit, label: Int) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(stringResource(label)) },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        modifier = Modifier.fillMaxWidth(),
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ManagedUsersSettings(state: UiState, viewModel: AppViewModel) {
    var editing by remember { mutableStateOf<ManagedUser?>(null) }
    var creating by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<ManagedUser?>(null) }

    if (creating || editing != null) {
        ManagedUserDialog(
            user = editing,
            profiles = state.managedProfiles,
            onDismiss = { creating = false; editing = null },
            onSave = { draft ->
                viewModel.saveManagedUser(editing?.id, draft)
                creating = false
                editing = null
            },
        )
    }
    deleting?.let { user ->
        ConfirmDialog(
            title = stringResource(R.string.users_delete_title, user.username),
            body = stringResource(R.string.users_delete_note),
            action = stringResource(R.string.action_delete),
            onConfirm = { viewModel.deleteManagedUser(user) },
            onDismiss = { deleting = null },
        )
    }

    Text(
        stringResource(R.string.users_description),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
    )
    Button(
        onClick = { creating = true },
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
    ) { Text(stringResource(R.string.users_create)) }

    state.managedUsers.forEach { user ->
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp),
        ) {
            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(user.username, style = MaterialTheme.typography.titleMedium)
                    Text(
                        stringResource(if (user.status == "active") R.string.users_active else R.string.users_disabled),
                        color = if (user.status == "active") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                    )
                }
                Text(
                    stringResource(
                        if (user.role == "super_admin") R.string.users_super_admin else R.string.users_admin,
                    ),
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(
                    if (user.role == "super_admin") stringResource(R.string.users_all_profiles)
                    else user.profiles.joinToString().ifBlank { stringResource(R.string.users_no_profiles) },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    if (user.lastLoginAt == null) {
                        stringResource(R.string.users_never_logged_in)
                    } else {
                        stringResource(
                            R.string.users_last_login,
                            android.text.format.DateFormat.format("yyyy-MM-dd HH:mm", user.lastLoginAt).toString(),
                        )
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AssistChip(onClick = { editing = user }, label = { Text(stringResource(R.string.action_edit)) })
                    AssistChip(onClick = { deleting = user }, label = { Text(stringResource(R.string.action_delete)) })
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ManagedUserDialog(
    user: ManagedUser?,
    profiles: List<String>,
    onDismiss: () -> Unit,
    onSave: (ManagedUserDraft) -> Unit,
) {
    var username by remember(user?.id) { mutableStateOf(user?.username.orEmpty()) }
    var password by remember(user?.id) { mutableStateOf("") }
    var role by remember(user?.id) { mutableStateOf(user?.role ?: "admin") }
    var status by remember(user?.id) { mutableStateOf(user?.status ?: "active") }
    var selected by remember(user?.id) { mutableStateOf(user?.profiles.orEmpty()) }
    val valid = username.trim().length >= 2 && (user != null || password.length >= 6) && (password.isBlank() || password.length >= 6)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(if (user == null) R.string.users_create else R.string.users_edit)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = username,
                    onValueChange = { username = it },
                    label = { Text(stringResource(R.string.login_username)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                PasswordField(
                    password,
                    { password = it },
                    if (user == null) R.string.account_new_password else R.string.users_optional_password,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AssistChip(
                        onClick = { role = "admin" },
                        label = { Text(stringResource(R.string.users_admin)) },
                        leadingIcon = if (role == "admin") ({ Icon(Icons.Filled.Check, null, Modifier.size(16.dp)) }) else null,
                    )
                    AssistChip(
                        onClick = { role = "super_admin" },
                        label = { Text(stringResource(R.string.users_super_admin)) },
                        leadingIcon = if (role == "super_admin") ({ Icon(Icons.Filled.Check, null, Modifier.size(16.dp)) }) else null,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AssistChip(
                        onClick = { status = "active" },
                        label = { Text(stringResource(R.string.users_active)) },
                        leadingIcon = if (status == "active") ({ Icon(Icons.Filled.Check, null, Modifier.size(16.dp)) }) else null,
                    )
                    AssistChip(
                        onClick = { status = "disabled" },
                        label = { Text(stringResource(R.string.users_disabled)) },
                        leadingIcon = if (status == "disabled") ({ Icon(Icons.Filled.Check, null, Modifier.size(16.dp)) }) else null,
                    )
                }
                if (role == "admin") {
                    Text(stringResource(R.string.users_profiles), style = MaterialTheme.typography.labelMedium)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        profiles.forEach { profile ->
                            val chosen = profile in selected
                            AssistChip(
                                onClick = { selected = if (chosen) selected - profile else selected + profile },
                                label = { Text(profile) },
                                leadingIcon = if (chosen) ({ Icon(Icons.Filled.Check, null, Modifier.size(16.dp)) }) else null,
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = valid,
                onClick = {
                    onSave(
                        ManagedUserDraft(
                            username = username.trim(),
                            password = password,
                            role = role,
                            status = status,
                            profiles = if (role == "super_admin") emptyList() else selected,
                        ),
                    )
                },
            ) { Text(stringResource(R.string.action_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

@Composable
internal fun ModelProvidersSettings(state: UiState, viewModel: AppViewModel) {
    Text(
        stringResource(R.string.models_keys_description),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
    )
    if (state.modelProviders.isEmpty()) {
        SettingsRow(
            icon = Icons.Filled.WbSunny,
            label = stringResource(R.string.models_no_providers),
            value = stringResource(R.string.models_no_providers_note),
        )
    }
    state.modelProviders.forEach { provider ->
        var key by remember(provider.id) { mutableStateOf("") }
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp),
        ) {
            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(provider.label, style = MaterialTheme.typography.titleMedium)
                    Text(
                        stringResource(
                            when {
                                provider.configured -> R.string.models_key_configured
                                provider.builtin -> R.string.models_builtin
                                else -> R.string.models_custom
                            },
                        ),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
                if (provider.baseUrl.isNotBlank()) {
                    Text(provider.baseUrl, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(
                    stringResource(R.string.models_count, provider.modelCount),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = key,
                    onValueChange = { key = it },
                    label = { Text(stringResource(R.string.models_api_key)) },
                    placeholder = {
                        Text(
                            stringResource(
                                when {
                                    !provider.builtin && provider.configured -> R.string.models_clear_key
                                    provider.configured -> R.string.models_replace_key
                                    else -> R.string.models_enter_key
                                },
                            ),
                        )
                    },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = { viewModel.saveProviderKey(provider.id, key); key = "" },
                    enabled = (key.isNotBlank() || (!provider.builtin && provider.configured)) && !state.savingSetting,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(stringResource(R.string.action_save)) }
            }
        }
    }
}

@Composable
internal fun DisplayStudioSettings(state: UiState, viewModel: AppViewModel) {
    val display = state.studioSettings?.display ?: return
    StudioHint(R.string.display_studio_note)
    StudioToggle(R.string.display_streaming, R.string.display_streaming_note, display.streaming) {
        viewModel.setStudioValue("display", "streaming", it)
    }
    StudioToggle(R.string.display_compact, R.string.display_compact_note, display.compact) {
        viewModel.setStudioValue("display", "compact", it)
    }
    StudioToggle(R.string.display_reasoning, R.string.display_reasoning_note, display.showReasoning) {
        viewModel.setStudioValue("display", "show_reasoning", it)
    }
    StudioToggle(R.string.display_cost, R.string.display_cost_note, display.showCost) {
        viewModel.setStudioValue("display", "show_cost", it)
    }
    StudioToggle(R.string.display_inline_diffs, R.string.display_inline_diffs_note, display.inlineDiffs) {
        viewModel.setStudioValue("display", "inline_diffs", it)
    }
    StudioToggle(R.string.display_bell, R.string.display_bell_note, display.bellOnComplete) {
        viewModel.setStudioValue("display", "bell_on_complete", it)
    }
    StudioToggle(R.string.display_notify, R.string.display_notify_note, display.notifyOnComplete) {
        viewModel.setStudioValue("display", "notify_on_complete", it)
    }
    StudioNumber(
        R.string.display_input_height,
        R.string.display_input_height_note,
        display.chatInputHeight?.toDouble() ?: 96.0,
        48.0,
        400.0,
        false,
    ) { viewModel.setStudioValue("display", "chat_input_height", it.toInt()) }
}

@Composable
internal fun MemoryStudioSettings(state: UiState, viewModel: AppViewModel) {
    val memory = state.studioSettings?.memory ?: return
    StudioToggle(R.string.memory_enabled, R.string.memory_enabled_note, memory.enabled) {
        viewModel.setStudioValue("memory", "memory_enabled", it)
    }
    StudioToggle(R.string.memory_profile, R.string.memory_profile_note, memory.userProfileEnabled) {
        viewModel.setStudioValue("memory", "user_profile_enabled", it)
    }
    StudioNumber(R.string.memory_limit, R.string.memory_limit_note, memory.memoryCharLimit.toDouble(), 100.0, 10000.0, false) {
        viewModel.setStudioValue("memory", "memory_char_limit", it.toInt())
    }
    StudioNumber(R.string.memory_user_limit, R.string.memory_user_limit_note, memory.userCharLimit.toDouble(), 100.0, 10000.0, false) {
        viewModel.setStudioValue("memory", "user_char_limit", it.toInt())
    }
}

@Composable
internal fun CompressionStudioSettings(state: UiState, viewModel: AppViewModel) {
    val value = state.studioSettings?.compression ?: return
    StudioToggle(R.string.compression_enabled, R.string.compression_enabled_note, value.enabled) {
        viewModel.setStudioValue("compression", "enabled", it)
    }
    StudioNumber(R.string.compression_threshold, R.string.compression_threshold_note, value.threshold, 0.1, 0.95, true) {
        viewModel.setStudioValue("compression", "threshold", it)
    }
    StudioNumber(R.string.compression_target, R.string.compression_target_note, value.targetRatio, 0.05, 0.8, true) {
        viewModel.setStudioValue("compression", "target_ratio", it)
    }
    StudioNumber(R.string.compression_last, R.string.compression_last_note, value.protectLast.toDouble(), 0.0, 200.0, false) {
        viewModel.setStudioValue("compression", "protect_last_n", it.toInt())
    }
    StudioNumber(R.string.compression_first, R.string.compression_first_note, value.protectFirst.toDouble(), 0.0, 50.0, false) {
        viewModel.setStudioValue("compression", "protect_first_n", it.toInt())
    }
}

@Composable
internal fun SessionStudioSettings(state: UiState, viewModel: AppViewModel) {
    val studio = state.studioSettings ?: return
    val session = studio.session
    StudioToggle(R.string.session_require_approval, R.string.session_require_approval_note, session.approvalsMode == "manual") {
        viewModel.setStudioValue("approvals", "mode", if (it) "manual" else "off")
    }
    StudioToggle(R.string.session_memory_approval, R.string.session_memory_approval_note, studio.memory.writeApproval) {
        viewModel.setStudioValue("memory", "write_approval", it)
    }
    StudioToggle(R.string.session_skills_approval, R.string.session_skills_approval_note, session.skillsWriteApproval) {
        viewModel.setStudioValue("skills", "write_approval", it)
    }
    StudioChoice(
        R.string.session_reset_mode,
        R.string.session_reset_mode_note,
        session.resetMode,
        listOf(
            "both" to R.string.session_mode_both,
            "idle" to R.string.session_mode_idle,
            "daily" to R.string.session_mode_daily,
            "none" to R.string.session_mode_none,
        ),
    ) { viewModel.setStudioValue("session_reset", "mode", it) }
    StudioNumber(R.string.session_idle_minutes, R.string.session_idle_minutes_note, session.idleMinutes.toDouble(), 10.0, 10080.0, false) {
        viewModel.setStudioValue("session_reset", "idle_minutes", it.toInt())
    }
    StudioNumber(R.string.session_at_hour, R.string.session_at_hour_note, session.atHour.toDouble(), 0.0, 23.0, false) {
        viewModel.setStudioValue("session_reset", "at_hour", it.toInt())
    }
}

@Composable
internal fun PrivacyStudioSettings(state: UiState, viewModel: AppViewModel) {
    val privacy = state.studioSettings?.privacy ?: return
    StudioHint(R.string.privacy_description)
    StudioToggle(R.string.privacy_redact, R.string.privacy_redact_note, privacy.redactPii) {
        viewModel.setStudioValue("privacy", "redact_pii", it)
    }
}

@Composable
internal fun ProxyStudioSettings(state: UiState, viewModel: AppViewModel) {
    val proxy = state.studioSettings?.proxy ?: return
    var https by remember(proxy) { mutableStateOf(proxy.https) }
    var http by remember(proxy) { mutableStateOf(proxy.http) }
    var all by remember(proxy) { mutableStateOf(proxy.all) }
    var noProxy by remember(proxy) { mutableStateOf(proxy.noProxy) }
    StudioHint(R.string.proxy_description)
    ProxyField(https, { https = it }, R.string.proxy_https, "http://127.0.0.1:7890")
    ProxyField(http, { http = it }, R.string.proxy_http, "http://127.0.0.1:7890")
    ProxyField(all, { all = it }, R.string.proxy_all, "socks5://127.0.0.1:7890")
    ProxyField(noProxy, { noProxy = it }, R.string.proxy_none, "localhost,127.0.0.1,.local")
    Button(
        onClick = { viewModel.saveProxy(https, http, all, noProxy) },
        enabled = !state.savingSetting,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
    ) { Text(stringResource(R.string.proxy_save)) }
}

@Composable
private fun ProxyField(value: String, onValueChange: (String) -> Unit, label: Int, hint: String) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(stringResource(label)) },
        placeholder = { Text(hint) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp),
    )
}

@Composable
private fun StudioHint(text: Int) {
    Text(
        stringResource(text),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
    )
}

@Composable
private fun StudioToggle(label: Int, note: Int, checked: Boolean, onChange: (Boolean) -> Unit) {
    SettingsRow(
        icon = Icons.Filled.Settings,
        label = stringResource(label),
        value = stringResource(note),
        trailing = { Switch(checked = checked, onCheckedChange = onChange) },
    )
}

@Composable
private fun StudioNumber(
    label: Int,
    note: Int,
    current: Double,
    min: Double,
    max: Double,
    decimal: Boolean,
    onSave: (Double) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    if (open) {
        NumberSettingDialog(
            title = stringResource(label),
            current = current,
            min = min,
            max = max,
            decimal = decimal,
            onDismiss = { open = false },
            onSave = onSave,
        )
    }
    SettingsRow(
        icon = Icons.Filled.RestartAlt,
        label = stringResource(label),
        value = (if (decimal) current.toString() else current.toInt().toString()) + " · " + stringResource(note),
        onClick = { open = true },
    )
}

@Composable
private fun NumberSettingDialog(
    title: String,
    current: Double,
    min: Double,
    max: Double,
    decimal: Boolean,
    onDismiss: () -> Unit,
    onSave: (Double) -> Unit,
) {
    var typed by remember { mutableStateOf(if (decimal) current.toString() else current.toInt().toString()) }
    val parsed = typed.toDoubleOrNull()
    val valid = parsed != null && parsed in min..max
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = typed,
                    onValueChange = { typed = it },
                    keyboardOptions = KeyboardOptions(
                        keyboardType = if (decimal) KeyboardType.Decimal else KeyboardType.Number,
                    ),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                val rangeMin = if (decimal) min.toString() else min.toInt().toString()
                val rangeMax = if (decimal) max.toString() else max.toInt().toString()
                Text(stringResource(R.string.number_range, rangeMin, rangeMax), style = MaterialTheme.typography.labelSmall)
            }
        },
        confirmButton = {
            TextButton(
                enabled = valid,
                onClick = { onDismiss(); onSave(parsed!!) },
            ) { Text(stringResource(R.string.action_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

@Composable
private fun StudioChoice(
    label: Int,
    note: Int,
    selected: String,
    choices: List<Pair<String, Int>>,
    onSave: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    if (open) {
        AlertDialog(
            onDismissRequest = { open = false },
            title = { Text(stringResource(label)) },
            text = {
                Column {
                    choices.forEach { (value, text) ->
                        TextButton(
                            onClick = { open = false; onSave(value) },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            if (value == selected) Icon(Icons.Filled.Check, null, Modifier.size(18.dp))
                            Text(stringResource(text), modifier = Modifier.padding(horizontal = 8.dp))
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { open = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
    val selectedLabel = choices.firstOrNull { it.first == selected }?.second ?: choices.first().second
    SettingsRow(
        icon = Icons.Filled.Settings,
        label = stringResource(label),
        value = stringResource(selectedLabel) + " · " + stringResource(note),
        onClick = { open = true },
    )
}
