package us.i3u.hermesstudio

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.res.stringResource

private val SCHEDULE_PRESETS = listOf(
    "* * * * *" to R.string.cron_preset_every_minute,
    "*/5 * * * *" to R.string.cron_preset_every_five_minutes,
    "0 * * * *" to R.string.cron_preset_hourly,
    "0 0 * * *" to R.string.cron_preset_daily_midnight,
    "0 9 * * *" to R.string.cron_preset_daily_nine,
    "0 9 * * 1" to R.string.cron_preset_monday,
    "0 9 1 * *" to R.string.cron_preset_monthly,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CronJobsScreen(state: UiState, viewModel: AppViewModel) {
    Scaffold(
        topBar = {
            StudioTopBar(
                title = stringResource(R.string.cron_title),
                subtitle = state.activeProfile.ifBlank { "default" },
                onBack = { viewModel.back() },
                actions = {
                    IconButton(
                        onClick = { viewModel.refreshCronJobs() },
                        enabled = !state.cronLoading,
                    ) {
                        Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.action_refresh))
                    }
                    IconButton(onClick = { viewModel.openCronJob() }) {
                        Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.cron_create))
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            state.error?.let { message ->
                item { ErrorNote(message) { viewModel.dismissError() } }
            }
            state.notice?.let { message ->
                item { NoticeNote(message) { viewModel.dismissNotice() } }
            }
            if (state.cronLoading && state.cronJobs.isEmpty()) {
                item { LoadingRow() }
            }
            if (!state.cronLoading && state.cronJobs.isEmpty()) {
                item { CronEmptyState(onCreate = { viewModel.openCronJob() }) }
            }
            items(state.cronJobs, key = { it.id }) { job ->
                CronJobCard(
                    job = job,
                    pending = state.cronActionId == job.id,
                    actionsEnabled = state.cronActionId == null,
                    onToggle = { viewModel.toggleCronJob(job) },
                    onRun = { viewModel.runCronJob(job) },
                    onHistory = { viewModel.openCronHistory(job) },
                    onEdit = { viewModel.openCronJob(job.id) },
                    onDelete = { viewModel.deleteCronJob(job) },
                )
            }
            if (state.cronLoading && state.cronJobs.isNotEmpty()) {
                item { LoadingRow() }
            }
        }
    }
}

