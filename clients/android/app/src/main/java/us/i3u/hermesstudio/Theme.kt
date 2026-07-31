package us.i3u.hermesstudio

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Colours picked to match the Hermes Studio dark web UI. */
private val StudioColors = darkColorScheme(
    // Studio's chrome is neutral: light controls on near-black surfaces, with no
    // brand green anywhere.
    primary = Color(0xFFDDE1E6),
    onPrimary = Color(0xFF15171B),
    primaryContainer = Color(0xFF262A31),
    onPrimaryContainer = Color(0xFFE7E8EA),
    secondary = Color(0xFF6E7681),
    background = Color(0xFF101014),
    onBackground = Color(0xFFE7E8EA),
    surface = Color(0xFF17171C),
    onSurface = Color(0xFFE7E8EA),
    surfaceVariant = Color(0xFF20202A),
    onSurfaceVariant = Color(0xFF9AA0A8),
    outline = Color(0xFF2C2C36),
    error = Color(0xFFE88080),
    errorContainer = Color(0xFF3A1F1F),
    onErrorContainer = Color(0xFFFFD9D9),
)

@Composable
fun HermesTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = StudioColors, content = content)
}

/** Studio shows a short clock for today and a date for older rows. */
fun formatStamp(raw: String?): String {
    if (raw.isNullOrBlank()) return ""
    val millis = raw.toLongOrNull()
    if (millis != null) {
        val normalized = if (millis < 100_000_000_000L) millis * 1000 else millis
        val now = java.util.Calendar.getInstance()
        val then = java.util.Calendar.getInstance().apply { timeInMillis = normalized }
        val sameDay = now.get(java.util.Calendar.ERA) == then.get(java.util.Calendar.ERA) &&
            now.get(java.util.Calendar.YEAR) == then.get(java.util.Calendar.YEAR) &&
            now.get(java.util.Calendar.DAY_OF_YEAR) == then.get(java.util.Calendar.DAY_OF_YEAR)
        return android.text.format.DateFormat.format(if (sameDay) "h:mm a" else "yyyy-MM-dd", normalized).toString()
    }
    // ISO 8601: keep the clock when the day is today, otherwise the date.
    val date = raw.take(10)
    val time = raw.drop(11).take(5)
    val today = android.text.format.DateFormat.format("yyyy-MM-dd", System.currentTimeMillis()).toString()
    return if (date == today && time.isNotBlank()) time else date
}
