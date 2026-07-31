package us.i3u.hermesstudio

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class Screen {
    Loading, Onboarding, Login, Chats, Groups, Conversation, Room, Profiles,
    Settings, SettingsGroup, Channels, Channel, CronJobs, CronJob, CronHistory,
}

/** Settings is a short list of these; each opens its own screen. */
enum class SettingsGroup {
    Server, Users, Profile, Models, Agent, Memory, Compression, Sessions,
    Privacy, Proxy, Display, Device, About,
}

/** The two list tabs, mirroring Studio's chat / group-chat switch. */
enum class Tab { Chats, Groups }

private data class SessionBootstrap(
    val user: CurrentUser,
    val profiles: List<Profile>,
    val sessions: List<SessionSummary>,
)

private data class AccountSettingsData(
    val user: CurrentUser,
    val locks: List<LockedIp>,
    val avatar: AvatarSpec,
)

data class ChatLine(
    val text: String,
    val fromUser: Boolean,
    val isError: Boolean = false,
    val timestamp: String? = null,
    val sender: String? = null,
    /** What the model thought on the way to this answer, when it reports it. */
    val reasoning: String? = null,
    /** True while the words are still arriving. */
    val streaming: Boolean = false,
)

data class UiState(
    val screen: Screen = Screen.Login,
    val tab: Tab = Tab.Chats,
    val baseUrl: String = "",
    val busy: Boolean = false,
    val error: String? = null,
    val account: String? = null,
    val currentUser: CurrentUser? = null,
    val profiles: List<Profile> = emptyList(),
    /** Blank means "All profiles", the same default Studio shows. */
    val profileFilter: String = "",
    val activeProfile: String = "",
    val sessions: List<SessionSummary> = emptyList(),
    val rooms: List<Room> = emptyList(),
    val openSession: SessionSummary? = null,
    val openRoom: RoomDetail? = null,
    val lines: List<ChatLine> = emptyList(),
    val loadingHistory: Boolean = false,
    val sending: Boolean = false,
    val attachments: List<Upload> = emptyList(),
    val attaching: Boolean = false,
    val recording: Boolean = false,
    val transcribing: Boolean = false,
    /** Text produced by the last recording, consumed by the composer. */
    val transcript: String? = null,
    val models: List<ModelOption> = emptyList(),
    /** Profile whose entries are currently in [models]. */
    val modelsProfile: String? = null,
    val loadingModels: Boolean = false,
    /** Blank means the profile default, matching Studio's "Default" chip. */
    val reasoningEffort: String = "",
    /** BCP-47 tag chosen in Settings; blank follows the system. */
    val language: String = "",
    val sessionModel: String? = null,
    val sessionProvider: String? = null,
    val defaultModel: String? = null,
    val savingSetting: Boolean = false,
    /** The tool the agent is running right now, when it says so. */
    val activity: String? = null,
    /** True once the room socket is carrying messages. */
    val roomLive: Boolean = false,
    val serverConfig: ServerConfig? = null,
    /** The channel whose settings are open, if any. */
    val openChannel: String? = null,
    val openGroup: SettingsGroup? = null,
    val agentSettings: AgentSettings? = null,
    val autoStart: AutoStartPolicy? = null,
    val loadingAgentSettings: Boolean = false,
    val studioSettings: StudioSettings? = null,
    val loadingStudioSettings: Boolean = false,
    val lockedIps: List<LockedIp> = emptyList(),
    val accountAvatar: AvatarSpec? = null,
    val loadingAccountSettings: Boolean = false,
    val managedUsers: List<ManagedUser> = emptyList(),
    val managedProfiles: List<String> = emptyList(),
    val loadingManagedUsers: Boolean = false,
    val modelProviders: List<ModelProvider> = emptyList(),
    val loadingModelProviders: Boolean = false,
    val cronJobs: List<CronJob> = emptyList(),
    val cronLoading: Boolean = false,
    /** The job currently running a pause/resume/run/delete request. */
    val cronActionId: String? = null,
    val editingCronJob: CronJob? = null,
    val cronEditorJobId: String? = null,
    val cronEditorLoading: Boolean = false,
    val cronSkills: List<String> = emptyList(),
    val cronDeliveryTargets: List<CronDeliveryTarget> = emptyList(),
    val cronHistoryJob: CronJob? = null,
    val cronRuns: List<CronRun> = emptyList(),
    val cronHistoryLoading: Boolean = false,
    val cronRunLoading: Boolean = false,
    val openCronRun: CronRunDetail? = null,
    val notice: String? = null,
)

