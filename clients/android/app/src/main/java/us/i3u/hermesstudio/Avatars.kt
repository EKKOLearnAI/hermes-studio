package us.i3u.hermesstudio

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.caverock.androidsvg.SVG
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * A profile picture as Studio describes it: either an uploaded image (inlined as
 * a data URL) or a Multiavatar generated from a seed.
 */
data class AvatarSpec(
    val type: String,
    val seed: String?,
    val dataUrl: String?,
    val updatedAt: Long,
) {
    companion object {
        fun from(json: JSONObject?): AvatarSpec? {
            if (json == null) return null
            val type = json.optString("type").ifBlank { return null }
            return AvatarSpec(
                type = type,
                seed = json.optString("seed").takeIf { it.isNotBlank() },
                dataUrl = json.optString("dataUrl").takeIf { it.isNotBlank() },
                updatedAt = json.optLong("updatedAt", 0L),
            )
        }
    }
}

/** What a cached bitmap was rendered from — a change here means "render again". */
private fun AvatarSpec?.fingerprintFor(profile: String): String = when {
    this == null -> "gen:$profile"
    type == "image" && !dataUrl.isNullOrBlank() -> "image:$updatedAt:${dataUrl.length}"
    else -> "gen:${seed ?: profile}"
}

/**
 * Renders and caches profile pictures on the device.
 *
 * Studio hands the avatar over on every profiles call, so the point of the cache
 * is that a picture is decoded (or generated) once and then read straight off
 * disk on the next launch, before the network has answered.
 */
object Avatars {

    private const val PX = 144

    private val images = mutableStateMapOf<String, ImageBitmap>()
    private val loaded = java.util.concurrent.ConcurrentHashMap<String, String>()

    fun of(profile: String): ImageBitmap? = images[profile]

    suspend fun ensure(context: Context, profile: String, spec: AvatarSpec?) {
        if (profile.isBlank()) return
        val wanted = spec.fingerprintFor(profile)
        if (loaded[profile] == wanted) return

        val bitmap = withContext(Dispatchers.IO) { prepare(context, profile, spec, wanted) } ?: return
        publish(profile, bitmap, wanted)
    }

    /** Reads the cached picture, or draws and stores a new one. Off the main thread. */
    private fun prepare(
        context: Context,
        profile: String,
        spec: AvatarSpec?,
        wanted: String,
    ): Bitmap? {
        val dir = File(context.filesDir, "avatars").apply { mkdirs() }
        val key = Base64.encodeToString(
            profile.toByteArray(),
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
        )
        val png = File(dir, "$key.png")
        val stamp = File(dir, "$key.stamp")

        if (png.exists() && runCatching { stamp.readText() }.getOrNull() == wanted) {
            decode(png)?.let { return it }
        }

        val bitmap = runCatching { render(context, profile, spec) }.getOrNull() ?: return null
        runCatching {
            png.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            stamp.writeText(wanted)
        }
        return bitmap
    }

    /**
     * Compose state has to be written from the main thread: a write from a
     * worker can land in a snapshot taken before the state existed, which
     * Compose rejects outright.
     */
    private suspend fun publish(profile: String, bitmap: Bitmap, fingerprint: String) =
        withContext(Dispatchers.Main) {
            images[profile] = bitmap.asImageBitmap()
            loaded[profile] = fingerprint
        }

    private fun decode(file: File): Bitmap? =
        runCatching { BitmapFactory.decodeFile(file.absolutePath) }.getOrNull()

    private fun render(context: Context, profile: String, spec: AvatarSpec?): Bitmap? {
        if (spec?.type == "image" && !spec.dataUrl.isNullOrBlank()) {
            decodeDataUrl(spec.dataUrl)?.let { return square(it) }
        }
        return renderSvg(MultiAvatar.svg(context, spec?.seed ?: profile))
    }

