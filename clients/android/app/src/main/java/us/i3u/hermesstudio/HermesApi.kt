package us.i3u.hermesstudio

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Thin client over the Hermes Studio HTTP API.
 *
 * Every endpoint used here is the same one the Studio web UI calls, so the app
 * stays compatible with a stock server. Keeping all of them in one file means a
 * server-side change only ever has to be chased in a single place.
 */
class HermesApi(
    private var baseUrl: String,
    private var token: String,
) {
    private val json = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(300, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    fun update(baseUrl: String, token: String) {
        this.baseUrl = baseUrl.trimEnd('/')
        this.token = token
    }

    private fun url(path: String) = baseUrl.trimEnd('/') + path

    private fun request(path: String, method: String, body: JSONObject?, profile: String? = null): Request {
        val builder = Request.Builder().url(url(path))
        if (token.isNotBlank()) builder.header("Authorization", "Bearer $token")
        if (!profile.isNullOrBlank()) builder.header("X-Hermes-Profile", profile)
        builder.header("Accept", "application/json")
        when (method) {
            "POST" -> builder.post((body ?: JSONObject()).toString().toRequestBody(json))
            "PUT" -> builder.put((body ?: JSONObject()).toString().toRequestBody(json))
            "PATCH" -> builder.patch((body ?: JSONObject()).toString().toRequestBody(json))
            "DELETE" -> builder.delete()
            else -> builder.get()
        }
        return builder.build()
    }

    private fun call(
        path: String,
        method: String = "GET",
        body: JSONObject? = null,
        profile: String? = null,
    ): JSONObject {
        client.newCall(request(path, method, body, profile)).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val detail = errorDetail(text)
                throw HermesException(
                    if (detail.isNullOrBlank()) "HTTP ${response.code}" else "HTTP ${response.code}: $detail",
                    statusCode = response.code,
                )
            }
            if (text.isBlank()) return JSONObject()
            return runCatching { JSONObject(text) }.getOrElse {
                JSONObject().put("data", runCatching { JSONArray(text) }.getOrDefault(JSONArray()))
            }
        }
    }

    /** POST /api/auth/login — returns the bearer token used by every other call. */
    fun login(username: String, password: String): String {
        val body = JSONObject().put("username", username).put("password", password)
        val result = call("/api/auth/login", "POST", body)
        val issued = result.optString("token")
        if (issued.isBlank()) throw HermesException("Login succeeded but no token was returned")
        return issued
    }

    /** GET /api/auth/me — cheap check that a stored token is still valid. */
    fun verifyToken(): String {
        val me = call("/api/auth/me")
        val user = me.optJSONObject("user")
        return user?.optString("username").orEmpty()
            .ifBlank { user?.optString("id").orEmpty() }
            .ifBlank { me.optString("username") }
            .ifBlank { me.optString("userId") }
    }

    /** GET /api/auth/me — full account metadata used by Settings. */
    fun currentUser(): CurrentUser {
        val result = call("/api/auth/me")
        val user = result.optJSONObject("user") ?: result
        return CurrentUser(
            id = user.optInt("id", 0),
            username = user.optString("username").ifBlank { user.optString("userId") },
            role = user.optString("role").ifBlank { "admin" },
            status = user.optString("status").ifBlank { "active" },
            lastLoginAt = user.optLong("last_login_at", 0).takeIf { it > 0 },
            avatar = user.optString("avatar").takeIf { it.isNotBlank() },
        )
    }

    fun changePassword(currentPassword: String, newPassword: String) {
        call(
            "/api/auth/change-password",
            "POST",
            JSONObject().put("currentPassword", currentPassword).put("newPassword", newPassword),
        )
    }

    fun changeUsername(currentPassword: String, newUsername: String) {
        call(
            "/api/auth/change-username",
            "POST",
            JSONObject().put("currentPassword", currentPassword).put("newUsername", newUsername),
        )
    }

    fun updateMyAvatar(dataUrl: String, seed: String? = null) {
        val avatar = JSONObject().put("type", "image").put("dataUrl", dataUrl)
            .apply { if (!seed.isNullOrBlank()) put("seed", seed) }
            .toString()
        call("/api/auth/avatar", "PUT", JSONObject().put("avatar", avatar))
    }

    fun resetMyAvatar() {
        call("/api/auth/avatar", "PUT", JSONObject().put("avatar", JSONObject().put("type", "default")))
    }

    fun myAvatar(username: String): AvatarSpec {
        val raw = call("/api/auth/avatar").opt("avatar")
        val json = when (raw) {
            is JSONObject -> raw
            is String -> runCatching { JSONObject(raw) }.getOrNull()
            else -> null
        }
        val parsed = AvatarSpec.from(json)
            ?: return AvatarSpec(type = "default", seed = username, dataUrl = null, updatedAt = 0)
        return if (parsed.type != "image" && parsed.seed.isNullOrBlank()) parsed.copy(seed = username) else parsed
    }

    fun lockedIps(): List<LockedIp> {
        val array = call("/api/auth/locked-ips").optJSONArray("locks") ?: JSONArray()
        return (0 until array.length()).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            LockedIp(
                ip = item.optString("ip"),
                type = item.optString("type"),
                failures = item.optInt("failures", 0),
                lockedUntil = item.optLong("lockedUntil", 0),
            ).takeIf { it.ip.isNotBlank() }
        }
    }

    fun unlockIp(ip: String) {
        call("/api/auth/locked-ips?ip=${enc(ip)}", "DELETE")
    }

    fun unlockAllIps(): Int = call("/api/auth/locked-ips", "DELETE").optInt("count", 0)

    fun managedUsers(): ManagedUsers {
        val result = call("/api/auth/users")
        return ManagedUsers(
            users = parseManagedUsers(result.optJSONArray("users")),
            profiles = strings(result.optJSONArray("profiles")),
        )
    }

    fun createManagedUser(draft: ManagedUserDraft) {
        call("/api/auth/users", "POST", draft.toJson(includeEmptyPassword = true))
    }

    fun updateManagedUser(id: Int, draft: ManagedUserDraft) {
        call("/api/auth/users/$id", "PUT", draft.toJson(includeEmptyPassword = false))
    }

    fun deleteManagedUser(id: Int) {
        call("/api/auth/users/$id", "DELETE")
    }

    /** GET /api/hermes/profiles */
    fun profiles(): List<Profile> {
        val array = call("/api/hermes/profiles").optJSONArray("profiles") ?: JSONArray()
        return (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            Profile(
                name = item.optString("name"),
                model = item.optString("model").takeIf { it.isNotBlank() && it != "—" },
                active = item.optBoolean("active", false),
                gatewayStatus = item.optString("gatewayStatus").ifBlank { item.optString("alias") },
                avatar = AvatarSpec.from(item.optJSONObject("avatar")),
            )
        }.filter { it.name.isNotBlank() }
    }

    /** POST /api/hermes/sessions/{id}/rename */
    fun renameSession(sessionId: String, title: String) {
        call("/api/hermes/sessions/${enc(sessionId)}/rename", "POST", JSONObject().put("title", title))
    }

    /** DELETE /api/hermes/sessions/{id} */
    fun deleteSession(sessionId: String) {
        call("/api/hermes/sessions/${enc(sessionId)}", "DELETE")
    }

    /** POST /api/hermes/profiles */
    fun createProfile(name: String) {
        call("/api/hermes/profiles", "POST", JSONObject().put("name", name))
    }

    /** POST /api/hermes/profiles/{name}/rename */
    fun renameProfile(name: String, newName: String) {
        call("/api/hermes/profiles/${enc(name)}/rename", "POST", JSONObject().put("new_name", newName))
    }

    /** DELETE /api/hermes/profiles/{name} */
    fun deleteProfile(name: String) {
        call("/api/hermes/profiles/${enc(name)}", "DELETE")
    }

    /**
     * POST /api/hermes/group-chat/rooms — a room needs a name and an invite
     * code, and the agents it starts with are profiles.
     */
    fun createRoom(name: String, inviteCode: String, agents: List<String>): Room {
        val body = JSONObject()
            .put("name", name)
            .put("inviteCode", inviteCode)
            .put("agents", JSONArray().apply { agents.forEach { put(JSONObject().put("profile", it)) } })
        val result = call("/api/hermes/group-chat/rooms", "POST", body)
        val room = result.optJSONObject("room") ?: throw HermesException("The server returned no room")
        return Room(
            id = firstNonBlank(room, "id") ?: throw HermesException("The new room has no id"),
            name = firstNonBlank(room, "name") ?: name,
            agentCount = room.optInt("agentCount", agents.size),
            memberCount = room.optInt("memberCount", 1),
            updatedAt = firstNonBlank(room, "updatedAt", "updated_at"),
        )
    }

    /** DELETE /api/hermes/group-chat/rooms/{id} */
    fun deleteRoom(roomId: String) {
        call("/api/hermes/group-chat/rooms/${enc(roomId)}", "DELETE")
    }

    /** POST /api/hermes/group-chat/rooms/{id}/agents */
    fun addRoomAgent(roomId: String, profile: String) {
        call("/api/hermes/group-chat/rooms/${enc(roomId)}/agents", "POST", JSONObject().put("profile", profile))
    }

    /** GET /api/hermes/config — the pieces of it the app can act on. */
    fun serverConfig(profile: String): ServerConfig {
        val result = call("/api/hermes/config?profile=${enc(profile)}")
        val platforms = result.optJSONObject("platforms")
        val credentials = result.optJSONObject("platformCredentialStatus")
        val channels = buildList {
            val names = LinkedHashSet<String>()
            CHANNELS.forEach { names.add(it.platform) }
            platforms?.keys()?.forEach { names.add(it) }
            credentials?.keys()?.forEach { names.add(it) }
            names.forEach { platform ->
                val settings = platforms?.optJSONObject(platform)
                add(
                    ChannelStatus(
                        platform = platform,
                        // Hermes runs a channel unless it is explicitly turned off.
                        enabled = settings?.optBoolean("enabled", true) ?: true,
                        configured = credentials?.optBoolean(platform, false) ?: false,
                    ),
                )
            }
        }
        return ServerConfig(
            defaultModel = result.optJSONObject("model")?.let { firstNonBlank(it, "default") },
            // The server treats anything other than an explicit false as "yes".
            gatewayAutoStart = result.optJSONObject("gatewayAutoStart")?.optBoolean("enabled", true) ?: true,
            channels = channels,
        )
    }

    /**
     * PUT /api/hermes/config/credentials — writes a channel's secrets into the
     * profile's env file. The server restarts the gateway itself afterwards,
     * which is what actually puts the channel online.
     */
    fun updateChannelCredentials(profile: String, platform: String, values: Map<String, String>) {
        val payload = JSONObject()
        val extra = JSONObject()
        values.forEach { (path, value) ->
            if (path.startsWith("extra.")) extra.put(path.removePrefix("extra."), value)
            else payload.put(path, value)
        }
        if (extra.length() > 0) payload.put("extra", extra)
        val body = JSONObject().put("platform", platform).put("values", payload)
        call("/api/hermes/config/credentials?profile=${enc(profile)}", "PUT", body)
    }

    /** DELETE /api/hermes/config/credentials/{platform} */
    fun clearChannelCredentials(profile: String, platform: String) {
        call("/api/hermes/config/credentials/${enc(platform)}?profile=${enc(profile)}", "DELETE")
    }

    /** Turns a channel on or off without touching its credentials. */
    fun setChannelEnabled(profile: String, platform: String, enabled: Boolean) {
        updateConfigSection(profile, platform, JSONObject().put("enabled", enabled), restart = true)
    }

    /** The agent knobs Studio keeps under its Agent tab. */
    fun agentSettings(profile: String): AgentSettings {
        val agent = call("/api/hermes/config?profile=${enc(profile)}&section=agent").optJSONObject("agent")
        return AgentSettings(
            maxTurns = agent?.optInt("max_turns", 0)?.takeIf { it > 0 },
            gatewayTimeout = agent?.optInt("gateway_timeout", -1)?.takeIf { it >= 0 },
            restartDrainTimeout = agent?.optInt("restart_drain_timeout", 0)?.takeIf { it > 0 },
            toolEnforcement = agent?.optString("tool_use_enforcement").orEmpty().ifBlank { "auto" },
        )
    }

    /** All server-side tabs from Studio's Settings view, merged with its UI defaults. */
    fun studioSettings(profile: String): StudioSettings {
        val result = call("/api/hermes/config?profile=${enc(profile)}")
        val display = result.optJSONObject("display") ?: JSONObject()
        val proxy = result.optJSONObject("proxy") ?: JSONObject()
        val memory = result.optJSONObject("memory") ?: JSONObject()
        val skills = result.optJSONObject("skills") ?: JSONObject()
        val compression = result.optJSONObject("compression") ?: JSONObject()
        val reset = result.optJSONObject("sessionReset")
            ?: result.optJSONObject("session_reset")
            ?: JSONObject()
        val approvals = result.optJSONObject("approvals") ?: JSONObject()
        val privacy = result.optJSONObject("privacy") ?: JSONObject()
        return StudioSettings(
            display = DisplaySettings(
                streaming = display.optBoolean("streaming", true),
                compact = display.optBoolean("compact", false),
                showReasoning = display.optBoolean("show_reasoning", true),
                showCost = display.optBoolean("show_cost", false),
                inlineDiffs = display.optBoolean("inline_diffs", true),
                bellOnComplete = display.optBoolean("bell_on_complete", false),
                notifyOnComplete = display.optBoolean("notify_on_complete", false),
                chatInputHeight = display.optInt("chat_input_height", 0).takeIf { it > 0 },
            ),
            proxy = ProxySettings(
                https = proxy.optString("HTTPS_PROXY"),
                http = proxy.optString("HTTP_PROXY"),
                all = proxy.optString("ALL_PROXY"),
                noProxy = proxy.optString("NO_PROXY"),
            ),
            memory = MemorySettings(
                enabled = memory.optBoolean("memory_enabled", true),
                userProfileEnabled = memory.optBoolean("user_profile_enabled", true),
                memoryCharLimit = memory.optInt("memory_char_limit", 2000),
                userCharLimit = memory.optInt("user_char_limit", 2000),
                writeApproval = memory.optBoolean("write_approval", false),
            ),
            compression = CompressionSettings(
                enabled = compression.optBoolean("enabled", true),
                threshold = compression.optDouble("threshold", 0.5),
                targetRatio = compression.optDouble("target_ratio", 0.2),
                protectLast = compression.optInt("protect_last_n", 20),
                protectFirst = compression.optInt("protect_first_n", 3),
            ),
            session = SessionSettings(
                approvalsMode = approvals.optString("mode").ifBlank { "off" },
                skillsWriteApproval = skills.optBoolean("write_approval", false),
                resetMode = reset.optString("mode").ifBlank { "both" },
                idleMinutes = reset.optInt("idle_minutes", 60),
                atHour = reset.optInt("at_hour", 0),
            ),
            privacy = PrivacySettings(redactPii = privacy.optBoolean("redact_pii", false)),
        )
    }

    /** GET /api/hermes/config?section=gatewayAutoStart — the whole policy. */
    fun autoStartPolicy(): AutoStartPolicy {
        val policy = call("/api/hermes/config?section=gatewayAutoStart").optJSONObject("gatewayAutoStart")
        val include = policy?.optJSONArray("include")
        val exclude = policy?.optJSONArray("exclude")
        fun names(array: JSONArray?): List<String>? = array?.let { list ->
            (0 until list.length()).mapNotNull { list.optString(it).takeIf { name -> name.isNotBlank() } }
        }
        return AutoStartPolicy(
            enabled = policy?.optBoolean("enabled", true) ?: true,
            include = names(include),
            exclude = names(exclude).orEmpty(),
            management = policy?.optString("management").orEmpty().ifBlank { "per_profile" },
        )
    }

    /**
     * Writes the auto-start policy. A null include list means "every profile
     * the server discovers", which is what Studio calls the all policy.
     */
    fun setAutoStartPolicy(policy: AutoStartPolicy) {
        val values = JSONObject().put("enabled", policy.enabled)
        if (policy.include == null) values.put("include", JSONObject.NULL)
        else values.put("include", JSONArray().apply { policy.include.forEach { put(it) } })
        values.put("exclude", JSONArray().apply { policy.exclude.forEach { put(it) } })
        values.put("management", policy.management)
        call("/api/hermes/config", "PUT", JSONObject().put("section", "gatewayAutoStart").put("values", values))
    }

    /** PUT /api/hermes/config — one section at a time, as Studio does. */
    fun updateConfigSection(profile: String, section: String, values: JSONObject, restart: Boolean = false) {
        val body = JSONObject()
            .put("section", section)
            .put("values", values)
            .put("restart", restart)
        call("/api/hermes/config?profile=${enc(profile)}", "PUT", body)
    }

    /** GET /api/hermes/sessions — most recent conversations for a profile. */
    fun sessions(profile: String?, limit: Int = 80): List<SessionSummary> {
        val path = if (profile.isNullOrBlank()) {
            "/api/hermes/sessions?limit=$limit"
        } else {
            "/api/hermes/sessions?profile=${enc(profile)}&limit=$limit"
        }
        val array = call(path).optJSONArray("sessions") ?: JSONArray()
        return (0 until array.length()).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            val id = firstNonBlank(item, "id", "session_id", "sessionId") ?: return@mapNotNull null
            SessionSummary(
                id = id,
                title = firstNonBlank(item, "title", "name", "summary") ?: id.take(8),
                model = firstNonBlank(item, "model"),
                provider = firstNonBlank(item, "provider"),
                updatedAt = firstNonBlank(
                    item,
                    "last_active",
                    "ended_at",
                    "started_at",
                    "updated_at",
                    "updatedAt",
                    "created_at",
                    "createdAt",
                ),
                profile = firstNonBlank(item, "profile"),
            )
        }
    }

    /** GET /api/hermes/available-models — flattened to what the picker needs. */
    fun availableModels(profile: String): List<ModelOption> {
        val result = call("/api/hermes/available-models?profile=${enc(profile)}")
        val options = LinkedHashMap<String, ModelOption>()

        fun collect(container: JSONObject) {
            val provider = firstNonBlank(container, "provider", "name", "label") ?: return
            val models = container.optJSONArray("models") ?: return
            for (index in 0 until models.length()) {
                val id = models.optString(index).takeIf { it.isNotBlank() }
                    ?: models.optJSONObject(index)?.let { firstNonBlank(it, "id", "name", "model") }
                    ?: continue
                if (id == "*") continue
                options.putIfAbsent(id, ModelOption(id = id, provider = provider))
            }
        }

        result.optJSONArray("groups")?.let { groups ->
            for (index in 0 until groups.length()) groups.optJSONObject(index)?.let(::collect)
        }
        if (options.isEmpty()) {
            result.optJSONArray("allProviders")?.let { providers ->
                for (index in 0 until providers.length()) providers.optJSONObject(index)?.let(::collect)
            }
        }
        return options.values.toList()
    }

    /** Provider credentials shown by Studio's Settings > Models tab. */
    fun modelProviders(profile: String): List<ModelProvider> {
        val result = call("/api/hermes/available-models?profile=${enc(profile)}")
        val groups = result.optJSONArray("groups") ?: JSONArray()
        return (0 until groups.length()).mapNotNull { index ->
            val item = groups.optJSONObject(index) ?: return@mapNotNull null
            val id = item.optString("provider").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            if (id == "moa") return@mapNotNull null
            ModelProvider(
                id = id,
                label = item.optString("label").ifBlank { id.removePrefix("custom:") },
                builtin = item.optBoolean("builtin", !id.startsWith("custom:")),
                configured = item.optString("api_key").isNotBlank(),
                baseUrl = item.optString("base_url"),
                modelCount = item.optJSONArray("models")?.length() ?: 0,
            )
        }
    }

    fun updateProviderApiKey(profile: String, provider: String, apiKey: String) {
        call(
            "/api/hermes/config/providers/${enc(provider)}?profile=${enc(profile)}",
            "PUT",
            JSONObject().put("api_key", apiKey),
        )
    }

    /** PUT /api/hermes/config/model — the profile's default model. */
    fun setDefaultModel(profile: String, model: String, provider: String?) {
        val body = JSONObject().put("default", model)
        if (!provider.isNullOrBlank()) body.put("provider", provider)
        call("/api/hermes/config/model?profile=${enc(profile)}", "PUT", body)
    }

    /** GET /api/hermes/config — the profile's current default model, if any. */
    fun defaultModel(profile: String): String? {
        val model = call("/api/hermes/config?profile=${enc(profile)}").optJSONObject("model")
        return model?.let { firstNonBlank(it, "default") }
    }

    /** POST /api/hermes/profiles/{name}/gateway/restart */
    fun restartGateway(profile: String) {
        call("/api/hermes/profiles/${enc(profile)}/gateway/restart", "POST", JSONObject())
    }

    /** POST /api/hermes/sessions/{id}/model */
    fun setSessionModel(sessionId: String, model: String, provider: String?) {
        val body = JSONObject().put("model", model)
        if (!provider.isNullOrBlank()) body.put("provider", provider)
        call("/api/hermes/sessions/${enc(sessionId)}/model", "POST", body)
    }

    /** GET /api/hermes/sessions/conversations/{id}/messages — existing history. */
    fun messages(sessionId: String, humanOnly: Boolean = true): List<Message> {
        val path = "/api/hermes/sessions/conversations/${enc(sessionId)}/messages?humanOnly=$humanOnly"
        val array = call(path).optJSONArray("messages") ?: JSONArray()
        return (0 until array.length()).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            val content = item.optString("content")
            if (content.isBlank()) return@mapNotNull null
            Message(
                id = item.optString("id"),
                role = item.optString("role").ifBlank { "assistant" },
                content = content,
                timestamp = firstNonBlank(item, "timestamp", "created_at", "createdAt"),
            )
        }
    }

    // ── scheduled jobs ──────────────────────────────────────────────────

    /** The same profile-scoped list shown by Studio's Scheduled Jobs page. */
    fun cronJobs(profile: String): List<CronJob> {
        val array = call(
            path = "/api/hermes/jobs?include_disabled=true",
            profile = profile,
        ).optJSONArray("jobs") ?: JSONArray()
        return (0 until array.length()).mapNotNull { index ->
            array.optJSONObject(index)?.let(::parseCronJob)
        }
    }

    /** Fetches the raw job before editing so inherited model defaults stay inherited. */
    fun cronJob(profile: String, jobId: String): CronJob {
        val item = call(
            path = "/api/hermes/jobs/${enc(jobId)}",
            profile = profile,
        ).optJSONObject("job") ?: throw HermesException("The server returned no job")
        return parseCronJob(item) ?: throw HermesException("The job has no id")
    }

    fun createCronJob(profile: String, draft: CronJobDraft): CronJob {
        val result = call(
            path = "/api/hermes/jobs",
            method = "POST",
            body = draft.toJson(includeNullRepeat = false),
            profile = profile,
        )
        return parseJobResponse(result)
    }

    fun updateCronJob(profile: String, original: CronJob, draft: CronJobDraft): CronJob {
        val body = JSONObject()
        if (draft.name != original.name) body.put("name", draft.name)
        if (draft.schedule != original.scheduleInput) body.put("schedule", draft.schedule)
        if (draft.prompt != original.prompt) body.put("prompt", draft.prompt)
        if (draft.deliver != original.deliver) body.put("deliver", draft.deliver)
        if (draft.skills != original.skills) {
            body.put("skills", JSONArray().apply { draft.skills.forEach(::put) })
        }
        if (draft.repeatTimes != original.repeatTimes) {
            body.put("repeat", draft.repeatTimes ?: JSONObject.NULL)
        }
        if (draft.model.orEmpty() != original.model.orEmpty()) {
            body.put("model", draft.model?.takeIf { it.isNotBlank() } ?: JSONObject.NULL)
        }
        if (draft.provider.orEmpty() != original.provider.orEmpty()) {
            body.put("provider", draft.provider?.takeIf { it.isNotBlank() } ?: JSONObject.NULL)
        }

        val result = call(
            path = "/api/hermes/jobs/${enc(original.id)}",
            method = "PATCH",
            body = body,
            profile = profile,
        )
        return parseJobResponse(result)
    }

    fun deleteCronJob(profile: String, jobId: String) {
        call("/api/hermes/jobs/${enc(jobId)}", "DELETE", profile = profile)
    }

    fun pauseCronJob(profile: String, jobId: String): CronJob = cronJobAction(profile, jobId, "pause")

    fun resumeCronJob(profile: String, jobId: String): CronJob = cronJobAction(profile, jobId, "resume")

    fun runCronJob(profile: String, jobId: String): CronJob = cronJobAction(profile, jobId, "run")

    /** Targets are generated by Studio from the profile's channel directory. */
    fun cronDeliveryTargets(profile: String): List<CronDeliveryTarget> {
        val array = call(
            path = "/api/hermes/jobs/delivery-targets",
            profile = profile,
        ).optJSONArray("targets") ?: JSONArray()
        return (0 until array.length()).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            val value = firstNonBlank(item, "value") ?: return@mapNotNull null
            CronDeliveryTarget(
                platform = firstNonBlank(item, "platform").orEmpty(),
                id = firstNonBlank(item, "id").orEmpty(),
                name = firstNonBlank(item, "name") ?: value,
                type = firstNonBlank(item, "type"),
                value = value,
            )
        }
    }

    /** Enabled Hermes skills that may be attached to a scheduled job. */
    fun cronSkills(profile: String): List<String> {
        val categories = call(
            path = "/api/hermes/skills?profile=${enc(profile)}",
            profile = profile,
        ).optJSONArray("categories") ?: JSONArray()
        val names = linkedSetOf<String>()
        for (categoryIndex in 0 until categories.length()) {
            val skills = categories.optJSONObject(categoryIndex)?.optJSONArray("skills") ?: continue
            for (skillIndex in 0 until skills.length()) {
                val item = skills.optJSONObject(skillIndex) ?: continue
                if (item.has("enabled") && !item.optBoolean("enabled", true)) continue
                firstNonBlank(item, "name")?.let(names::add)
            }
        }
        return names.sorted()
    }

    fun cronRuns(profile: String, jobId: String): List<CronRun> {
        val result = call(
            path = "/api/cron-history?jobId=${enc(jobId)}",
            profile = profile,
        )
        val array = result.optJSONArray("runs") ?: JSONArray()
        return (0 until array.length()).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            val id = firstNonBlank(item, "jobId") ?: return@mapNotNull null
            val fileName = firstNonBlank(item, "fileName") ?: return@mapNotNull null
            CronRun(
                jobId = id,
                fileName = fileName,
                runTime = firstNonBlank(item, "runTime").orEmpty(),
                size = item.optLong("size", 0L),
                hasOutput = item.optBoolean("hasOutput", true),
                synthetic = item.optBoolean("synthetic", false),
                runCount = item.optInt("runCount").takeIf { item.has("runCount") && !item.isNull("runCount") },
                status = firstNonBlank(item, "status"),
                error = firstNonBlank(item, "error"),
            )
        }
    }

    fun cronRun(profile: String, run: CronRun): CronRunDetail {
        val result = call(
            path = "/api/cron-history/${enc(run.jobId)}/${enc(run.fileName)}",
            profile = profile,
        )
        return CronRunDetail(
            jobId = firstNonBlank(result, "jobId") ?: run.jobId,
            fileName = firstNonBlank(result, "fileName") ?: run.fileName,
            runTime = firstNonBlank(result, "runTime") ?: run.runTime,
            content = result.optString("content"),
        )
    }

    /** GET /api/hermes/group-chat/rooms */
    fun rooms(): List<Room> {
        val array = call("/api/hermes/group-chat/rooms").optJSONArray("rooms") ?: JSONArray()
        return (0 until array.length()).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            val id = firstNonBlank(item, "id", "roomId", "room_id") ?: return@mapNotNull null
            Room(
                id = id,
                name = firstNonBlank(item, "name", "title") ?: id.take(8),
                agentCount = optionalCount(item, "agentCount", "agents"),
                memberCount = optionalCount(item, "memberCount", "members"),
                updatedAt = firstNonBlank(item, "updatedAt", "updated_at", "lastMessageAt"),
            )
        }
    }

    /** GET /api/hermes/group-chat/rooms/{id} — room detail plus recent messages. */
    fun room(roomId: String, limit: Int = 80): RoomDetail {
        val result = call("/api/hermes/group-chat/rooms/${enc(roomId)}?limit=$limit&offset=0")
        val roomObject = result.optJSONObject("room")
        val name = roomObject?.let { firstNonBlank(it, "name", "title") } ?: roomId
        val agents = result.optJSONArray("agents") ?: JSONArray()
        val agentNames = (0 until agents.length()).mapNotNull { index ->
            agents.optJSONObject(index)?.let { firstNonBlank(it, "name", "profile", "agentId") }
        }
        val array = result.optJSONArray("messages") ?: JSONArray()
        val messages = (0 until array.length()).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            val content = item.optString("content")
            if (content.isBlank()) return@mapNotNull null
            RoomMessage(
                id = item.optString("id"),
                sender = firstNonBlank(item, "senderName", "sender_name", "senderId") ?: "?",
                content = content,
                isAgent = item.optString("role") == "assistant",
                timestamp = firstNonBlank(item, "timestamp", "created_at", "createdAt"),
            )
        }
        return RoomDetail(id = roomId, name = name, agents = agentNames, messages = messages)
    }

    private fun multipart(
        path: String,
        field: String,
        bytes: ByteArray,
        filename: String,
        mime: String,
        fields: Map<String, String> = emptyMap(),
    ): JSONObject {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM).apply {
            fields.forEach { (name, value) -> addFormDataPart(name, value) }
            addFormDataPart(field, filename, bytes.toRequestBody(mime.toMediaType()))
        }.build()
        val builder = Request.Builder().url(url(path)).post(body)
        if (token.isNotBlank()) builder.header("Authorization", "Bearer $token")
        builder.header("Accept", "application/json")

        client.newCall(builder.build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val detail = errorDetail(text)
                throw HermesException(
                    if (detail.isNullOrBlank()) "HTTP ${response.code}" else "HTTP ${response.code}: $detail",
                    statusCode = response.code,
                )
            }
            return runCatching { JSONObject(text) }.getOrElse { JSONObject() }
        }
    }

    /** POST /upload — stores the file under the profile upload dir and returns its path. */
    fun upload(profile: String, bytes: ByteArray, filename: String, mime: String): Upload {
        val result = multipart("/upload?profile=${enc(profile)}", "files", bytes, filename, mime)
        val files = result.optJSONArray("files") ?: JSONArray()
        val first = files.optJSONObject(0) ?: throw HermesException("Upload returned no file")
        return Upload(
            name = first.optString("name").ifBlank { filename },
            path = first.optString("path"),
            mime = mime,
        )
    }

    /**
     * POST /api/hermes/stt/transcribe — turns a recording into text with the
     * profile's configured provider, the same call the web composer makes.
     */
    fun transcribe(profile: String, bytes: ByteArray, filename: String, mime: String): String {
        val provider = activeSttProvider(profile)
        val result = multipart(
            path = "/api/hermes/stt/transcribe?profile=${enc(profile)}",
            field = "audio",
            bytes = bytes,
            filename = filename,
            mime = mime,
            fields = provider?.let { mapOf("provider" to it) }.orEmpty(),
        )
        return firstNonBlank(result, "text", "transcript", "output")
            ?: throw HermesException("The provider returned no text")
    }

    /**
     * Current Studio versions require the selected provider in the multipart
     * request. A 404 means an older server, whose transcribe route inferred it.
     */
    private fun activeSttProvider(profile: String): String? {
        val status = try {
            call("/api/hermes/stt/profile-status?profile=${enc(profile)}")
        } catch (failure: HermesException) {
            if (failure.statusCode == 404) return null
            throw failure
        }
        val provider = firstNonBlank(status, "activeProvider")
        if (status.optBoolean("configured", false) && provider != null && provider != "browser") return provider
        val reason = firstNonBlank(status, "reason") ?: "no server-backed STT provider is configured"
        throw HermesException("STT unavailable: $reason", statusCode = 409)
    }

    /**
     * POST /api/chat-run/runs — run one turn and wait for the final answer.
     *
     * This is the REST wrapper the server puts in front of its Socket.IO chat
     * channel, so a mobile client gets a complete reply without speaking the
     * streaming protocol.
     */
    fun sendMessage(
        profile: String,
        input: String,
        sessionId: String?,
        attachments: List<Upload> = emptyList(),
        reasoningEffort: String? = null,
        model: String? = null,
        provider: String? = null,
    ): ChatReply {
        // Studio sends either a plain string or an array of content blocks; the
        // block form is what carries images and files.
        val payload: Any = if (attachments.isEmpty()) {
            input
        } else {
            JSONArray().apply {
                if (input.isNotBlank()) {
                    put(JSONObject().put("type", "text").put("text", input))
                }
                attachments.forEach { file ->
                    put(
                        JSONObject()
                            .put("type", if (file.mime.startsWith("image/")) "image" else "file")
                            .put("name", file.name)
                            .put("path", file.path)
                            .put("media_type", file.mime),
                    )
                }
            }
        }

        val body = JSONObject()
            .put("input", payload)
            .put("profile", profile)
            .put("timeout_ms", 240_000)
        if (!sessionId.isNullOrBlank()) body.put("session_id", sessionId)
        if (!reasoningEffort.isNullOrBlank()) body.put("reasoning_effort", reasoningEffort)
        if (!model.isNullOrBlank()) body.put("model", model)
        if (!provider.isNullOrBlank()) body.put("provider", provider)

        val result = call("/api/chat-run/runs", "POST", body)
        val failure = result.optString("error").takeIf { it.isNotBlank() }
        val output = firstNonBlank(result, "output", "text", "message").orEmpty()
        return ChatReply(
            output = output,
            reasoning = firstNonBlank(result, "reasoning"),
            sessionId = firstNonBlank(result, "session_id", "sessionId") ?: sessionId,
            error = failure ?: if (output.isBlank()) "The run finished without any output" else null,
        )
    }

    /**
     * Fetches a static file the server publishes next to the web UI, such as
     * /logo.png. Returns null instead of throwing: branding is decoration, and a
     * server that does not serve it must not break a launch.
     */
    fun asset(path: String): ByteArray? = runCatching {
        val builder = Request.Builder().url(url(path)).get()
        if (token.isNotBlank()) builder.header("Authorization", "Bearer $token")
        client.newCall(builder.build()).execute().use { response ->
            if (!response.isSuccessful) return null
            response.body?.bytes()
        }
    }.getOrNull()

    private fun cronJobAction(profile: String, jobId: String, action: String): CronJob {
        val result = call(
            path = "/api/hermes/jobs/${enc(jobId)}/$action",
            method = "POST",
            body = JSONObject(),
            profile = profile,
        )
        return parseJobResponse(result)
    }

    private fun parseJobResponse(result: JSONObject): CronJob {
        val item = result.optJSONObject("job") ?: throw HermesException("The server returned no job")
        return parseCronJob(item) ?: throw HermesException("The job has no id")
    }

    private fun parseCronJob(item: JSONObject): CronJob? {
        val id = firstNonBlank(item, "job_id", "id") ?: return null
        val scheduleValue = item.opt("schedule")
        val scheduleInput = when (scheduleValue) {
            is String -> scheduleValue
            is JSONObject -> when (scheduleValue.optString("kind")) {
                "cron" -> firstNonBlank(scheduleValue, "expr", "display")
                "once" -> firstNonBlank(scheduleValue, "run_at", "display")
                "interval" -> firstNonBlank(scheduleValue, "display")
                    ?: scheduleValue.optInt("minutes", 0).takeIf { it > 0 }?.let { "every ${it}m" }
                else -> firstNonBlank(scheduleValue, "expr", "run_at", "display")
            }
            else -> null
        }.orEmpty()
        val scheduleDisplay = firstNonBlank(item, "schedule_display")
            ?: (scheduleValue as? JSONObject)?.let { firstNonBlank(it, "display", "expr", "run_at") }
            ?: scheduleInput

        val repeat = item.optJSONObject("repeat")
        val skills = item.optJSONArray("skills")?.let { array ->
            (0 until array.length()).mapNotNull { index ->
                array.optString(index).takeIf { it.isNotBlank() }
            }
        } ?: firstNonBlank(item, "skill")?.let(::listOf).orEmpty()

        return CronJob(
            id = id,
            name = firstNonBlank(item, "name") ?: id,
            prompt = firstNonBlank(item, "prompt").orEmpty(),
            promptPreview = firstNonBlank(item, "prompt_preview"),
            skills = skills,
            model = firstNonBlank(item, "model"),
            provider = firstNonBlank(item, "provider"),
            scheduleInput = scheduleInput.ifBlank { scheduleDisplay },
            scheduleDisplay = scheduleDisplay,
            repeatTimes = repeat?.optInt("times")?.takeIf { repeat.has("times") && !repeat.isNull("times") },
            repeatCompleted = repeat?.optInt("completed", 0) ?: 0,
            repeatLabel = (item.opt("repeat") as? String)?.takeIf { it.isNotBlank() },
            enabled = item.optBoolean("enabled", true),
            state = firstNonBlank(item, "state") ?: if (item.optBoolean("enabled", true)) "scheduled" else "paused",
            createdAt = firstNonBlank(item, "created_at"),
            nextRunAt = firstNonBlank(item, "next_run_at"),
            lastRunAt = firstNonBlank(item, "last_run_at"),
            lastStatus = firstNonBlank(item, "last_status"),
            lastError = firstNonBlank(item, "last_error"),
            deliver = firstNonBlank(item, "deliver") ?: "local",
            lastDeliveryError = firstNonBlank(item, "last_delivery_error"),
        )
    }

    private fun enc(value: String): String = java.net.URLEncoder.encode(value, "UTF-8")

    private fun strings(array: JSONArray?): List<String> = array?.let { values ->
        (0 until values.length()).mapNotNull { index ->
            values.optString(index).takeIf { it.isNotBlank() }
        }
    }.orEmpty()

    private fun parseManagedUsers(array: JSONArray?): List<ManagedUser> = array?.let { users ->
        (0 until users.length()).mapNotNull { index ->
            val item = users.optJSONObject(index) ?: return@mapNotNull null
            ManagedUser(
                id = item.optInt("id", -1),
                username = item.optString("username"),
                role = item.optString("role").ifBlank { "admin" },
                status = item.optString("status").ifBlank { "active" },
                profiles = strings(item.optJSONArray("profiles")),
                defaultProfile = firstNonBlank(item, "default_profile"),
                lastLoginAt = item.optLong("last_login_at", 0).takeIf { it > 0 },
            ).takeIf { it.id >= 0 && it.username.isNotBlank() }
        }
    }.orEmpty()

    private fun errorDetail(text: String): String? = runCatching {
        when (val error = JSONObject(text).opt("error")) {
            is String -> error
            is JSONObject -> firstNonBlank(error, "message", "detail") ?: error.toString()
            null, JSONObject.NULL -> null
            else -> error.toString()
        }
    }.getOrNull()

    private fun optionalCount(source: JSONObject, key: String, arrayKey: String): Int? {
        if (source.has(key) && !source.isNull(key)) return source.optInt(key)
        return source.optJSONArray(arrayKey)?.length()
    }

    private fun firstNonBlank(source: JSONObject, vararg keys: String): String? {
        for (key in keys) {
            val value = source.optString(key)
            if (value.isNotBlank() && value != "null") return value
        }
        return null
    }
}

