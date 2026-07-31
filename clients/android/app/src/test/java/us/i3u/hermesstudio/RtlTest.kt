package us.i3u.hermesstudio

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * Right-to-left is not only a matter of translated strings.
 *
 * Android mirrors layouts on its own, but two things it cannot guess: an icon
 * that means a direction, and a hardcoded left/right in the code. Both look
 * fine in English and wrong in Arabic, and neither shows up in a screenshot
 * anyone thinks to take. So they are checked here.
 */
class RtlTest {

    private val sources = File("src/main/java/us/i3u/hermesstudio")
        .walkTopDown()
        .filter { it.extension == "kt" }
        .toList()

    /**
     * Icons that point somewhere. `Icons.Filled.ArrowBack` keeps pointing left
     * in Arabic, where back is to the right; `Icons.AutoMirrored.Filled.ArrowBack`
     * flips with the layout.
     */
    private val directional = listOf(
        "ArrowBack", "ArrowForward", "ArrowLeft", "ArrowRight", "ArrowRightAlt",
        "Send", "Reply", "ReplyAll", "Forward", "Login", "Logout", "ExitToApp",
        "Chat", "Message", "Comment", "List", "FormatListBulleted", "Sort",
        "KeyboardArrowLeft", "KeyboardArrowRight", "KeyboardBackspace",
        "NavigateBefore", "NavigateNext", "TrendingFlat", "Undo", "Redo",
        "InsertDriveFile", "Note", "Label", "Help", "LastPage", "FirstPage",
    )

    @Test
    fun directionalIconsComeFromAutoMirrored() {
        val offenders = sources.flatMap { file ->
            directional.mapNotNull { icon ->
                if (file.readText().contains("Icons.Filled.$icon")) "${file.name}: Icons.Filled.$icon" else null
            }
        }
        assertEquals(
            "use Icons.AutoMirrored.Filled.<name> so the icon flips in a right-to-left layout",
            emptyList<String>(),
            offenders,
        )
    }

    /**
     * Padding, alignment and text placement have to be written in start/end
     * terms. A single `padding(start = 8.dp, right = 8.dp)` breaks the mirror.
     */
    @Test
    fun layoutsAreWrittenInStartAndEndTerms() {
        val physical = Regex("""\b(left|right)\s*=|Alignment\.(CenterStart|CenterEnd)Absolute|Absolute\.(Left|Right)""")
        val offenders = sources.flatMap { file ->
            file.readLines().withIndex().mapNotNull { (index, line) ->
                val code = line.trim()
                // Prose is allowed to say "left"; only code is checked.
                if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return@mapNotNull null
                if (physical.containsMatchIn(code)) "${file.name}:${index + 1}: $code" else null
            }
        }
        assertEquals(
            "use start/end instead of left/right so the layout mirrors",
            emptyList<String>(),
            offenders,
        )
    }
}
