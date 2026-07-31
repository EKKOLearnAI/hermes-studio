package us.i3u.hermesstudio

import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.engineio.client.transports.WebSocket
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import org.json.JSONObject
import java.net.URI

/** What the room socket reports while it is open. */
sealed interface RoomEvent {
    data object Connected : RoomEvent
    data object Dropped : RoomEvent
    data class Failed(val error: String) : RoomEvent
    data class Posted(val message: RoomMessage) : RoomEvent
}

/**
 * A room, live.
 *
 * Group chat has no REST endpoint for posting — Studio's own rooms run entirely
 * over the /group-chat namespace, so joining and speaking both happen here. What
 * the REST API gives us is the history; this gives us everything after it.
 */
class GroupSocket(
    private var baseUrl: String,
    private var token: String,
) {
    private var socket: Socket? = null
    private var joinedRoom: String? = null

    fun update(baseUrl: String, token: String) {
        this.baseUrl = baseUrl.trimEnd('/')
        this.token = token
    }

    /** Joins a room and emits every message that arrives while it is open. */
    fun join(roomId: String, memberName: String): Flow<RoomEvent> = callbackFlow {
        val options = IO.Options.builder()
            .setForceNew(true)
            .setReconnection(true)
            .setTransports(arrayOf(WebSocket.NAME))
            .setAuth(mapOf("token" to token))
            .setTimeout(30_000)
            .build()

        val live = IO.socket(URI.create(baseUrl.trimEnd('/') + "/group-chat"), options)
        socket = live
        joinedRoom = roomId

        live.on(Socket.EVENT_CONNECT) {
            live.emit(
                "join",
                JSONObject().put("roomId", roomId).put("name", memberName),
                Ack { args ->
                    val error = (args.firstOrNull() as? JSONObject)?.optString("error").orEmpty()
                    if (error.isBlank()) trySend(RoomEvent.Connected)
                    else {
                        trySend(RoomEvent.Failed(error))
                        close()
                    }
                },
            )
        }
        live.on(Socket.EVENT_DISCONNECT) { trySend(RoomEvent.Dropped) }
        live.on(Socket.EVENT_CONNECT_ERROR) { trySend(RoomEvent.Dropped) }
        live.on("message") { args ->
            val event = args.firstOrNull() as? JSONObject ?: return@on
            val content = event.optString("content")
            if (content.isBlank()) return@on
            trySend(
                RoomEvent.Posted(
                    RoomMessage(
                        id = event.optString("id"),
                        sender = event.optString("senderName").ifBlank { event.optString("senderId") },
                        content = content,
                        isAgent = event.optString("role") == "assistant",
                        timestamp = event.optString("timestamp").takeIf { it.isNotBlank() },
                    ),
                ),
            )
        }

        live.connect()

        awaitClose {
            live.off()
            live.disconnect()
            if (socket === live) {
                socket = null
                joinedRoom = null
            }
        }
    }

    /** Posts into the room this socket is joined to. */
    fun post(
        roomId: String,
        text: String,
        senderName: String,
        onResult: (error: String?) -> Unit = {},
    ): Boolean {
        val live = socket ?: return false
        if (!live.connected()) return false
        live.emit(
            "message",
            JSONObject()
                .put("roomId", roomId)
                .put("content", text)
                .put("senderName", senderName),
            Ack { args ->
                val error = (args.firstOrNull() as? JSONObject)?.optString("error").orEmpty()
                onResult(error.ifBlank { null })
            },
        )
        return true
    }
}
