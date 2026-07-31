package us.i3u.hermesstudio

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Fixtures from the current Hermes Studio HTTP contracts.
 *
 * These tests deliberately exercise the real request/response boundary so a
 * server-side field rename cannot silently turn into an empty label or a
 * request that looks successful in the UI but is rejected by Studio.
 */
class HermesApiContractTest {
    private lateinit var server: MockWebServer
    private lateinit var api: HermesApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = HermesApi(server.url("/").toString().trimEnd('/'), "saved-token")
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `auth me reads the nested current user and sends the token`() {
        enqueue("""{"user":{"id":17,"username":"owner","role":"super_admin"}}""")

        assertEquals("owner", api.verifyToken())
        val request = server.takeRequest()
        assertEquals("/api/auth/me", request.path)
        assertEquals("Bearer saved-token", request.getHeader("Authorization"))
    }

    @Test
    fun `session summaries use Studio recency and provider fields`() {
        enqueue(
            """
            {
              "sessions": [{
                "id": "session-1",
                "title": "Contract check",
                "profile": "manager",
                "provider": "openrouter",
                "model": "anthropic/claude-sonnet-4",
                "started_at": 1710000000,
                "last_active": 1710001234
              }]
            }
            """.trimIndent(),
        )

        val session = api.sessions("manager").single()

        assertEquals("1710001234", session.updatedAt)
        assertEquals("openrouter", session.provider)
        assertEquals("/api/hermes/sessions?profile=manager&limit=80", server.takeRequest().path)
    }

    @Test
    fun `room list does not invent zero counts absent from Studio`() {
        enqueue("""{"rooms":[{"id":"room-1","name":"Planning","inviteCode":"ABC234"}]}""")

        val room = api.rooms().single()

        assertNull(room.agentCount)
        assertNull(room.memberCount)
    }

    @Test
    fun `transcription discovers and posts the active provider`() {
        enqueue("""{"profile":"manager","configured":true,"activeProvider":"openai","reason":null}""")
        enqueue("""{"text":"hello from audio","provider":"openai","model":"whisper-1"}""")

        val text = api.transcribe("manager", byteArrayOf(1, 2, 3), "voice.m4a", "audio/mp4")

        assertEquals("hello from audio", text)
        assertEquals("/api/hermes/stt/profile-status?profile=manager", server.takeRequest().path)
        val upload = server.takeRequest()
        assertEquals("/api/hermes/stt/transcribe?profile=manager", upload.path)
        val multipart = upload.body.readUtf8()
        assertTrue(multipart.contains("name=\"provider\""))
        assertTrue(multipart.contains("\r\n\r\nopenai\r\n"))
        assertTrue(multipart.contains("name=\"audio\"; filename=\"voice.m4a\""))
    }

    @Test
    fun `transcription remains compatible with servers before profile status`() {
        enqueue("""{"error":"Not found"}""", code = 404)
        enqueue("""{"text":"legacy transcript"}""")

        assertEquals(
            "legacy transcript",
            api.transcribe("default", byteArrayOf(7), "voice.m4a", "audio/mp4"),
        )

        server.takeRequest()
        val multipart = server.takeRequest().body.readUtf8()
        assertFalse(multipart.contains("name=\"provider\""))
    }

    @Test
    fun `first run model and provider reach the REST fallback`() {
        enqueue("""{"ok":true,"output":"done","session_id":"session-1"}""")

        api.sendMessage(
            profile = "manager",
            input = "hello",
            sessionId = "session-1",
            reasoningEffort = "high",
            model = "anthropic/claude-sonnet-4",
            provider = "openrouter",
        )

        val body = JSONObject(server.takeRequest().body.readUtf8())
        assertEquals("anthropic/claude-sonnet-4", body.getString("model"))
        assertEquals("openrouter", body.getString("provider"))
        assertEquals("high", body.getString("reasoning_effort"))
    }

    @Test
    fun `agent settings added in v011 follow the profile contract`() {
        enqueue(
            """
            {
              "agent": {
                "max_turns": 24,
                "gateway_timeout": 0,
                "restart_drain_timeout": 45,
                "tool_use_enforcement": "always"
              }
            }
            """.trimIndent(),
        )

        val settings = api.agentSettings("manager")

        assertEquals(24, settings.maxTurns)
        assertEquals(0, settings.gatewayTimeout)
        assertEquals(45, settings.restartDrainTimeout)
        assertEquals("always", settings.toolEnforcement)
        assertEquals(
            "/api/hermes/config?profile=manager&section=agent",
            server.takeRequest().path,
        )
    }