class HermesException(message: String, val statusCode: Int? = null) : Exception(message)

data class CronJob(
    val id: String,
    val name: String,
    val prompt: String,
    val promptPreview: String?,
    val skills: List<String>,
    val model: String?,
    val provider: String?,
    /** The value Studio puts back into its edit field, not just the friendly label. */
    val scheduleInput: String,
    val scheduleDisplay: String,
    val repeatTimes: Int?,
    val repeatCompleted: Int,
    val repeatLabel: String?,
    val enabled: Boolean,
    val state: String,
    val createdAt: String?,
    val nextRunAt: String?,
    val lastRunAt: String?,
    val lastStatus: String?,
    val lastError: String?,
    val deliver: String,
    val lastDeliveryError: String?,
)

data class CronJobDraft(
    val name: String,
    val schedule: String,
    val prompt: String,
    val deliver: String = "local",
    val skills: List<String> = emptyList(),
    val repeatTimes: Int? = null,
    val model: String? = null,
    val provider: String? = null,
) {
    internal fun toJson(includeNullRepeat: Boolean): JSONObject = JSONObject()
        .put("name", name)
        .put("schedule", schedule)
        .put("prompt", prompt)
        .put("deliver", deliver)
        .put("skills", JSONArray().apply { skills.forEach(::put) })
        .apply {
            if (repeatTimes != null) put("repeat", repeatTimes)
            else if (includeNullRepeat) put("repeat", JSONObject.NULL)
            if (!model.isNullOrBlank()) put("model", model)
            if (!provider.isNullOrBlank()) put("provider", provider)
        }
}