class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val store = Store(app)

    /** Resolves strings in the language chosen in Settings, not the phone's. */
    private val localized = AppLocale.wrap(app)
    private val api = HermesApi(store.baseUrl, store.token)
    private val chat = ChatSocket(store.baseUrl, store.token)
    private val group = GroupSocket(store.baseUrl, store.token)
    private val recorder = Recorder(app)
    private var runJob: kotlinx.coroutines.Job? = null
    private var historyJob: kotlinx.coroutines.Job? = null
    private var roomJob: kotlinx.coroutines.Job? = null
    private var roomLoadJob: kotlinx.coroutines.Job? = null
    private var openingRoomId: String? = null
    private var activeRunSessionId: String? = null

    private val _state = MutableStateFlow(
        UiState(
            // A configured install must never flash the credentials form: it reads
            // as "sign in again" even though the token is still good.
            screen = when {
                store.isConfigured -> Screen.Loading
                store.onboarded -> Screen.Login
                else -> Screen.Onboarding
            },
            baseUrl = store.baseUrl,
            reasoningEffort = store.reasoningEffort,
            language = store.language,
        ),
    )
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        // The cached mark is on disk, so the launch screen can show it at once.
        viewModelScope.launch { AppLogo.load(app) }
        if (store.isConfigured) restoreSession()
    }

    fun finishOnboarding() {
        store.onboarded = true
        _state.update { it.copy(screen = Screen.Login) }
    }

    private fun restoreSession() = launchWork(
        work = {
            api.update(store.baseUrl, store.token)
            chat.update(store.baseUrl, store.token)
            group.update(store.baseUrl, store.token)
            val user = api.currentUser()
            SessionBootstrap(user, api.profiles(), api.sessions(null))
        },
        onSuccess = { (user, profiles, sessions) ->
            _state.update {
                it.copy(
                    screen = Screen.Chats,
                    account = user.username,
                    currentUser = user,
                    profiles = profiles,
                    activeProfile = pickProfile(profiles),
                    sessions = sessions,
                    error = null,
                )
            }
            syncBranding()
        },
        onFailure = { failure ->
            if (failure.invalidatesSavedSession()) {
                store.clearCredentials()
                _state.update {
                    it.copy(
                        screen = Screen.Login,
                        error = str(R.string.error_session_expired, failure.readableMessage(localized)),
                    )
                }
            } else {
                // A timeout or an offline server does not invalidate a token.
                // Keep the launch screen and let the user retry in place.
                _state.update {
                    it.copy(
                        screen = Screen.Loading,
                        error = str(R.string.error_session_restore, failure.readableMessage(localized)),
                    )
                }
            }
        },
    )

    fun retrySession() {
        if (!store.isConfigured || _state.value.busy) return
        _state.update { it.copy(screen = Screen.Loading, error = null) }
        restoreSession()
    }

    fun login(baseUrl: String, username: String, password: String) {
        val normalized = normalizeUrl(baseUrl)
        if (normalized == null) {
            _state.update { it.copy(error = str(R.string.error_server_address)) }
            return
        }
        if (username.isBlank() || password.isBlank()) {
            _state.update { it.copy(error = str(R.string.error_credentials_required)) }
            return
        }

        launchWork(
            work = {
                api.update(normalized, "")
                val token = api.login(username.trim(), password)
                store.baseUrl = normalized
                store.token = token
                api.update(normalized, token)
                chat.update(normalized, token)
                group.update(normalized, token)
                val user = api.currentUser()
                SessionBootstrap(user, api.profiles(), api.sessions(null))
            },
            onSuccess = { (user, profiles, sessions) ->
                _state.update {
                    it.copy(
                        screen = Screen.Chats,
                        baseUrl = normalized,
                        account = user.username,
                        currentUser = user,
                        profiles = profiles,
                        activeProfile = pickProfile(profiles),
                        sessions = sessions,
                        error = null,
                    )
                }
                syncBranding()
            },
        )
    }

    /** Pulls the Studio logo from the connected server for the launch screen. */
    private fun syncBranding(force: Boolean = false) {
        viewModelScope.launch {
            runCatching { AppLogo.syncFromServer(getApplication<Application>(), api, force) }
        }
    }

    // ── lists ─────────────────────────────────────────────────────────────

    fun showTab(tab: Tab) {
        _state.update { it.copy(tab = tab, error = null) }
        when (tab) {
            Tab.Chats -> {
                _state.update { it.copy(screen = Screen.Chats) }
                if (_state.value.sessions.isEmpty()) refreshSessions()
            }
            Tab.Groups -> {
                _state.update { it.copy(screen = Screen.Groups) }
                if (_state.value.rooms.isEmpty()) refreshRooms()
            }
        }
    }

    fun refreshSessions() = launchWork(
        work = { api.sessions(_state.value.profileFilter.ifBlank { null }) },
        onSuccess = { sessions -> _state.update { it.copy(sessions = sessions) } },
    )

    fun refreshRooms() = launchWork(
        work = { api.rooms() },
        onSuccess = { rooms -> _state.update { it.copy(rooms = rooms) } },
    )

    fun setProfileFilter(profile: String) {
        _state.update { it.copy(profileFilter = profile) }
        refreshSessions()
    }

    fun refreshProfiles() = launchWork(
        work = { api.profiles() },
        onSuccess = { profiles ->
            _state.update { it.copy(profiles = profiles, activeProfile = pickProfile(profiles)) }
        },
    )

    fun selectProfile(name: String) {
        cancelActiveRun(abort = true)
        historyJob?.cancel()
        historyJob = null
        store.profile = name
        _state.update {
            it.copy(
                activeProfile = name,
                screen = Screen.Chats,
                tab = Tab.Chats,
                openSession = null,
                lines = emptyList(),
                attachments = emptyList(),
                sessionModel = null,
                sessionProvider = null,
                models = emptyList(),
                modelsProfile = null,
                defaultModel = null,
                serverConfig = null,
                agentSettings = null,
                autoStart = null,
            )
        }
    }

    // ── conversation ──────────────────────────────────────────────────────

    /** Open an existing Studio conversation and load its history. */
    fun openSession(session: SessionSummary) {
        cancelActiveRun(abort = true)
        historyJob?.cancel()
        val profile = session.profile?.ifBlank { null }
            ?: _state.value.activeProfile.ifBlank { "default" }
        store.setSessionFor(profile, session.id)
        _state.update {
            it.copy(
                screen = Screen.Conversation,
                openSession = session,
                sessionModel = session.model,
                sessionProvider = session.provider,
                lines = emptyList(),
                attachments = emptyList(),
                models = if (it.modelsProfile == profile) it.models else emptyList(),
                modelsProfile = it.modelsProfile.takeIf { loaded -> loaded == profile },
                loadingHistory = true,
                error = null,
            )
        }

        historyJob = viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.messages(session.id) } }
                .onSuccess { history ->
                    _state.update { state ->
                        if (state.screen != Screen.Conversation || state.openSession?.id != session.id) {
                            return@update state
                        }
                        state.copy(
                            loadingHistory = false,
                            lines = history.map { message ->
                                ChatLine(
                                    text = message.content,
                                    fromUser = message.fromUser,
                                    timestamp = message.timestamp,
                                )
                            },
                        )
                    }
                }
                .onFailure { failure ->
                    if (failure is kotlinx.coroutines.CancellationException) return@onFailure
                    _state.update {
                        if (it.screen == Screen.Conversation && it.openSession?.id == session.id) {
                            it.copy(loadingHistory = false, error = failure.readableMessage(localized))
                        } else {
                            it
                        }
                    }
                }
        }
    }

    fun startNewConversation() {
        cancelActiveRun(abort = true)
        historyJob?.cancel()
        historyJob = null
        val profile = _state.value.activeProfile.ifBlank { "default" }
        store.setSessionFor(profile, "")
        _state.update {
            it.copy(
                screen = Screen.Conversation,
                openSession = null,
                lines = emptyList(),
                attachments = emptyList(),
                sessionModel = null,
                sessionProvider = null,
                models = if (it.modelsProfile == profile) it.models else emptyList(),
                modelsProfile = it.modelsProfile.takeIf { loaded -> loaded == profile },
                error = null,
            )
        }
    }

    fun send(message: String) {
        val text = message.trim()
        val files = _state.value.attachments
        if ((text.isEmpty() && files.isEmpty()) || _state.value.sending) return
        val session = _state.value.openSession
        val profile = session?.profile?.ifBlank { null }
            ?: _state.value.activeProfile.ifBlank { "default" }
        val selectedModel = _state.value.sessionModel
        val selectedProvider = _state.value.sessionProvider
        val reasoningEffort = _state.value.reasoningEffort

        // Studio's own client names a conversation before it exists, which is
        // what lets the very first message belong to a session.
        val sessionId = store.sessionFor(profile).ifBlank { session?.id }
            ?: java.util.UUID.randomUUID().toString().also { store.setSessionFor(profile, it) }

        val echo = if (files.isEmpty()) text else {
            listOf(text.ifBlank { null }, files.joinToString(", ") { "📎 " + it.name })
                .filterNotNull()
                .joinToString("\n")
        }
        _state.update {
            it.copy(
                lines = it.lines + ChatLine(echo, fromUser = true),
                sending = true,
                attachments = emptyList(),
                error = null,
                activity = null,
            )
        }

        activeRunSessionId = sessionId
        runJob = viewModelScope.launch {
            var answer = StringBuilder()
            var thinking = StringBuilder()
            var streamed = false

            runCatching {
                chat.run(
                    profile = profile,
                    sessionId = sessionId,
                    input = text,
                    attachments = files,
                    reasoningEffort = reasoningEffort,
                    model = selectedModel,
                    provider = selectedProvider,
                )
                    .collect { event ->
                        when (event) {
                            is RunEvent.Text -> {
                                answer.append(event.delta)
                                if (!streamed) {
                                    streamed = true
                                    _state.update {
                                        it.copy(
                                            lines = it.lines + ChatLine("", fromUser = false, streaming = true),
                                            activity = null,
                                        )
                                    }
                                }
                                updateLastReply(answer.toString(), thinking.toString(), streaming = true)
                            }
                            is RunEvent.Reasoning -> {
                                thinking.append(event.delta)
                                if (streamed) updateLastReply(answer.toString(), thinking.toString(), streaming = true)
                            }
                            is RunEvent.Tool -> _state.update { it.copy(activity = event.name) }
                            is RunEvent.Done -> {
                                val output = event.output.ifBlank { answer.toString() }
                                val reasoning = event.reasoning.ifBlank { thinking.toString() }
                                if (streamed) {
                                    updateLastReply(output, reasoning, streaming = false)
                                } else {
                                    _state.update {
                                        it.copy(
                                            lines = it.lines + ChatLine(
                                                text = output,
                                                fromUser = false,
                                                reasoning = reasoning.ifBlank { null },
                                            ),
                                        )
                                    }
                                }
                                streamed = true
                            }
                            is RunEvent.RequiresAction -> {
                                if (streamed) {
                                    updateLastReply(answer.toString(), thinking.toString(), streaming = false)
                                }
                                val actionNotice = str(
                                    when (event.kind) {
                                        RequiredAction.Approval -> R.string.run_requires_approval
                                        RequiredAction.Clarification -> R.string.run_requires_clarification
                                    },
                                )
                                _state.update {
                                    it.copy(lines = it.lines + ChatLine(actionNotice, fromUser = false, isError = true))
                                }
                                // This is a valid run state, not a transport
                                // failure. Never submit the same turn over REST.
                                streamed = true
                            }
                            is RunEvent.Failed -> {
                                // A socket that never got going is not a failed
                                // run: fall back to the REST wrapper instead of
                                // telling the user the answer is lost.
                                if (event.retryableTransport && !streamed) throw SocketUnavailable(event.error)
                                updateLastReply(answer.toString(), thinking.toString(), streaming = false)
                                _state.update {
                                    it.copy(lines = it.lines + ChatLine(event.error, fromUser = false, isError = true))
                                }
                            }
                        }
                    }
            }.onFailure { failure ->
                if (failure is kotlinx.coroutines.CancellationException) return@onFailure
                if (failure is SocketUnavailable) {
                    sendOverRest(
                        profile = profile,
                        sessionId = sessionId,
                        text = text,
                        files = files,
                        reasoningEffort = reasoningEffort,
                        model = selectedModel,
                        provider = selectedProvider,
                    )
                    finishRun(sessionId)
                    return@launch
                }
                _state.update {
                    it.copy(
                        lines = it.lines + ChatLine(failure.readableMessage(localized), fromUser = false, isError = true),
                    )
                }
            }
            finishRun(sessionId)
        }
    }

    /** Older servers, or a blocked WebSocket, still answer over plain HTTP. */
    private suspend fun sendOverRest(
        profile: String,
        sessionId: String,
        text: String,
        files: List<Upload>,
        reasoningEffort: String?,
        model: String?,
        provider: String?,
    ) {
        runCatching {
            withContext(Dispatchers.IO) {
                api.sendMessage(
                    profile = profile,
                    input = text,
                    sessionId = sessionId,
                    attachments = files,
                    reasoningEffort = reasoningEffort,
                    model = model,
                    provider = provider,
                )
            }
        }.onSuccess { reply ->
            if (activeRunSessionId != sessionId) return@onSuccess
            reply.sessionId?.let { store.setSessionFor(profile, it) }
            val line = if (reply.error != null && reply.output.isBlank()) {
                ChatLine(reply.error, fromUser = false, isError = true)
            } else {
                ChatLine(reply.output, fromUser = false, reasoning = reply.reasoning)
            }
            _state.update { it.copy(lines = it.lines + line, sending = false, activity = null) }
        }.onFailure { failure ->
            if (failure is kotlinx.coroutines.CancellationException || activeRunSessionId != sessionId) {
                return@onFailure
            }
            _state.update {
                it.copy(
                    lines = it.lines + ChatLine(failure.readableMessage(localized), fromUser = false, isError = true),
                    sending = false,
                    activity = null,
                )
            }
        }
    }

    private fun updateLastReply(text: String, reasoning: String, streaming: Boolean) {
        _state.update { state ->
            val lines = state.lines.toMutableList()
            val index = lines.indexOfLast { !it.fromUser && !it.isError }
            if (index < 0) return@update state
            lines[index] = lines[index].copy(
                text = text,
                reasoning = reasoning.ifBlank { null },
                streaming = streaming,
            )
            state.copy(lines = lines)
        }
    }

    /** Asks the server to stop the run that is streaming right now. */
    fun stopRun() {
        cancelActiveRun(abort = true)
    }

    private fun cancelActiveRun(abort: Boolean) {
        val sessionId = activeRunSessionId
        if (abort && !sessionId.isNullOrBlank()) chat.abort(sessionId)
        runJob?.cancel()
        runJob = null
        activeRunSessionId = null
        _state.update { state ->
            val lines = state.lines.toMutableList()
            val index = lines.indexOfLast { it.streaming }
            if (index >= 0) lines[index] = lines[index].copy(streaming = false)
            state.copy(lines = lines, sending = false, activity = null)
        }
    }

    private fun finishRun(sessionId: String) {
        if (activeRunSessionId != sessionId) return
        activeRunSessionId = null
        runJob = null
        _state.update { it.copy(sending = false, activity = null) }
    }

    private class SocketUnavailable(message: String) : Exception(message)

    // ── attachments ───────────────────────────────────────────────────────

    /** Uploads the picked file to the server so the agent can read it by path. */
    fun attach(bytes: ByteArray, filename: String, mime: String) {
        val profile = currentProfile()
        _state.update { it.copy(attaching = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.upload(profile, bytes, filename, mime) } }
                .onSuccess { upload ->
                    _state.update { it.copy(attaching = false, attachments = it.attachments + upload) }
                }
                .onFailure { failure ->
                    _state.update { it.copy(attaching = false, error = failure.readableMessage(localized)) }
                }
        }
    }

    fun removeAttachment(upload: Upload) {
        _state.update { it.copy(attachments = it.attachments - upload) }
    }

    // ── voice ─────────────────────────────────────────────────────────────

    fun startRecording() {
        if (_state.value.recording) return
        if (recorder.start()) {
            _state.update { it.copy(recording = true, error = null) }
        } else {
            _state.update { it.copy(error = str(R.string.error_microphone)) }
        }
    }

    fun cancelRecording() {
        recorder.cancel()
        _state.update { it.copy(recording = false) }
    }

    /** Stops the take and turns it into text with the profile's STT provider. */
    fun stopRecordingAndTranscribe() {
        if (!_state.value.recording) return
        val bytes = recorder.stop()
        _state.update { it.copy(recording = false) }
        if (bytes == null) {
            _state.update { it.copy(error = str(R.string.error_recording_short)) }
            return
        }

        val profile = currentProfile()
        _state.update { it.copy(transcribing = true, error = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    api.transcribe(profile, bytes, "voice.m4a", "audio/mp4")
                }
            }.onSuccess { text ->
                _state.update { it.copy(transcribing = false, transcript = text) }
            }.onFailure { failure ->
                _state.update { it.copy(transcribing = false, error = failure.readableMessage(localized)) }
            }
        }
    }

    /** Sends the recorded audio itself instead of its transcript. */
    fun stopRecordingAndAttach() {
        if (!_state.value.recording) return
        val bytes = recorder.stop()
        _state.update { it.copy(recording = false) }
        if (bytes == null) {
            _state.update { it.copy(error = str(R.string.error_recording_short)) }
            return
        }
        attach(bytes, "voice-${System.currentTimeMillis()}.m4a", "audio/mp4")
    }

    fun consumeTranscript() = _state.update { it.copy(transcript = null) }

    // ── model and reasoning ───────────────────────────────────────────────

    fun loadModels() {
        val profile = currentProfile()
        val current = _state.value
        if (current.modelsProfile == profile && (current.models.isNotEmpty() || current.loadingModels)) return
        _state.update {
            it.copy(
                models = if (it.modelsProfile == profile) it.models else emptyList(),
                modelsProfile = profile,
                loadingModels = true,
            )
        }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.availableModels(profile) } }
                .onSuccess { models ->
                    _state.update {
                        if (it.modelsProfile == profile) it.copy(models = models, loadingModels = false) else it
                    }
                }
                .onFailure { failure ->
                    _state.update {
                        if (it.modelsProfile == profile) {
                            it.copy(loadingModels = false, error = failure.readableMessage(localized))
                        } else {
                            it
                        }
                    }
                }
        }
    }

    /** Applies a model to the open session, or remembers it for the next one. */
    fun selectModel(option: ModelOption) {
        val sessionId = _state.value.openSession?.id
            ?: store.sessionFor(currentProfile()).ifBlank { null }
        _state.update { it.copy(sessionModel = option.id, sessionProvider = option.provider) }
        if (sessionId == null) return

        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { api.setSessionModel(sessionId, option.id, option.provider) }
            }.onFailure { failure ->
                _state.update { it.copy(error = failure.readableMessage(localized)) }
            }
        }
    }

    fun setReasoningEffort(effort: String) {
        store.reasoningEffort = effort
        _state.update { it.copy(reasoningEffort = effort) }
    }

    // ── group room ────────────────────────────────────────────────────────

    fun openRoom(room: Room) {
        leaveRoom()
        openingRoomId = room.id
        _state.update {
            it.copy(screen = Screen.Room, openRoom = null, loadingHistory = true, error = null, roomLive = false)
        }
        roomLoadJob = viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.room(room.id) } }
                .onSuccess { detail ->
                    if (_state.value.screen != Screen.Room || openingRoomId != room.id) return@onSuccess
                    _state.update { it.copy(openRoom = detail, loadingHistory = false) }
                    listenToRoom(room.id)
                }
                .onFailure { failure ->
                    if (failure is kotlinx.coroutines.CancellationException) return@onFailure
                    _state.update {
                        if (it.screen == Screen.Room && openingRoomId == room.id) {
                            it.copy(loadingHistory = false, error = failure.readableMessage(localized))
                        } else {
                            it
                        }
                    }
                }
        }
    }

    /** Keeps the open room current, and is what makes posting possible. */
    private fun listenToRoom(roomId: String) {
        roomJob?.cancel()
        roomJob = viewModelScope.launch {
            runCatching {
                group.join(roomId, _state.value.account ?: "phone").collect { event ->
                    when (event) {
                        is RoomEvent.Connected -> _state.update { it.copy(roomLive = true) }
                        is RoomEvent.Dropped -> _state.update { it.copy(roomLive = false) }
                        is RoomEvent.Failed -> {
                            _state.update {
                                it.copy(roomLive = false, error = event.error)
                            }
                        }
                        is RoomEvent.Posted -> _state.update { state ->
                            val room = state.openRoom ?: return@update state
                            if (room.id != roomId) return@update state
                            if (room.messages.any { it.id == event.message.id }) return@update state
                            state.copy(openRoom = room.copy(messages = room.messages + event.message))
                        }
                    }
                }
            }
        }
    }

    fun leaveRoom() {
        openingRoomId = null
        roomLoadJob?.cancel()
        roomLoadJob = null
        roomJob?.cancel()
        roomJob = null
        _state.update { it.copy(roomLive = false) }
    }

    // ── conversations ─────────────────────────────────────────────────────

    fun renameSession(session: SessionSummary, title: String) {
        val clean = title.trim()
        if (clean.isBlank()) return
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.renameSession(session.id, clean) } }
                .onSuccess {
                    _state.update { state ->
                        state.copy(
                            sessions = state.sessions.map {
                                if (it.id == session.id) it.copy(title = clean) else it
                            },
                            openSession = state.openSession?.takeIf { it.id == session.id }?.copy(title = clean)
                                ?: state.openSession,
                        )
                    }
                }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    fun deleteSession(session: SessionSummary) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.deleteSession(session.id) } }
                .onSuccess {
                    // Forget the pointer too, or the next message would try to
                    // continue a conversation the server no longer has.
                    session.profile?.let { profile ->
                        if (store.sessionFor(profile) == session.id) store.setSessionFor(profile, "")
                    }
                    _state.update { state ->
                        state.copy(sessions = state.sessions.filterNot { it.id == session.id })
                    }
                }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    // ── profiles ──────────────────────────────────────────────────────────

    fun createProfile(name: String) = profileWork(name) { api.createProfile(it) }

    fun renameProfile(from: String, to: String) = profileWork(to) { api.renameProfile(from, it) }

    fun deleteProfile(name: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.deleteProfile(name) } }
                .onSuccess {
                    if (store.profile == name) store.profile = ""
                    refreshProfiles()
                    _state.update { it.copy(notice = str(R.string.notice_profile_deleted, name)) }
                }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    private fun profileWork(name: String, block: suspend (String) -> Unit) {
        val clean = name.trim()
        if (clean.isBlank()) return
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { block(clean) } }
                .onSuccess { refreshProfiles() }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    // ── rooms ─────────────────────────────────────────────────────────────

    fun createRoom(name: String, agents: List<String>) {
        val clean = name.trim()
        if (clean.isBlank()) return
        // Studio requires an invite code; one the user never has to think about
        // is better than a field they have to fill in.
        val code = (1..6).map { INVITE_ALPHABET.random() }.joinToString("")
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.createRoom(clean, code, agents) } }
                .onSuccess {
                    _state.update { it.copy(busy = false, notice = str(R.string.notice_room_created, clean)) }
                    refreshRooms()
                }
                .onFailure { failure ->
                    _state.update { it.copy(busy = false, error = failure.readableMessage(localized)) }
                }
        }
    }

    fun deleteRoom(room: Room) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.deleteRoom(room.id) } }
                .onSuccess {
                    _state.update { state -> state.copy(rooms = state.rooms.filterNot { it.id == room.id }) }
                }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    fun addRoomAgent(roomId: String, profile: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.addRoomAgent(roomId, profile) } }
                .onSuccess { reopenRoom(roomId) }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    private fun reopenRoom(roomId: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.room(roomId) } }
                .onSuccess { detail -> _state.update { it.copy(openRoom = detail) } }
        }
    }

    /** Sends into the open room over the socket the room screen holds. */
    fun postToRoom(text: String): Boolean {
        val room = _state.value.openRoom ?: return false
        val clean = text.trim()
        if (clean.isBlank()) return false
        val sent = group.post(room.id, clean, _state.value.account ?: "phone") { error ->
            if (error != null) _state.update { it.copy(error = error) }
        }
        if (!sent) {
            _state.update { it.copy(error = str(R.string.error_room_offline)) }
        }
        return sent
    }

    // ── settings ──────────────────────────────────────────────────────────

    // ── settings groups ───────────────────────────────────────────────────

    fun openSettingsGroup(group: SettingsGroup) {
        _state.update {
            it.copy(
                screen = Screen.SettingsGroup,
                openGroup = group,
                error = null,
                notice = null,
                loadingAgentSettings = group == SettingsGroup.Agent,
                loadingStudioSettings = group in STUDIO_CONFIG_GROUPS,
                loadingAccountSettings = group == SettingsGroup.Server,
                loadingManagedUsers = group == SettingsGroup.Users,
                loadingModelProviders = group == SettingsGroup.Models,
            )
        }
        if (group == SettingsGroup.Agent) loadAgentSettings()
        if (group == SettingsGroup.Profile) loadModels()
        if (group in STUDIO_CONFIG_GROUPS) loadStudioSettings()
        if (group == SettingsGroup.Server) loadAccountSettings()
        if (group == SettingsGroup.Users) loadManagedUsers()
        if (group == SettingsGroup.Models) loadModelProviders()
    }

    private fun loadStudioSettings(showLoading: Boolean = true) {
        val profile = currentProfile()
        if (showLoading) _state.update { it.copy(loadingStudioSettings = true) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.studioSettings(profile) } }
                .onSuccess { settings ->
                    _state.update { it.copy(studioSettings = settings, loadingStudioSettings = false) }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(loadingStudioSettings = false, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    /** Saves a partial Studio config section so untouched keys remain unchanged. */
    fun setStudioValue(section: String, key: String, value: Any) {
        saveStudioSection(section, org.json.JSONObject().put(key, value))
    }

    fun saveProxy(https: String, http: String, all: String, noProxy: String) {
        saveStudioSection(
            "proxy",
            org.json.JSONObject()
                .put("HTTPS_PROXY", https.trim())
                .put("HTTP_PROXY", http.trim())
                .put("ALL_PROXY", all.trim())
                .put("NO_PROXY", noProxy.trim()),
        )
    }

    private fun saveStudioSection(section: String, values: org.json.JSONObject) {
        val profile = currentProfile()
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    // Studio restarts the gateway for proxy and protected-action
                    // approval changes so those values take effect immediately.
                    api.updateConfigSection(
                        profile,
                        section,
                        values,
                        restart = section == "proxy" || section == "approvals",
                    )
                }
            }.onSuccess {
                _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) }
                loadStudioSettings(showLoading = false)
            }.onFailure { failure ->
                _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
            }
        }
    }

    private fun loadAccountSettings() {
        _state.update { it.copy(loadingAccountSettings = true) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val user = api.currentUser()
                    AccountSettingsData(user, api.lockedIps(), api.myAvatar(user.username))
                }
            }.onSuccess { (user, locks, avatar) ->
                _state.update {
                    it.copy(
                        account = user.username,
                        currentUser = user,
                        lockedIps = locks,
                        accountAvatar = avatar,
                        loadingAccountSettings = false,
                    )
                }
            }.onFailure { failure ->
                _state.update {
                    it.copy(loadingAccountSettings = false, error = failure.readableMessage(localized))
                }
            }
        }
    }

    fun changeAccountPassword(currentPassword: String, newPassword: String) {
        accountWork { api.changePassword(currentPassword, newPassword) }
    }

    fun changeAccountUsername(currentPassword: String, newUsername: String) {
        accountWork {
            api.changeUsername(currentPassword, newUsername)
            loadAccountSettings()
        }
    }

    fun setAccountAvatar(bytes: ByteArray, mime: String) {
        if (mime !in setOf("image/png", "image/jpeg", "image/webp")) {
            _state.update { it.copy(error = str(R.string.account_avatar_invalid_type)) }
            return
        }
        if (bytes.size > 1024 * 1024) {
            _state.update { it.copy(error = str(R.string.account_avatar_too_large)) }
            return
        }
        accountWork {
            val encoded = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
            api.updateMyAvatar("data:$mime;base64,$encoded")
            loadAccountSettings()
        }
    }

    fun randomizeAccountAvatar() = accountWork {
        val seed = "${_state.value.account.orEmpty()}-${System.currentTimeMillis()}-${java.util.UUID.randomUUID()}"
        val svg = MultiAvatar.svg(getApplication(), seed)
        val encoded = android.util.Base64.encodeToString(svg.toByteArray(), android.util.Base64.NO_WRAP)
        api.updateMyAvatar("data:image/svg+xml;base64,$encoded", seed)
        loadAccountSettings()
    }

    fun resetAccountAvatar() = accountWork {
        api.resetMyAvatar()
        loadAccountSettings()
    }

    fun unlockIp(ip: String) = accountWork {
        api.unlockIp(ip)
        loadAccountSettings()
    }

    fun unlockAllIps() = accountWork {
        api.unlockAllIps()
        loadAccountSettings()
    }

    private fun accountWork(block: suspend () -> Unit) {
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { block() } }
                .onSuccess { _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) } }
                .onFailure { failure ->
                    _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
                }
        }
    }

    private fun loadManagedUsers() {
        _state.update { it.copy(loadingManagedUsers = true) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.managedUsers() } }
                .onSuccess { result ->
                    _state.update {
                        it.copy(
                            managedUsers = result.users,
                            managedProfiles = result.profiles,
                            loadingManagedUsers = false,
                        )
                    }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(loadingManagedUsers = false, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun saveManagedUser(existingId: Int?, draft: ManagedUserDraft) {
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    if (existingId == null) api.createManagedUser(draft)
                    else api.updateManagedUser(existingId, draft)
                }
            }.onSuccess {
                _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) }
                loadManagedUsers()
            }.onFailure { failure ->
                _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
            }
        }
    }

    fun deleteManagedUser(user: ManagedUser) {
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.deleteManagedUser(user.id) } }
                .onSuccess {
                    _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) }
                    loadManagedUsers()
                }
                .onFailure { failure ->
                    _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
                }
        }
    }

    private fun loadModelProviders() {
        val profile = currentProfile()
        _state.update { it.copy(loadingModelProviders = true) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.modelProviders(profile) } }
                .onSuccess { providers ->
                    _state.update { it.copy(modelProviders = providers, loadingModelProviders = false) }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(loadingModelProviders = false, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun saveProviderKey(provider: String, key: String) {
        val profile = currentProfile()
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { api.updateProviderApiKey(profile, provider, key.trim()) }
            }.onSuccess {
                _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) }
                loadModelProviders()
            }.onFailure { failure ->
                _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
            }
        }
    }

    private fun loadAgentSettings() {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { api.agentSettings(profile) to api.autoStartPolicy() }
            }.onSuccess { (agent, policy) ->
                _state.update {
                    it.copy(agentSettings = agent, autoStart = policy, loadingAgentSettings = false)
                }
            }.onFailure { failure ->
                _state.update {
                    it.copy(loadingAgentSettings = false, error = failure.readableMessage(localized))
                }
            }
        }
    }

    /** Writes one agent knob; the server keeps the rest of the section as it is. */
    fun setAgentValue(key: String, value: Any) {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    api.updateConfigSection(profile, "agent", org.json.JSONObject().put(key, value))
                }
            }.onSuccess {
                _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) }
                loadAgentSettings()
            }.onFailure { failure ->
                _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
            }
        }
    }

    fun setAutoStart(policy: AutoStartPolicy) {
        val previous = _state.value.autoStart
        _state.update { it.copy(autoStart = policy, savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.setAutoStartPolicy(policy) } }
                .onSuccess {
                    _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) }
                    loadAgentSettings()
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(savingSetting = false, autoStart = previous, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    // ── scheduled jobs ──────────────────────────────────────────────────

    fun openCronJobs() {
        _state.update {
            it.copy(
                screen = Screen.CronJobs,
                error = null,
                notice = null,
                editingCronJob = null,
                cronEditorJobId = null,
                openCronRun = null,
            )
        }
        refreshCronJobs()
    }

    fun refreshCronJobs() {
        if (_state.value.cronLoading) return
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(cronLoading = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.cronJobs(profile) } }
                .onSuccess { jobs ->
                    _state.update {
                        it.copy(cronJobs = jobs.sortedBy { job -> job.name.lowercase() }, cronLoading = false)
                    }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(cronLoading = false, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    /** Opens a blank editor, or reloads one raw job before editing it. */
    fun openCronJob(jobId: String? = null) {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update {
            it.copy(
                screen = Screen.CronJob,
                editingCronJob = null,
                cronEditorJobId = jobId,
                cronEditorLoading = true,
                error = null,
                notice = null,
            )
        }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    CronEditorData(
                        job = jobId?.let { api.cronJob(profile, it) },
                        // These enrich the form, but a missing optional endpoint
                        // must not make the core job impossible to edit.
                        models = runCatching { api.availableModels(profile) }.getOrDefault(emptyList()),
                        skills = runCatching { api.cronSkills(profile) }.getOrDefault(emptyList()),
                        targets = runCatching { api.cronDeliveryTargets(profile) }.getOrDefault(emptyList()),
                    )
                }
            }.onSuccess { data ->
                _state.update {
                    it.copy(
                        editingCronJob = data.job,
                        models = data.models,
                        modelsProfile = profile,
                        cronSkills = data.skills,
                        cronDeliveryTargets = data.targets,
                        cronEditorLoading = false,
                    )
                }
            }.onFailure { failure ->
                _state.update {
                    it.copy(cronEditorLoading = false, error = failure.readableMessage(localized))
                }
            }
        }
    }

    fun saveCronJob(draft: CronJobDraft) {
        if (_state.value.savingSetting) return
        if (draft.name.isBlank()) {
            _state.update { it.copy(error = str(R.string.cron_name_required)) }
            return
        }
        if (draft.schedule.isBlank()) {
            _state.update { it.copy(error = str(R.string.cron_schedule_required)) }
            return
        }
        if (draft.prompt.isBlank()) {
            _state.update { it.copy(error = str(R.string.cron_prompt_required)) }
            return
        }
        if (draft.repeatTimes != null && draft.repeatTimes < 1) {
            _state.update { it.copy(error = str(R.string.cron_repeat_invalid)) }
            return
        }

        val profile = _state.value.activeProfile.ifBlank { "default" }
        val original = _state.value.editingCronJob
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    if (original == null) api.createCronJob(profile, draft)
                    else api.updateCronJob(profile, original, draft)
                }
            }.onSuccess { saved ->
                _state.update {
                    it.copy(
                        screen = Screen.CronJobs,
                        savingSetting = false,
                        editingCronJob = null,
                        cronEditorJobId = null,
                        cronJobs = it.cronJobs.upsert(saved),
                        notice = str(
                            if (original == null) R.string.cron_notice_created else R.string.cron_notice_updated,
                        ),
                    )
                }
            }.onFailure { failure ->
                _state.update {
                    it.copy(savingSetting = false, error = failure.readableMessage(localized))
                }
            }
        }
    }

    fun toggleCronJob(job: CronJob) {
        if (_state.value.cronActionId != null) return
        val profile = _state.value.activeProfile.ifBlank { "default" }
        val resume = job.state == "paused" || !job.enabled
        _state.update { it.copy(cronActionId = job.id, error = null, notice = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    if (resume) api.resumeCronJob(profile, job.id) else api.pauseCronJob(profile, job.id)
                }
            }.onSuccess { updated ->
                _state.update {
                    it.copy(
                        cronActionId = null,
                        cronJobs = it.cronJobs.upsert(updated),
                        notice = str(if (resume) R.string.cron_notice_resumed else R.string.cron_notice_paused),
                    )
                }
            }.onFailure { failure ->
                _state.update {
                    it.copy(cronActionId = null, error = failure.readableMessage(localized))
                }
            }
        }
    }

    fun runCronJob(job: CronJob) {
        if (_state.value.cronActionId != null) return
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(cronActionId = job.id, error = null, notice = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.runCronJob(profile, job.id) } }
                .onSuccess { updated ->
                    _state.update {
                        it.copy(
                            cronActionId = null,
                            cronJobs = it.cronJobs.upsert(updated),
                            notice = str(R.string.cron_notice_triggered),
                        )
                    }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(cronActionId = null, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun deleteCronJob(job: CronJob) {
        if (_state.value.cronActionId != null) return
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(cronActionId = job.id, error = null, notice = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.deleteCronJob(profile, job.id) } }
                .onSuccess {
                    _state.update {
                        it.copy(
                            cronActionId = null,
                            cronJobs = it.cronJobs.filterNot { candidate -> candidate.id == job.id },
                            notice = str(R.string.cron_notice_deleted),
                        )
                    }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(cronActionId = null, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun openCronHistory(job: CronJob) {
        _state.update {
            it.copy(
                screen = Screen.CronHistory,
                cronHistoryJob = job,
                cronRuns = emptyList(),
                openCronRun = null,
                error = null,
                notice = null,
            )
        }
        refreshCronHistory()
    }

    fun refreshCronHistory() {
        val job = _state.value.cronHistoryJob ?: return
        if (_state.value.cronHistoryLoading) return
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(cronHistoryLoading = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.cronRuns(profile, job.id) } }
                .onSuccess { runs ->
                    _state.update { it.copy(cronRuns = runs, cronHistoryLoading = false) }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(cronHistoryLoading = false, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun openCronRun(run: CronRun) {
        if (_state.value.cronRunLoading) return
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(cronRunLoading = true, openCronRun = null, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.cronRun(profile, run) } }
                .onSuccess { detail ->
                    _state.update { it.copy(cronRunLoading = false, openCronRun = detail) }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(cronRunLoading = false, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun dismissCronRun() = _state.update { it.copy(openCronRun = null) }

    // ── channels ──────────────────────────────────────────────────────────

    fun openChannels() {
        _state.update { it.copy(screen = Screen.Channels, error = null, notice = null) }
        refreshServerConfig()
    }

    /** Settings itself only needs the channel counts and the default model. */
    fun openSettings() {
        _state.update { it.copy(screen = Screen.Settings, error = null, notice = null, openGroup = null) }
        refreshServerConfig()
    }

    fun openChannel(platform: String) {
        _state.update { it.copy(screen = Screen.Channel, openChannel = platform, error = null, notice = null) }
    }

    private fun refreshServerConfig() {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.serverConfig(profile) } }
                .onSuccess { config ->
                    _state.update { it.copy(serverConfig = config, defaultModel = config.defaultModel) }
                }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    /**
     * Writes a channel's credentials. The server restarts the gateway itself
     * once they land, which is what actually puts the channel online.
     */
    fun saveChannel(platform: String, values: Map<String, String>, enabled: Boolean) {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        val label = channelSpec(platform).label
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val filled = values.filterValues { it.isNotBlank() }
                    if (filled.isNotEmpty()) api.updateChannelCredentials(profile, platform, filled)
                    api.setChannelEnabled(profile, platform, enabled)
                }
            }.onSuccess {
                _state.update {
                    it.copy(savingSetting = false, notice = str(R.string.notice_channel_saved, label))
                }
                refreshServerConfig()
            }.onFailure { failure ->
                _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
            }
        }
    }

    fun clearChannel(platform: String) {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        val label = channelSpec(platform).label
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.clearChannelCredentials(profile, platform) } }
                .onSuccess {
                    _state.update {
                        it.copy(savingSetting = false, notice = str(R.string.notice_channel_cleared, label))
                    }
                    refreshServerConfig()
                }
                .onFailure { failure ->
                    _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
                }
        }
    }

    /** Whether the gateway comes up with the server, written server-side. */
    fun setGatewayAutoStart(enabled: Boolean) {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        val previous = _state.value.serverConfig
        _state.update { it.copy(serverConfig = previous?.copy(gatewayAutoStart = enabled), savingSetting = true) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    api.updateConfigSection(
                        profile,
                        "gatewayAutoStart",
                        org.json.JSONObject().put("enabled", enabled),
                    )
                }
            }.onSuccess {
                _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) }
            }.onFailure { failure ->
                _state.update {
                    it.copy(savingSetting = false, serverConfig = previous, error = failure.readableMessage(localized))
                }
            }
        }
    }

    /** Writes the profile default, which is what new conversations start from. */
    fun setDefaultModel(option: ModelOption) {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { api.setDefaultModel(profile, option.id, option.provider) }
            }.onSuccess {
                _state.update {
                    it.copy(
                        savingSetting = false,
                        defaultModel = option.id,
                        notice = str(R.string.notice_default_model, profile, option.id),
                    )
                }
            }.onFailure { failure ->
                _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
            }
        }
    }

    fun restartGateway() {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.restartGateway(profile) } }
                .onSuccess {
                    _state.update {
                        it.copy(savingSetting = false, notice = str(R.string.notice_gateway_restarting, profile))
                    }
                }
                .onFailure { failure ->
                    _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
                }
        }
    }

    /** Replaces the app mark with a picture from the device. */
    fun setAppLogo(bytes: ByteArray) {
        viewModelScope.launch {
            val applied = AppLogo.setCustom(getApplication<Application>(), bytes)
            _state.update {
                if (applied) it.copy(notice = str(R.string.notice_logo_updated), error = null)
                else it.copy(error = str(R.string.error_image_unreadable))
            }
        }
    }

    /** Goes back to whatever logo the connected Studio serves. */
    fun resetAppLogo() {
        viewModelScope.launch {
            AppLogo.clearCustom(getApplication<Application>())
            runCatching { AppLogo.syncFromServer(getApplication<Application>(), api, force = true) }
            _state.update {
                if (AppLogo.image != null) {
                    it.copy(notice = str(R.string.notice_logo_from_server), error = null)
                } else {
                    it.copy(error = str(R.string.error_no_server_logo))
                }
            }
        }
    }

    fun dismissNotice() = _state.update { it.copy(notice = null) }

    // ── misc ──────────────────────────────────────────────────────────────

    fun back() {
        when (_state.value.screen) {
            Screen.Conversation -> cancelActiveRun(abort = true)
            Screen.Room -> leaveRoom()
            else -> Unit
        }
        _state.update { state ->
            val target = when (state.screen) {
                Screen.Channel -> Screen.Channels
                Screen.CronJob, Screen.CronHistory -> Screen.CronJobs
                Screen.Channels, Screen.SettingsGroup, Screen.CronJobs -> Screen.Settings
                else -> if (state.tab == Tab.Groups) Screen.Groups else Screen.Chats
            }
            state.copy(
                screen = target,
                error = null,
                openSession = state.openSession.takeUnless { state.screen == Screen.Conversation },
                openRoom = state.openRoom.takeUnless { state.screen == Screen.Room },
                attachments = if (state.screen == Screen.Conversation) emptyList() else state.attachments,
                sessionModel = state.sessionModel.takeUnless { state.screen == Screen.Conversation },
                sessionProvider = state.sessionProvider.takeUnless { state.screen == Screen.Conversation },
                editingCronJob = state.editingCronJob.takeUnless { state.screen == Screen.CronJob },
                cronEditorJobId = state.cronEditorJobId.takeUnless { state.screen == Screen.CronJob },
                openCronRun = null,
            )
        }
    }

    fun show(screen: Screen) = _state.update { it.copy(screen = screen, error = null) }

    fun dismissError() = _state.update { it.copy(error = null) }

    fun signOut() {
        cancelActiveRun(abort = true)
        leaveRoom()
        store.clearCredentials()
        _state.update {
            UiState(
                screen = Screen.Login,
                baseUrl = store.baseUrl,
                reasoningEffort = store.reasoningEffort,
                language = store.language,
            )
        }
    }

    /** Chooses the language for every screen; the activity restarts to apply it. */
    fun setLanguage(tag: String) {
        store.language = tag
        _state.update { it.copy(language = tag) }
    }

    private fun str(id: Int, vararg args: Any): String = localized.getString(id, *args)

    private fun currentProfile(): String =
        _state.value.openSession?.profile?.ifBlank { null }
            ?: _state.value.activeProfile.ifBlank { "default" }

    private fun pickProfile(profiles: List<Profile>): String {
        val stored = store.profile
        if (stored.isNotBlank() && profiles.any { it.name == stored }) return stored
        val chosen = profiles.firstOrNull { it.active }?.name
            ?: profiles.firstOrNull()?.name
            ?: "default"
        store.profile = chosen
        return chosen
    }

    private fun <T> launchWork(
        work: suspend () -> T,
        onSuccess: (T) -> Unit,
        onFailure: ((Throwable) -> Unit)? = null,
    ) {
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { work() } }
                .onSuccess {
                    _state.update { state -> state.copy(busy = false) }
                    onSuccess(it)
                }
                .onFailure { failure ->
                    _state.update { state -> state.copy(busy = false) }
                    if (onFailure != null) onFailure(failure)
                    else _state.update { state -> state.copy(error = failure.readableMessage(localized)) }
                }
        }
    }

    private fun normalizeUrl(raw: String): String? {
        val trimmed = raw.trim().trimEnd('/')
        if (trimmed.isBlank()) return null
        val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            trimmed
        } else {
            "https://$trimmed"
        }
        return runCatching { java.net.URL(withScheme) }.map { withScheme }.getOrNull()
    }
}

