package us.i3u.hermesstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Keeps every translation honest against res/values/strings.xml.
 *
 * A translator only has to copy the default file, translate it, and add two
 * lines (Locales.kt and locales_config.xml). Everything that can silently go
 * wrong after that — a dropped key, a stale key, a mangled %1$s, a language
 * that exists on disk but is never offered — fails here instead of shipping.
 */
class TranslationsTest {

    private val resDir = File("src/main/res")
    private val placeholder = Regex("%\\d+\\\$[a-zA-Z]|%[a-zA-Z]")

    private fun strings(file: File): Map<String, String> {
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val nodes = document.getElementsByTagName("string")
        return (0 until nodes.length).associate { index ->
            val element = nodes.item(index) as Element
            element.getAttribute("name") to element.textContent
        }
    }

    private fun translationDirs(): List<File> =
        resDir.listFiles().orEmpty()
            .filter { it.isDirectory && it.name.startsWith("values-") && File(it, "strings.xml").exists() }
            .sortedBy { it.name }

    private fun tagOf(dir: File) = dir.name.removePrefix("values-")

    @Test
    fun everyTranslationCarriesExactlyTheDefaultKeys() {
        val base = strings(File(resDir, "values/strings.xml"))
        assertTrue("no default strings found", base.size > 50)

        translationDirs().forEach { dir ->
            val translated = strings(File(dir, "strings.xml"))
            assertEquals(
                "${dir.name} is missing keys",
                emptySet<String>(),
                base.keys - translated.keys,
            )
            assertEquals(
                "${dir.name} has keys the default no longer defines",
                emptySet<String>(),
                translated.keys - base.keys,
            )
        }
    }

    @Test
    fun noTranslatedValueIsEmpty() {
        translationDirs().forEach { dir ->
            strings(File(dir, "strings.xml")).forEach { (key, value) ->
                assertTrue("${dir.name}: $key is empty", value.isNotBlank())
            }
        }
    }

    @Test
    fun placeholdersSurviveTranslation() {
        val base = strings(File(resDir, "values/strings.xml"))
        translationDirs().forEach { dir ->
            strings(File(dir, "strings.xml")).forEach { (key, value) ->
                val expected = placeholder.findAll(base[key].orEmpty()).map { it.value }.toSet()
                val actual = placeholder.findAll(value).map { it.value }.toSet()
                assertEquals("${dir.name}: $key changed its placeholders", expected, actual)
            }
        }
    }

    /** A translation nobody can pick, or an entry with no file, is a bug. */
    @Test
    fun everyTranslationIsOfferedAndDeclared() {
        val onDisk = translationDirs().map(::tagOf).toSet()

        val offered = Regex("""tag = "([a-zA-Z-]+)"""")
            .findAll(File("src/main/java/us/i3u/hermesstudio/Locales.kt").readText())
            .map { it.groupValues[1] }
            .toSet()
        assertEquals("APP_LANGUAGES in Locales.kt is out of step with res/values-*", onDisk, offered - setOf("en"))

        val declared = Regex("""android:name="([a-zA-Z-]+)"""")
            .findAll(File(resDir, "xml/locales_config.xml").readText())
            .map { it.groupValues[1] }
            .toSet()
        assertEquals("locales_config.xml is out of step with res/values-*", onDisk, declared - setOf("en"))
    }
}