    private fun decodeDataUrl(dataUrl: String): Bitmap? {
        val comma = dataUrl.indexOf(',')
        if (comma < 0) return null
        val bytes = runCatching {
            Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
        }.getOrNull() ?: return null
        return runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }.getOrNull()
    }

    private fun square(source: Bitmap): Bitmap =
        if (source.width == PX && source.height == PX) source
        else Bitmap.createScaledBitmap(source, PX, PX, true)

    private fun renderSvg(markup: String): Bitmap? = runCatching {
        val svg = SVG.getFromString(markup)
        svg.setDocumentWidth(PX.toFloat())
        svg.setDocumentHeight(PX.toFloat())
        val bitmap = Bitmap.createBitmap(PX, PX, Bitmap.Config.ARGB_8888)
        svg.renderToCanvas(Canvas(bitmap))
        bitmap
    }.getOrNull()
}

/**
 * The Multiavatar generator, ported from the JavaScript Studio runs in the
 * browser so both sides draw the very same face for a given seed.
 *
 * Avatars by Multiavatar.com — see assets/multiavatar-LICENSE.txt.
 */
internal object MultiAvatar {

    private val order = listOf("env", "clo", "head", "mouth", "eyes", "top")
    private val colourPattern = Regex("#.*?;")

    @Volatile
    private var data: JSONObject? = null

    fun svg(context: Context, seed: String): String {
        val source = data(context)
        val themes = source.getJSONObject("themes")
        val parts = source.getJSONObject("parts")
        val hash = pickDigits(seed)

        val rendered = HashMap<String, String>(order.size)
        order.forEachIndexed { index, part ->
            val value = hash.substring(index * 2, index * 2 + 2).toInt()
            val scaled = Math.round((47.0 / 100.0) * value).toInt()
            val version: String
            val theme: String
            when {
                scaled > 31 -> {
                    version = pad(scaled - 32); theme = "C"
                }
                scaled > 15 -> {
                    version = pad(scaled - 16); theme = "B"
                }
                else -> {
                    version = pad(scaled); theme = "A"
                }
            }
            val colours = themes.getJSONObject(version).getJSONObject(theme).getJSONArray(part)
            rendered[part] = paint(parts.getJSONObject(version).getString(part), colours)
        }

        return source.getString("svgStart") +
            rendered["env"] + rendered["head"] + rendered["clo"] +
            rendered["top"] + rendered["eyes"] + rendered["mouth"] +
            source.getString("svgEnd")
    }

    /** Twelve digits of the SHA-256 hex, exactly how the JS picks its parts. */
    private fun pickDigits(seed: String): String {
        val hash = MessageDigest.getInstance("SHA-256")
            .digest(seed.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return (hash.filter { it.isDigit() } + "000000000000").take(12)
    }

    private fun pad(value: Int): String = if (value < 10) "0$value" else "$value"

    /** Substitutes the theme colours into the part, first match first. */
    private fun paint(part: String, colours: JSONArray): String {
        var result = part
        colourPattern.findAll(part).forEachIndexed { index, match ->
            if (index >= colours.length()) return@forEachIndexed
            val at = result.indexOf(match.value)
            if (at < 0) return@forEachIndexed
            result = result.substring(0, at) + colours.getString(index) + ";" +
                result.substring(at + match.value.length)
        }
        return result
    }

    private fun data(context: Context): JSONObject {
        data?.let { return it }
        synchronized(this) {
            data?.let { return it }
            val text = context.assets.open("multiavatar.json").bufferedReader().use { it.readText() }
            return JSONObject(text).also { data = it }
        }
    }
}

/** The round profile picture Studio shows next to a name. */
@Composable
fun ProfileAvatar(name: String, spec: AvatarSpec?, size: Dp = 34.dp) {
    val context = LocalContext.current
    LaunchedEffect(name, spec) { Avatars.ensure(context, name, spec) }
    val image = Avatars.of(name)

    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        if (image != null) {
            Image(
                bitmap = image,
                contentDescription = null,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
            )
        } else {
            Text(
                name.take(1).uppercase(),
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