private val STUDIO_CONFIG_GROUPS = setOf(
    SettingsGroup.Display,
    SettingsGroup.Proxy,
    SettingsGroup.Memory,
    SettingsGroup.Compression,
    SettingsGroup.Sessions,
    SettingsGroup.Privacy,
)

private data class CronEditorData(
    val job: CronJob?,
    val models: List<ModelOption>,
    val skills: List<String>,
    val targets: List<CronDeliveryTarget>,
)

private fun List<CronJob>.upsert(job: CronJob): List<CronJob> =
    (filterNot { it.id == job.id } + job).sortedBy { it.name.lowercase() }

private val INVITE_ALPHABET = ('A'..'Z') + ('2'..'9')

internal fun Throwable.invalidatesSavedSession(): Boolean =
    (this as? HermesException)?.statusCode in setOf(401, 403)

private fun Throwable.readableMessage(context: android.content.Context): String = when (this) {
    // A HermesException already carries what the server said, in its own words.
    is HermesException -> message ?: context.getString(R.string.error_request_failed)
    is java.net.UnknownHostException -> context.getString(R.string.error_unreachable)
    is java.net.SocketTimeoutException -> context.getString(R.string.error_timeout)
    is javax.net.ssl.SSLException -> context.getString(R.string.error_tls)
    else -> message ?: this::class.java.simpleName
}