@Composable
private fun CronEmptyState(onCreate: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 56.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(
            stringResource(R.string.cron_empty),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )
        Button(onClick = onCreate) {
            Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.cron_create))
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CronJobCard(
    job: CronJob,
    pending: Boolean,
    actionsEnabled: Boolean,
    onToggle: () -> Unit,
    onRun: () -> Unit,
    onHistory: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    var confirmDelete by remember { mutableStateOf(false) }
    if (confirmDelete) {
        ConfirmDialog(
            title = stringResource(R.string.cron_delete_title, job.name),
            body = stringResource(R.string.cron_delete_body),
            action = stringResource(R.string.action_delete),
            onConfirm = onDelete,
            onDismiss = { confirmDelete = false },
        )
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.7f)),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        job.name,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        job.scheduleDisplay.ifBlank { job.scheduleInput },
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                CronStatusBadge(job)
            }

            val prompt = job.promptPreview ?: job.prompt
            if (prompt.isNotBlank()) {
                Text(
                    prompt,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            CronInfoRow(
                label = stringResource(R.string.cron_next_run),
                value = formatStamp(job.nextRunAt).ifBlank { stringResource(R.string.cron_not_available) },
            )
            CronInfoRow(
                label = stringResource(R.string.cron_last_run),
                value = buildString {
                    append(formatStamp(job.lastRunAt).ifBlank { stringResource(R.string.cron_never) })
                    job.lastStatus?.let { append(" · ").append(it) }
                },
            )
            CronInfoRow(
                label = stringResource(R.string.cron_delivery),
                value = job.deliver,
            )
            val repeatText = job.repeatLabel ?: job.repeatTimes?.let {
                stringResource(R.string.cron_repeat_progress, job.repeatCompleted, it)
            } ?: stringResource(R.string.cron_repeat_unlimited)
            CronInfoRow(label = stringResource(R.string.cron_repeat), value = repeatText)

            (job.lastError ?: job.lastDeliveryError)?.let { message ->
                Text(
                    message,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f))
            if (pending) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                    CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                }
            } else {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    TextButton(onClick = onToggle, enabled = actionsEnabled) {
                        Icon(
                            if (job.state == "paused" || !job.enabled) Icons.Filled.PlayArrow else Icons.Filled.Pause,
                            contentDescription = null,
                            modifier = Modifier.size(17.dp),
                        )
                        Spacer(Modifier.width(4.dp))
                        Text(
                            stringResource(
                                if (job.state == "paused" || !job.enabled) R.string.cron_resume else R.string.cron_pause,
                            ),
                        )
                    }
                    TextButton(onClick = onRun, enabled = actionsEnabled) {
                        Icon(Icons.Filled.PlayArrow, contentDescription = null, modifier = Modifier.size(17.dp))
                        Spacer(Modifier.width(4.dp))
                        Text(stringResource(R.string.cron_run_now))
                    }
                    TextButton(onClick = onHistory, enabled = actionsEnabled) {
                        Icon(Icons.Filled.History, contentDescription = null, modifier = Modifier.size(17.dp))
                        Spacer(Modifier.width(4.dp))
                        Text(stringResource(R.string.cron_history))
                    }
                    IconButton(onClick = onEdit, enabled = actionsEnabled) {
                        Icon(Icons.Filled.Edit, contentDescription = stringResource(R.string.cron_edit))
                    }
                    IconButton(onClick = { confirmDelete = true }, enabled = actionsEnabled) {
                        Icon(
                            Icons.Filled.Delete,
                            contentDescription = stringResource(R.string.action_delete),
                            tint = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CronStatusBadge(job: CronJob) {
    val running = job.state == "running"
    val paused = job.state == "paused" || !job.enabled
    val label = stringResource(
        when {
            running -> R.string.cron_status_running
            paused -> R.string.cron_status_paused
            else -> R.string.cron_status_scheduled
        },
    )
    val color = when {
        running -> MaterialTheme.colorScheme.primary
        paused -> Color(0xFFE6A85C)
        else -> Color(0xFF73C991)
    }
    Surface(color = color.copy(alpha = 0.14f), shape = RoundedCornerShape(999.dp)) {
        Text(
            label,
            color = color,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 4.dp),
        )
    }
}

@Composable
private fun CronInfoRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
        )
        Text(
            value,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.weight(2f),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun CronJobEditorScreen(state: UiState, viewModel: AppViewModel) {
    val editing = state.cronEditorJobId != null
    Scaffold(
        topBar = {
            StudioTopBar(
                title = stringResource(if (editing) R.string.cron_edit else R.string.cron_create),
                subtitle = state.activeProfile.ifBlank { "default" },
                onBack = { viewModel.back() },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .imePadding(),
        ) {
            if (state.cronEditorLoading || state.savingSetting) LoadingRow()
            state.error?.let { ErrorNote(it) { viewModel.dismissError() } }
            if (!state.cronEditorLoading && (!editing || state.editingCronJob != null)) {
                CronJobForm(state, viewModel)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun CronJobForm(state: UiState, viewModel: AppViewModel) {
    val job = state.editingCronJob
    var name by rememberSaveable(job?.id) { mutableStateOf(job?.name.orEmpty()) }
    var schedule by rememberSaveable(job?.id) { mutableStateOf(job?.scheduleInput.orEmpty()) }
    var prompt by rememberSaveable(job?.id) { mutableStateOf(job?.prompt.orEmpty()) }
    var repeat by rememberSaveable(job?.id) { mutableStateOf(job?.repeatTimes?.toString().orEmpty()) }
    var deliver by rememberSaveable(job?.id) { mutableStateOf(job?.deliver ?: "local") }
    var model by rememberSaveable(job?.id) { mutableStateOf(job?.model) }
    var provider by rememberSaveable(job?.id) { mutableStateOf(job?.provider) }
    var selectedSkills by remember(job?.id) { mutableStateOf(job?.skills.orEmpty().toSet()) }
    var showModels by remember { mutableStateOf(false) }
    var showDelivery by remember { mutableStateOf(false) }
    var showSkills by remember { mutableStateOf(false) }

    if (showModels) {
        ModalBottomSheet(
            onDismissRequest = { showModels = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        ) {
            ChoiceSheet(
                title = stringResource(R.string.cron_model),
                choices = listOf(
                    CronChoice("", stringResource(R.string.cron_server_default)),
                ) + state.models.map { CronChoice("${it.provider}\u0000${it.id}", it.id, it.provider) },
                selected = if (model.isNullOrBlank()) "" else "${provider.orEmpty()}\u0000${model.orEmpty()}",
                onSelect = { key ->
                    if (key.isBlank()) {
                        model = null
                        provider = null
                    } else {
                        provider = key.substringBefore('\u0000')
                        model = key.substringAfter('\u0000')
                    }
                    showModels = false
                },
            )
        }
    }
    if (showDelivery) {
        val choices = buildList<CronChoice> {
            add(CronChoice("local", stringResource(R.string.cron_delivery_local)))
            if (deliver == "origin") add(CronChoice("origin", stringResource(R.string.cron_delivery_origin)))
            state.cronDeliveryTargets.forEach { target ->
                add(
                    CronChoice(
                        target.value,
                        "${prettyPlatform(target.platform)} · ${target.name}",
                        target.type,
                    ),
                )
            }
            if (deliver.isNotBlank() && none { it.key == deliver }) add(CronChoice(deliver, deliver))
        }
        ModalBottomSheet(
            onDismissRequest = { showDelivery = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        ) {
            ChoiceSheet(
                title = stringResource(R.string.cron_delivery),
                choices = choices,
                selected = deliver,
                onSelect = {
                    deliver = it
                    showDelivery = false
                },
            )
        }
    }
    if (showSkills) {
        ModalBottomSheet(
            onDismissRequest = { showSkills = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        ) {
            SkillSheet(
                skills = state.cronSkills,
                selected = selectedSkills,
                onToggle = { skill ->
                    selectedSkills = if (skill in selectedSkills) selectedSkills - skill else selectedSkills + skill
                },
                onDone = { showSkills = false },
            )
        }
    }

    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            stringResource(R.string.cron_form_note),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = name,
            onValueChange = { name = it },
            label = { Text(stringResource(R.string.cron_name)) },
            placeholder = { Text(stringResource(R.string.cron_name_hint)) },
            singleLine = true,
            enabled = !state.savingSetting,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = schedule,
            onValueChange = { schedule = it },
            label = { Text(stringResource(R.string.cron_schedule)) },
            placeholder = { Text("0 9 * * *") },
            singleLine = true,
            enabled = !state.savingSetting,
            // Cron syntax is always left-to-right, even when the surrounding UI
            // is Arabic. Without this, "0 18 * * 4" is painted in reverse order.
            textStyle = MaterialTheme.typography.bodyLarge.copy(
                fontFamily = FontFamily.Monospace,
                textDirection = TextDirection.Ltr,
            ),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            stringResource(R.string.cron_quick_presets),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            SCHEDULE_PRESETS.forEach { (expression, label) ->
                AssistChip(
                    onClick = { schedule = expression },
                    label = { Text(stringResource(label)) },
                    leadingIcon = if (schedule == expression) {
                        { Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(16.dp)) }
                    } else {
                        null
                    },
                    enabled = !state.savingSetting,
                )
            }
        }
        OutlinedTextField(
            value = prompt,
            onValueChange = { prompt = it },
            label = { Text(stringResource(R.string.cron_prompt)) },
            placeholder = { Text(stringResource(R.string.cron_prompt_hint)) },
            minLines = 4,
            maxLines = 8,
            enabled = !state.savingSetting,
            modifier = Modifier.fillMaxWidth(),
        )

        CronPickerField(
            label = stringResource(R.string.cron_model),
            value = model ?: stringResource(R.string.cron_server_default),
            detail = provider,
            onClick = { showModels = true },
            enabled = !state.savingSetting,
        )
        CronPickerField(
            label = stringResource(R.string.cron_skills),
            value = if (selectedSkills.isEmpty()) {
                stringResource(R.string.cron_skills_none)
            } else {
                selectedSkills.sorted().joinToString()
            },
            onClick = { showSkills = true },
            enabled = !state.savingSetting,
        )
        val deliveryLabel = when (deliver) {
            "local" -> stringResource(R.string.cron_delivery_local)
            "origin" -> stringResource(R.string.cron_delivery_origin)
            else -> state.cronDeliveryTargets.firstOrNull { it.value == deliver }?.let {
                "${prettyPlatform(it.platform)} · ${it.name}"
            } ?: deliver
        }
        CronPickerField(
            label = stringResource(R.string.cron_delivery),
            value = deliveryLabel,
            onClick = { showDelivery = true },
            enabled = !state.savingSetting,
        )
        OutlinedTextField(
            value = repeat,
            onValueChange = { value -> repeat = value.filter(Char::isDigit) },
            label = { Text(stringResource(R.string.cron_repeat_count)) },
            placeholder = { Text(stringResource(R.string.cron_repeat_hint)) },
            singleLine = true,
            enabled = !state.savingSetting,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = {
                viewModel.saveCronJob(
                    CronJobDraft(
                        name = name.trim(),
                        schedule = schedule.trim(),
                        prompt = prompt.trim(),
                        deliver = deliver,
                        skills = selectedSkills.sorted(),
                        repeatTimes = repeat.toIntOrNull(),
                        model = model,
                        provider = provider,
                    ),
                )
            },
            enabled = !state.savingSetting,
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 20.dp),
        ) {
            Text(stringResource(if (job == null) R.string.action_create else R.string.action_save))
        }
    }
}

@Composable
private fun CronPickerField(
    label: String,
    value: String,
    detail: String? = null,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface,
            contentColor = if (enabled) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
            },
        ),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outline.copy(alpha = if (enabled) 1f else 0.38f),
        ),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(label, style = MaterialTheme.typography.labelSmall)
                Text(value, maxLines = 2, overflow = TextOverflow.Ellipsis)
                detail?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Text("›", fontSize = 22.sp)
        }
    }
}

private data class CronChoice(val key: String, val label: String, val detail: String? = null)

@Composable
private fun ChoiceSheet(
    title: String,
    choices: List<CronChoice>,
    selected: String,
    onSelect: (String) -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(bottom = 28.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(20.dp))
        if (choices.isEmpty()) {
            Text(
                stringResource(R.string.sheet_empty),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 24.dp),
            )
        }
        LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 520.dp)) {
            items(choices, key = { it.key }) { choice ->
                Row(
                    modifier = Modifier.fillMaxWidth().clickable { onSelect(choice.key) }.padding(20.dp, 13.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(choice.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        choice.detail?.let {
                            Text(
                                it,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    if (choice.key == selected) {
                        Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.action_selected))
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f))
            }
        }
    }
}

