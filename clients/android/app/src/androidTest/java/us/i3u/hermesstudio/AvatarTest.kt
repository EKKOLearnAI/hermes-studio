package us.i3u.hermesstudio

import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest

@RunWith(AndroidJUnit4::class)
class AvatarTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    /**
     * Digests of the SVG the JavaScript generator produces for these seeds. If a
     * change here breaks them, the app and the web UI have stopped drawing the
     * same face for the same profile.
     */
    private val reference = mapOf(
        "manager" to "dd38028f63bb026586d91d5fdd2efb51fa51ad6a7923873e9f717ce1102e2f57",
        "default" to "d7ee01667013dd5eb07d4bc820d7d02c0911395dc8e3281add90d537aec2f67e",
        "barq" to "1abc51db0bf486b9071ed64cb8a14c1729fd8658102c5c739d08a949ea888ee0",
        "فهد" to "1f156251a4eb8a47d71fb7e8cf92810d4548d58cd561e62c8a72424b28d2ccf1",
    )

    @Test
    fun generatedMarkupMatchesTheWebGenerator() {
        reference.forEach { (seed, digest) ->
            assertEquals(seed, digest, sha256(MultiAvatar.svg(context, seed)))
        }
    }

    @Test
    fun avatarRendersToAPicture() = runBlocking {
        val profile = "render-check"
        Avatars.ensure(context, profile, null)

        val drawn = Avatars.of(profile)
        assertNotNull("no bitmap was produced", drawn)

        // A blank canvas would mean the SVG parsed to nothing.
        val bitmap = drawn!!.asAndroidBitmap()
        val colours = buildSet {
            for (x in 0 until bitmap.width step 8) {
                for (y in 0 until bitmap.height step 8) add(bitmap.getPixel(x, y))
            }
        }
        assertTrue("the avatar came out flat: ${colours.size} colour(s)", colours.size > 4)
    }

    @Test
    fun avatarIsCachedOnDisk() = runBlocking {
        val profile = "cache-check"
        Avatars.ensure(context, profile, null)

        val cached = File(context.filesDir, "avatars").listFiles().orEmpty()
        assertTrue("nothing was written to files/avatars", cached.any { it.name.endsWith(".png") })
    }

    private fun sha256(value: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}