    @Test
    fun `all Studio setting sections are parsed and partial updates preserve the contract`() {
        enqueue(
            """
            {
              "display":{"streaming":true,"show_reasoning":false,"chat_input_height":112},
              "proxy":{"HTTPS_PROXY":"http://proxy:8080","NO_PROXY":"localhost"},
              "memory":{"memory_enabled":true,"user_profile_enabled":false,"memory_char_limit":3200,"user_char_limit":1800,"write_approval":true},
              "skills":{"write_approval":true},
              "compression":{"enabled":true,"threshold":0.65,"target_ratio":0.25,"protect_last_n":30,"protect_first_n":4},
              "session_reset":{"mode":"daily","idle_minutes":90,"at_hour":3},
              "approvals":{"mode":"manual"},
              "privacy":{"redact_pii":true}
            }
            """.trimIndent(),
        )

        val settings = api.studioSettings("manager")

        assertTrue(settings.display.streaming)
        assertFalse(settings.display.showReasoning)
        assertEquals(112, settings.display.chatInputHeight)
        assertEquals("http://proxy:8080", settings.proxy.https)
        assertEquals(3200, settings.memory.memoryCharLimit)
        assertTrue(settings.memory.writeApproval)
        assertEquals(0.65, settings.compression.threshold, 0.0001)
        assertEquals("daily", settings.session.resetMode)
        assertTrue(settings.session.skillsWriteApproval)
        assertTrue(settings.privacy.redactPii)
        assertEquals("/api/hermes/config?profile=manager", server.takeRequest().path)

        enqueue("""{"success":true}""")
        api.updateConfigSection("manager", "privacy", JSONObject().put("redact_pii", false))
        val update = server.takeRequest()
        assertEquals("PUT", update.method)
        assertEquals("/api/hermes/config?profile=manager", update.path)
        val body = JSONObject(update.body.readUtf8())
        assertEquals("privacy", body.getString("section"))
        assertFalse(body.getJSONObject("values").getBoolean("redact_pii"))
    }

    @Test
    fun `account security and user management follow auth endpoints`() {
        enqueue(
            """{"user":{"id":1,"username":"owner","role":"super_admin","status":"active","last_login_at":1710000000}}""",
        )
        val user = api.currentUser()
        assertEquals("owner", user.username)
        assertEquals("super_admin", user.role)

        enqueue(
            """{"users":[{"id":2,"username":"operator","role":"admin","status":"active","profiles":["manager"],"default_profile":"manager","last_login_at":null}],"profiles":["manager","default"]}""",
        )
        val managed = api.managedUsers()
        assertEquals(listOf("manager", "default"), managed.profiles)
        assertEquals(listOf("manager"), managed.users.single().profiles)

        enqueue("""{"users":[]}""")
        api.createManagedUser(
            ManagedUserDraft("new-admin", "secret1", "admin", "active", listOf("manager")),
        )
        val create = server.takeRequest()
        // Consume the two GETs made above before checking the create request.
        assertEquals("/api/auth/me", create.path)
        assertEquals("/api/auth/users", server.takeRequest().path)
        val createRequest = server.takeRequest()
        assertEquals("POST", createRequest.method)
        assertEquals("/api/auth/users", createRequest.path)
        val body = JSONObject(createRequest.body.readUtf8())
        assertEquals("manager", body.getJSONArray("profiles").getString(0))
        assertEquals("manager", body.getString("defaultProfile"))
    }

    @Test
    fun `account mutations keep Studio field names and lock query encoding`() {
        enqueue("""{"avatar":"{\"type\":\"image\",\"dataUrl\":\"data:image/png;base64,AQID\",\"seed\":\"owner\"}"}""")
        val fetchedAvatar = api.myAvatar("owner")
        assertEquals("image", fetchedAvatar.type)
        assertEquals("data:image/png;base64,AQID", fetchedAvatar.dataUrl)
        assertEquals("/api/auth/avatar", server.takeRequest().path)

        enqueue("""{"success":true}""")
        api.changePassword("old-pass", "new-pass")
        val password = server.takeRequest()
        assertEquals("/api/auth/change-password", password.path)
        assertEquals("old-pass", JSONObject(password.body.readUtf8()).getString("currentPassword"))

        enqueue("""{"success":true}""")
        api.changeUsername("old-pass", "new-owner")
        val username = server.takeRequest()
        assertEquals("new-owner", JSONObject(username.body.readUtf8()).getString("newUsername"))

        enqueue("""{"success":true}""")
        api.updateMyAvatar("data:image/png;base64,AQID")
        val avatar = JSONObject(server.takeRequest().body.readUtf8()).getString("avatar")
        assertEquals("image", JSONObject(avatar).getString("type"))

        enqueue("""{"success":true}""")
        api.resetMyAvatar()
        assertEquals(
            "default",
            JSONObject(server.takeRequest().body.readUtf8()).getJSONObject("avatar").getString("type"),
        )

        enqueue("""{"success":true}""")
        api.unlockIp("2001:db8::1")
        assertEquals("/api/auth/locked-ips?ip=2001%3Adb8%3A%3A1", server.takeRequest().path)
    }

