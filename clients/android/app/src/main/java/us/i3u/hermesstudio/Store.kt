package us.i3u.hermesstudio

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Credentials live in EncryptedSharedPreferences, backed by a Keystore key, so
 * the bearer token is never written to disk in clear text.
 */
class Store(context: Context) {

    private val prefs: SharedPreferences = runCatching {
        val key = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "hermes_secure",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }.getOrElse {
        // Keystore can be unavailable on a small number of devices; the app must
        // still run rather than crash on launch.
        context.getSharedPreferences("hermes_plain", Context.MODE_PRIVATE)
    }

    var baseUrl: String
        get() = prefs.getString(KEY_URL, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_URL, value.trim().trimEnd('/')).apply()

    var token: String
        get() = prefs.getString(KEY_TOKEN, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    var profile: String
        get() = prefs.getString(KEY_PROFILE, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_PROFILE, value).apply()

    fun sessionFor(profile: String): String =
        prefs.getString(sessionKey(profile), "").orEmpty()

    fun setSessionFor(profile: String, sessionId: String) {
        prefs.edit().putString(sessionKey(profile), sessionId).apply()
    }

    var onboarded: Boolean
        get() = prefs.getBoolean(KEY_ONBOARDED, false)
        set(value) = prefs.edit().putBoolean(KEY_ONBOARDED, value).apply()

    /** BCP-47 tag chosen in Settings; blank means "follow the system". */
    var language: String
        get() = prefs.getString(KEY_LANGUAGE, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_LANGUAGE, value).apply()

    var reasoningEffort: String
        get() = prefs.getString(KEY_REASONING, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_REASONING, value).apply()

    fun clearCredentials() {
        prefs.edit().remove(KEY_TOKEN).apply()
    }

    val isConfigured: Boolean
        get() = baseUrl.isNotBlank() && token.isNotBlank()

    private fun sessionKey(profile: String) = "$KEY_SESSION_PREFIX$profile"

    private companion object {
        const val KEY_URL = "base_url"
        const val KEY_TOKEN = "token"
        const val KEY_PROFILE = "profile"
        const val KEY_SESSION_PREFIX = "session_"
        const val KEY_REASONING = "reasoning_effort"
        const val KEY_ONBOARDED = "onboarded"
        const val KEY_LANGUAGE = "language"
    }
}
