package us.i3u.hermesstudio

import io.socket.client.IO
import io.socket.client.Socket
import io.socket.engineio.client.transports.WebSocket
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URLEncoder

/** What a run tells us while it is happening. */
sealed interface RunEvent {
    data class Text(val delta: String) : RunEvent
    data class Reasoning(val delta: String) : RunEvent
    data class Tool(val name: String) : RunEvent
    data class Done(val output: String, val reasoning: String) : RunEvent
    data class RequiresAction(val kind: RequiredAction) : RunEvent
    data class Failed(val error: String, val retryableTransport: Boolean) : RunEvent
}

enum class RequiredAction { Approval, Clarification }

/**
 * The streaming half of the chat API.
 *
 * `POST /api/chat-run/runs` is the server's own wrapper around this socket: it
 * connects, waits for the whole answer, and returns it. Talking to /chat-run
 * directly is the same conversation, except the words arrive as they are
 * written, and the run can be stopped part-way.
 */
class ChatSocket(
    private var baseUrl: String,
    private var token: String,
) {
    private var socket: Socket? = null

    fun update(baseUrl: String, token: String) {
        this.baseUrl = baseUrl.trimEnd('/')
        this.token = token
    }

    /** Stops the run the server is streaming for this session. */
    fun abort(sessionId: String) {
        runCatching { socket?.emit("abort", JSONObject().put("session_id", sessionId)) }
    }

    fun run(
        profile: String,
        sessionId: String,
        input: String,
        attachments: List<Upload>,
        reasoningEffort: String?,
        model: String?,
        provider: String?,
    ): Flow<RunEvent> = callbackFlow {
        val payload = JSONObject()
            .put("input", contentFor(input, attachments))
            .put("profile", profile)
            .put("session_id", sessionId)
        if (!reasoningEffort.isNullOrBlank()) payload.put("reasoning_effort", reasoningEffort)
        if (!model.isNullOrBlank()) payload.put("model", model)
        if (!provider.isNullOrBlank()) payload.put("provider", provider)

        val options = IO.Options.builder()
            .setForceNew(true)
            .setReconnection(false)
            .setTransports(arrayOf(WebSocket.NAME))
            .setAuth(mapOf("token" to token))
            .setQuery("profile=" + URLEncoder.encode(profile, "UTF-8"))
            .setTimeout(30_000)
            .build()

        val live = IO.socket(URI.create(baseUrl.trimEnd('/') + "/chat-run"), options)
        socket = live
        var runStarted = false
        var terminal = false

        fun text(args: Array<out Any?>, key: String): String =
            (args.firstOrNull() as? JSONObject)?.optString(key).orEmpty()

        live.on(Socket.EVENT_CONNECT) { live.emit("run", payload) }
        live.on("run.started") { runStarted = true }
        live.on("message.delta") { args ->
            val delta = text(args, "delta")
            if (delta.isNotEmpty()) {
                runStarted = true
                trySend(RunEvent.Text(delta))
            }
        }
        // Some models report thinking under one name, some under the other.
        listOf("reasoning.delta", "thinking.delta").forEach { event ->
            live.on(event) { args ->
                val delta = text(args, "delta")
                if (delta.isNotEmpty()) {
                    runStarted = true
                    trySend(RunEvent.Reasoning(delta))
                }
            }
        }
        live.on("tool.started") { args ->
            runStarted = true
            val name = (args.firstOrNull() as? JSONObject)?.let {
                it.optString("name").ifBlank { it.optString("tool") }
            }.orEmpty()
            if (name.isNotBlank()) trySend(RunEvent.Tool(name))
        }
        live.on("run.completed") { args ->
            terminal = true
            val event = args.firstOrNull() as? JSONObject
            trySend(
                RunEvent.Done(
                    output = event?.optString("output").orEmpty(),
                    reasoning = event?.optString("reasoning").orEmpty(),
                ),
            )
            close()
        }
        live.on("run.failed") { args ->
            terminal = true
            val event = args.firstOrNull() as? JSONObject
            val message = event?.optString("error").orEmpty()
            trySend(RunEvent.Failed(message.ifBlank { "run failed" }, retryableTransport = false))
            close()
        }
        // A run that needs a human decision cannot be answered from here yet, so
        // it is reported rather than left hanging.
        live.on("approval.requested") {
            terminal = true
            trySend(RunEvent.RequiresAction(RequiredAction.Approval))
            close()
        }
        live.on("clarify.requested") {
            terminal = true
            trySend(RunEvent.RequiresAction(RequiredAction.Clarification))
            close()
        }
        live.on(Socket.EVENT_CONNECT_ERROR) { args ->
            terminal = true
            val detail = args.firstOrNull()?.toString().orEmpty()
            trySend(RunEvent.Failed(detail.ifBlank { "connect_error" }, retryableTransport = true))
            close()
        }
        live.on(Socket.EVENT_DISCONNECT) {
            if (!terminal) {
                trySend(RunEvent.Failed("disconnected", retryableTransport = !runStarted))
            }
            close()
        }

        live.connect()

        awaitClose {
            live.off()
            live.disconnect()
            if (socket === live) socket = null
        }
    }

    /** Studio accepts a bare string, or blocks when files ride along. */
    private fun contentFor(input: String, attachments: List<Upload>): Any =
        if (attachments.isEmpty()) {
            input
        } else {
            JSONArray().apply {
                if (input.isNotBlank()) put(JSONObject().put("type", "text").put("text", input))
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
}