data class CronDeliveryTarget(
    val platform: String,
    val id: String,
    val name: String,
    val type: String?,
    val value: String,
)

data class CronRun(
    val jobId: String,
    val fileName: String,
    val runTime: String,
    val size: Long,
    val hasOutput: Boolean,
    val synthetic: Boolean,
    val runCount: Int?,
    val status: String?,
    val error: String?,
)

data class CronRunDetail(
    val jobId: String,
    val fileName: String,
    val runTime: String,
    val content: String,
)

data class Profile(
    val name: String,
    val model: String?,
    val active: Boolean,
    val gatewayStatus: String?,
    val avatar: AvatarSpec? = null,
)

data class SessionSummary(
    val id: String,
    val title: String,
    val model: String?,
    val provider: String? = null,
    val updatedAt: String?,
    val profile: String? = null,
)

data class ModelOption(
    val id: String,
    val provider: String,
)

data class Upload(
    val name: String,
    val path: String,
    val mime: String,
)

data class Message(
    val id: String,
    val role: String,
    val content: String,
    val timestamp: String?,
) {
    val fromUser: Boolean get() = role == "user"
}

data class Room(
    val id: String,
    val name: String,
    val agentCount: Int?,
    val memberCount: Int?,
    val updatedAt: String?,
)

data class RoomMessage(
    val id: String,
    val sender: String,
    val content: String,
    val isAgent: Boolean,
    val timestamp: String?,
)