    @Test
    fun `managed user edits omit an unchanged password and retain profile defaults`() {
        enqueue("""{"users":[]}""")
        api.updateManagedUser(
            7,
            ManagedUserDraft("operator", "", "admin", "disabled", listOf("research", "manager")),
        )

        val request = server.takeRequest()
        assertEquals("PUT", request.method)
        assertEquals("/api/auth/users/7", request.path)
        val body = JSONObject(request.body.readUtf8())
        assertFalse(body.has("password"))
        assertEquals("disabled", body.getString("status"))
        assertEquals("research", body.getString("defaultProfile"))
        assertEquals(2, body.getJSONArray("profiles").length())
    }

    @Test
    fun `model provider keys use credential pool ids and active profile`() {
        enqueue(
            """{"groups":[{"provider":"anthropic","label":"Anthropic","builtin":true,"base_url":"https://api.anthropic.com","api_key":"configured","models":["claude-opus-5"]},{"provider":"moa","models":["committee"]}]}""",
        )
        val provider = api.modelProviders("manager").single()
        assertEquals("anthropic", provider.id)
        assertTrue(provider.configured)
        assertEquals(1, provider.modelCount)
        assertEquals("/api/hermes/available-models?profile=manager", server.takeRequest().path)

        enqueue("""{"success":true}""")
        api.updateProviderApiKey("manager", "custom:router", "new-key")
        val update = server.takeRequest()
        assertEquals("PUT", update.method)
        assertEquals("/api/hermes/config/providers/custom%3Arouter?profile=manager", update.path)
        assertEquals("new-key", JSONObject(update.body.readUtf8()).getString("api_key"))
    }

    @Test
    fun `scheduled jobs use Studio contract and active profile header`() {
        enqueue(
            """
            {
              "jobs": [{
                "job_id": "daily-summary",
                "name": "Daily summary",
                "prompt": "Summarize the inbox",
                "skills": ["email"],
                "provider": "openrouter",
                "model": "anthropic/claude-sonnet-4",
                "schedule": {"kind":"cron","expr":"0 9 * * *","display":"Daily at 09:00"},
                "schedule_display": "Daily at 09:00",
                "repeat": {"times":8,"completed":2},
                "enabled": true,
                "state": "scheduled",
                "next_run_at": "2026-08-01T09:00:00Z",
                "deliver": "local"
              }]
            }
            """.trimIndent(),
        )

        val job = api.cronJobs("manager").single()

        assertEquals("daily-summary", job.id)
        assertEquals("0 9 * * *", job.scheduleInput)
        assertEquals("Daily at 09:00", job.scheduleDisplay)
        assertEquals(8, job.repeatTimes)
        assertEquals(2, job.repeatCompleted)
        assertEquals(listOf("email"), job.skills)
        val request = server.takeRequest()
        assertEquals("/api/hermes/jobs?include_disabled=true", request.path)
        assertEquals("manager", request.getHeader("X-Hermes-Profile"))
    }

    @Test
    fun `scheduled job create and patch send fields supported by Studio`() {
        enqueue(
            """{"job":{"job_id":"job-1","name":"Digest","prompt":"Check updates","schedule":"0 9 * * *","skills":["news"],"repeat":{"times":null,"completed":0},"enabled":true,"state":"scheduled","deliver":"local"}}""",
        )
        api.createCronJob(
            "manager",
            CronJobDraft(
                name = "Digest",
                schedule = "0 9 * * *",
                prompt = "Check updates",
                skills = listOf("news"),
            ),
        )

        val create = server.takeRequest()
        assertEquals("POST", create.method)
        assertEquals("/api/hermes/jobs", create.path)
        assertEquals("manager", create.getHeader("X-Hermes-Profile"))
        val createBody = JSONObject(create.body.readUtf8())
        assertEquals("0 9 * * *", createBody.getString("schedule"))
        assertEquals("news", createBody.getJSONArray("skills").getString(0))
        assertFalse(createBody.has("repeat"))

        val original = cronFixture(
            prompt = "Check updates",
            skills = listOf("news"),
            repeatTimes = 4,
            model = "old-model",
            provider = "old-provider",
        )
        enqueue(
            """{"job":{"job_id":"job-1","name":"Digest","prompt":"Check releases","schedule":"0 9 * * *","skills":[],"repeat":{"times":null,"completed":1},"enabled":true,"state":"scheduled","deliver":"local"}}""",
        )
        api.updateCronJob(
            "manager",
            original,
            CronJobDraft(
                name = original.name,
                schedule = original.scheduleInput,
                prompt = "Check releases",
                skills = emptyList(),
                repeatTimes = null,
            ),
        )

        val update = server.takeRequest()
        assertEquals("PATCH", update.method)
        assertEquals("/api/hermes/jobs/job-1", update.path)
        val updateBody = JSONObject(update.body.readUtf8())
        assertEquals("Check releases", updateBody.getString("prompt"))
        assertEquals(0, updateBody.getJSONArray("skills").length())
        assertTrue(updateBody.isNull("repeat"))
        assertTrue(updateBody.isNull("model"))
        assertTrue(updateBody.isNull("provider"))
        assertFalse(updateBody.has("name"))
        assertFalse(updateBody.has("schedule"))
    }

