package us.i3u.hermesstudio

import android.content.Context
import androidx.annotation.StringRes
import java.util.Locale

/**
 * A language the app ships.
 *
 * @param tag BCP-47 tag, or "" for "whatever the phone is set to".
 * @param endonym the language's name in itself — never translated, so a reader
 *   can find their language in a list they cannot otherwise read.
 */
data class AppLanguage(
    val tag: String,
    val endonym: String? = null,
    @StringRes val labelRes: Int? = null,
)

/**
 * Adding a language is three steps, and this list is the second one:
 *
 *  1. copy `res/values/strings.xml` to `res/values-<tag>/strings.xml` and translate it
 *  2. add one line here
 *  3. add `<locale android:name="<tag>"/>` to `res/xml/locales_config.xml`
 *
 * `TranslationsTest` then guards the rest: it fails the build if the new file is
 * missing a key, carries one that no longer exists, or breaks a placeholder.
 * See docs/adding-a-language.md.
 */
val APP_LANGUAGES = listOf(
    AppLanguage(tag = "", labelRes = R.string.settings_language_system),
    AppLanguage(tag = "en", endonym = "English"),
    AppLanguage(tag = "ar", endonym = "العربية"),
)

object AppLocale {

    /**
     * Returns a context that resolves strings in the chosen language. Android
     * mirrors the whole layout on its own for a right-to-left locale, which is
     * why no screen has to know that Arabic is in play.
     */
    fun wrap(base: Context): Context {
        val tag = runCatching { Store(base).language }.getOrDefault("")
        if (tag.isBlank()) return base
        val locale = Locale.forLanguageTag(tag)
        val config = android.content.res.Configuration(base.resources.configuration)
        config.setLocale(locale)
        config.setLayoutDirection(locale)
        return base.createConfigurationContext(config)
    }

    fun labelFor(context: Context, language: AppLanguage): String =
        language.endonym ?: language.labelRes?.let { context.getString(it) } ?: language.tag

    /**
     * The name of the language actually on screen. "Follow the system" is the
     * honest label in Settings but useless on a button, where a reader wants to
     * see which language they are in right now.
     */
    fun currentEndonym(context: Context, tag: String): String {
        val effective = tag.ifBlank { context.resources.configuration.locales[0].language }
        return APP_LANGUAGES.firstOrNull { it.tag == effective }?.endonym ?: effective.uppercase(Locale.ROOT)
    }
}