data class RoomDetail(
    val id: String,
    val name: String,
    val agents: List<String>,
    val messages: List<RoomMessage>,
)

data class AgentSettings(
    val maxTurns: Int?,
    val gatewayTimeout: Int?,
    val restartDrainTimeout: Int?,
    val toolEnforcement: String,
)

data class AutoStartPolicy(
    val enabled: Boolean,
    /** null means every discovered profile. */
    val include: List<String>?,
    val exclude: List<String>,
    val management: String = "per_profile",
)

data class CurrentUser(
    val id: Int,
    val username: String,
    val role: String,
    val status: String,
    val lastLoginAt: Long?,
    val avatar: String?,
)

data class LockedIp(
    val ip: String,
    val type: String,
    val failures: Int,
    val lockedUntil: Long,
)

data class ManagedUser(
    val id: Int,
    val username: String,
    val role: String,
    val status: String,
    val profiles: List<String>,
    val defaultProfile: String?,
    val lastLoginAt: Long?,
)

data class ManagedUsers(val users: List<ManagedUser>, val profiles: List<String>)

data class ManagedUserDraft(
    val username: String,
    val password: String,
    val role: String,
    val status: String,
    val profiles: List<String>,
) {
    internal fun toJson(includeEmptyPassword: Boolean): JSONObject = JSONObject()
        .put("username", username)
        .put("role", role)
        .put("status", status)
        .put("profiles", JSONArray().apply { profiles.forEach(::put) })
        .put("defaultProfile", profiles.firstOrNull() ?: JSONObject.NULL)
        .apply { if (password.isNotBlank() || includeEmptyPassword) put("password", password) }
}