    @Test
    fun `cron history reads scheduler metadata runs and their output`() {
        enqueue(
            """{"runs":[{"jobId":"job 1","fileName":"__scheduler_metadata__.md","runTime":"2026-07-31 09:00:00","size":0,"hasOutput":false,"synthetic":true,"runCount":3,"status":"ok"}]}""",
        )
        val run = api.cronRuns("manager", "job 1").single()

        assertTrue(run.synthetic)
        assertFalse(run.hasOutput)
        assertEquals(3, run.runCount)
        val listRequest = server.takeRequest()
        assertEquals("/api/cron-history?jobId=job+1", listRequest.path)
        assertEquals("manager", listRequest.getHeader("X-Hermes-Profile"))

        enqueue(
            """{"jobId":"job 1","fileName":"__scheduler_metadata__.md","runTime":"2026-07-31 09:00:00","content":"# Scheduler run recorded"}""",
        )
        val detail = api.cronRun("manager", run)

        assertEquals("# Scheduler run recorded", detail.content)
        assertEquals(
            "/api/cron-history/job+1/__scheduler_metadata__.md",
            server.takeRequest().path,
        )
    }

    @Test
    fun `gateway auto start policy preserves include profiles and all mode`() {
        enqueue("""{"gatewayAutoStart":{"enabled":true,"include":["manager"],"exclude":["sandbox"],"management":"unified"}}""")

        val policy = api.autoStartPolicy()

        assertEquals(listOf("manager"), policy.include)
        assertEquals(listOf("sandbox"), policy.exclude)
        assertEquals("unified", policy.management)
        enqueue("""{"success":true}""")
        api.setAutoStartPolicy(policy.copy(include = null))

        val request = server.takeRequest()
        assertEquals("/api/hermes/config?section=gatewayAutoStart", request.path)
        val update = server.takeRequest()
        assertEquals("/api/hermes/config", update.path)
        val values = JSONObject(update.body.readUtf8()).getJSONObject("values")
        assertTrue(values.isNull("include"))
        assertEquals(true, values.getBoolean("enabled"))
        assertEquals("unified", values.getString("management"))
    }

    @Test
    fun `HTTP status remains available to session recovery`() {
        enqueue("""{"error":"Unauthorized"}""", code = 401)

        val failure = assertThrows(HermesException::class.java) { api.verifyToken() }

        assertEquals(401, failure.statusCode)
        assertTrue(failure.message.orEmpty().contains("Unauthorized"))
    }

    @Test
    fun `only authentication failures invalidate the saved session`() {
        assertTrue(HermesException("Unauthorized", 401).invalidatesSavedSession())
        assertTrue(HermesException("Forbidden", 403).invalidatesSavedSession())
        assertFalse(HermesException("Server error", 500).invalidatesSavedSession())
        assertFalse(java.net.SocketTimeoutException().invalidatesSavedSession())
    }

    private fun enqueue(body: String, code: Int = 200) {
        server.enqueue(
            MockResponse()
                .setResponseCode(code)
                .setHeader("Content-Type", "application/json")
                .setBody(body),
        )
    }

    private fun cronFixture(
        prompt: String,
        skills: List<String>,
        repeatTimes: Int?,
        model: String?,
        provider: String?,
    ) = CronJob(
        id = "job-1",
        name = "Digest",
        prompt = prompt,
        promptPreview = null,
        skills = skills,
        model = model,
        provider = provider,
        scheduleInput = "0 9 * * *",
        scheduleDisplay = "0 9 * * *",
        repeatTimes = repeatTimes,
        repeatCompleted = 0,
        repeatLabel = null,
        enabled = true,
        state = "scheduled",
        createdAt = null,
        nextRunAt = null,
        lastRunAt = null,
        lastStatus = null,
        lastError = null,
        deliver = "local",
        lastDeliveryError = null,
    )
}