@Composable
private fun SkillSheet(
    skills: List<String>,
    selected: Set<String>,
    onToggle: (String) -> Unit,
    onDone: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(bottom = 28.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(stringResource(R.string.cron_skills), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            TextButton(onClick = onDone) { Text(stringResource(R.string.action_ok)) }
        }
        if (skills.isEmpty()) {
            Text(
                stringResource(R.string.cron_skills_empty),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 24.dp),
            )
        }
        LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 520.dp)) {
            items(skills, key = { it }) { skill ->
                Row(
                    modifier = Modifier.fillMaxWidth().clickable { onToggle(skill) }.padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(checked = skill in selected, onCheckedChange = { onToggle(skill) })
                    Text(skill, modifier = Modifier.weight(1f).padding(vertical = 14.dp))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CronHistoryScreen(state: UiState, viewModel: AppViewModel) {
    val job = state.cronHistoryJob ?: return
    state.openCronRun?.let { detail ->
        CronRunDialog(detail = detail, onDismiss = { viewModel.dismissCronRun() })
    }
    Scaffold(
        topBar = {
            StudioTopBar(
                title = stringResource(R.string.cron_history),
                subtitle = job.name,
                onBack = { viewModel.back() },
                actions = {
                    IconButton(
                        onClick = { viewModel.refreshCronHistory() },
                        enabled = !state.cronHistoryLoading,
                    ) {
                        Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.action_refresh))
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            state.error?.let { message ->
                item { ErrorNote(message) { viewModel.dismissError() } }
            }
            if (state.cronHistoryLoading || state.cronRunLoading) item { LoadingRow() }
            if (!state.cronHistoryLoading && state.cronRuns.isEmpty()) {
                item {
                    Box(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 64.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            stringResource(R.string.cron_history_empty),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            items(state.cronRuns, key = { "${it.jobId}/${it.fileName}" }) { run ->
                Card(
                    modifier = Modifier.fillMaxWidth().clickable { viewModel.openCronRun(run) },
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = androidx.compose.foundation.BorderStroke(
                        1.dp,
                        MaterialTheme.colorScheme.outline.copy(alpha = 0.65f),
                    ),
                ) {
                    Column(modifier = Modifier.padding(15.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(run.runTime, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                            Text(
                                formatBytes(run.size),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        val detail = buildList {
                            run.status?.let { add(it) }
                            run.runCount?.let { add(stringResource(R.string.cron_run_count, it)) }
                            if (run.synthetic || !run.hasOutput) add(stringResource(R.string.cron_run_metadata_only))
                        }.joinToString(" · ")
                        if (detail.isNotBlank()) {
                            Text(
                                detail,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        run.error?.let {
                            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CronRunDialog(detail: CronRunDetail, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text(stringResource(R.string.cron_run_output))
                Text(
                    detail.runTime,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        text = {
            Column(modifier = Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState())) {
                Text(
                    detail.content.ifBlank { stringResource(R.string.cron_run_no_output) },
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_ok)) }
        },
    )
}

private fun prettyPlatform(platform: String): String = when (platform.lowercase()) {
    "weixin" -> "WeChat"
    "wecom" -> "WeCom"
    "qqbot" -> "QQBot"
    "whatsapp" -> "WhatsApp"
    "whatsapp_cloud" -> "WhatsApp Cloud"
    "dingtalk" -> "DingTalk"
    "feishu" -> "Feishu"
    else -> platform.split('_').filter(String::isNotBlank).joinToString(" ") {
        it.replaceFirstChar(Char::uppercaseChar)
    }
}

private fun formatBytes(bytes: Long): String = when {
    bytes < 1024 -> "${bytes}B"
    bytes < 1024 * 1024 -> "%.1fKB".format(bytes / 1024.0)
    else -> "%.1fMB".format(bytes / 1024.0 / 1024.0)
}