data class StudioSettings(
    val display: DisplaySettings,
    val proxy: ProxySettings,
    val memory: MemorySettings,
    val compression: CompressionSettings,
    val session: SessionSettings,
    val privacy: PrivacySettings,
)

data class DisplaySettings(
    val streaming: Boolean,
    val compact: Boolean,
    val showReasoning: Boolean,
    val showCost: Boolean,
    val inlineDiffs: Boolean,
    val bellOnComplete: Boolean,
    val notifyOnComplete: Boolean,
    val chatInputHeight: Int?,
)

data class ProxySettings(val https: String, val http: String, val all: String, val noProxy: String)

data class MemorySettings(
    val enabled: Boolean,
    val userProfileEnabled: Boolean,
    val memoryCharLimit: Int,
    val userCharLimit: Int,
    val writeApproval: Boolean,
)

data class CompressionSettings(
    val enabled: Boolean,
    val threshold: Double,
    val targetRatio: Double,
    val protectLast: Int,
    val protectFirst: Int,
)

data class SessionSettings(
    val approvalsMode: String,
    val skillsWriteApproval: Boolean,
    val resetMode: String,
    val idleMinutes: Int,
    val atHour: Int,
)

data class PrivacySettings(val redactPii: Boolean)

data class ModelProvider(
    val id: String,
    val label: String,
    val builtin: Boolean,
    val configured: Boolean,
    val baseUrl: String,
    val modelCount: Int,
)

data class ChannelStatus(
    val platform: String,
    val enabled: Boolean,
    val configured: Boolean,
)

data class ServerConfig(
    val defaultModel: String?,
    val gatewayAutoStart: Boolean,
    val channels: List<ChannelStatus>,
)

data class ChatReply(
    val output: String,
    val reasoning: String?,
    val sessionId: String?,
    val error: String?,
)
