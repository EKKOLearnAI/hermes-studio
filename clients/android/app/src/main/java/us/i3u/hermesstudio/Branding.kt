package us.i3u.hermesstudio

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * The mark shown on the launch screen and in the chat header.
 *
 * The Studio artwork is not shipped inside the APK — it is pulled from the
 * server the user connects to, which is also what keeps it in step with a
 * Studio whose logo has been replaced. A picture chosen on the device always
 * wins over it.
 */
object AppLogo {

    private const val PX = 256
    private const val REFRESH_AFTER_MS = 7L * 24 * 60 * 60 * 1000

    var image by mutableStateOf<ImageBitmap?>(null)
        private set

    var isCustom by mutableStateOf(false)
        private set

    var hasServerCopy by mutableStateOf(false)
        private set

    /** What the files on disk say; assembled off the main thread, applied on it. */
    private data class Snapshot(
        val image: ImageBitmap?,
        val isCustom: Boolean,
        val hasServerCopy: Boolean,
    )

    private fun dir(context: Context) = File(context.filesDir, "branding").apply { mkdirs() }

    private fun customFile(context: Context) = File(dir(context), "logo-custom.png")

    private fun serverFile(context: Context) = File(dir(context), "logo-server.png")

    /** Reads the cached mark, so a launch shows it without waiting for the network. */
    suspend fun load(context: Context) {
        publish(withContext(Dispatchers.IO) { read(context) })
    }

    /** Pulls /logo.png from the connected Studio, at most once a week. */
    suspend fun syncFromServer(context: Context, api: HermesApi, force: Boolean = false) {
        val next = withContext(Dispatchers.IO) {
            val server = serverFile(context)
            val fresh = server.exists() &&
                System.currentTimeMillis() - server.lastModified() < REFRESH_AFTER_MS
            if (fresh && !force) return@withContext null
            val bytes = api.asset("/logo.png") ?: return@withContext null
            val bitmap = decode(bytes) ?: return@withContext null
            write(server, bitmap)
            read(context)
        } ?: return
        publish(next)
    }

    suspend fun setCustom(context: Context, bytes: ByteArray): Boolean {
        val next = withContext(Dispatchers.IO) {
            val bitmap = decode(bytes) ?: return@withContext null
            write(customFile(context), bitmap)
            read(context)
        } ?: return false
        publish(next)
        return true
    }

    /** Drops the device picture and falls back to whatever the server serves. */
    suspend fun clearCustom(context: Context) {
        publish(
            withContext(Dispatchers.IO) {
                customFile(context).delete()
                read(context)
            },
        )
    }

    private fun read(context: Context): Snapshot {
        val custom = customFile(context)
        val server = serverFile(context)
        val shown = if (custom.exists()) custom else server
        return Snapshot(
            image = if (shown.exists()) decode(shown)?.asImageBitmap() else null,
            isCustom = custom.exists(),
            hasServerCopy = server.exists(),
        )
    }

    /**
     * Compose state has to be written from the main thread: a write from a
     * worker can land in a snapshot that was taken before the state existed,
     * which Compose rejects outright.
     */
    private suspend fun publish(snapshot: Snapshot) = withContext(Dispatchers.Main) {
        image = snapshot.image
        isCustom = snapshot.isCustom
        hasServerCopy = snapshot.hasServerCopy
    }

    private fun write(file: File, source: Bitmap) {
        val scaled = if (source.width <= PX && source.height <= PX) {
            source
        } else {
            val ratio = minOf(PX.toFloat() / source.width, PX.toFloat() / source.height)
            Bitmap.createScaledBitmap(
                source,
                (source.width * ratio).toInt().coerceAtLeast(1),
                (source.height * ratio).toInt().coerceAtLeast(1),
                true,
            )
        }
        runCatching {
            file.outputStream().use { scaled.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    private fun decode(file: File): Bitmap? =
        runCatching { BitmapFactory.decodeFile(file.absolutePath) }.getOrNull()

    private fun decode(bytes: ByteArray): Bitmap? =
        runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }.getOrNull()
}

/** Rounded app mark: the Studio logo once it is known, a neutral glyph before. */
@Composable
fun AppMark(size: Dp = 76.dp, corner: Dp = size / 3.4f) {
    val logo = AppLogo.image
    Box(
        modifier = Modifier
            .size(size)
            .clip(RoundedCornerShape(corner))
            .background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        if (logo != null) {
            Image(
                bitmap = logo,
                contentDescription = null,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
            )
        } else {
            Icon(
                Icons.Filled.AutoAwesome,
                contentDescription = null,
                modifier = Modifier.size(size / 2.2f),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
