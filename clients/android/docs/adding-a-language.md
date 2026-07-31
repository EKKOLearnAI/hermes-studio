# Adding a language

Every string in the app lives in one file, `app/src/main/res/values/strings.xml`.
A translation is a copy of that file with the same keys and translated values.
No code changes are needed, and no screen has to be touched.

## Three steps

**1. Copy the default file** to `app/src/main/res/values-<tag>/strings.xml`, where
`<tag>` is the language's ISO code — `fr`, `tr`, `ur`, `es`, `zh` — and translate the
values. Leave the `name` attributes exactly as they are.

```bash
mkdir -p app/src/main/res/values-fr
cp app/src/main/res/values/strings.xml app/src/main/res/values-fr/strings.xml
```

**2. Offer it in Settings** — one line in
[`Locales.kt`](../app/src/main/java/us/i3u/hermesstudio/Locales.kt):

```kotlin
val APP_LANGUAGES = listOf(
    AppLanguage(tag = "", labelRes = R.string.settings_language_system),
    AppLanguage(tag = "en", endonym = "English"),
    AppLanguage(tag = "ar", endonym = "العربية"),
    AppLanguage(tag = "fr", endonym = "Français"),   // <- here
)
```

`endonym` is the language's own name, written in that language. It is never
translated: someone who cannot read the current UI still has to find their
language in the list.

**3. Declare it to Android** — one line in
[`res/xml/locales_config.xml`](../app/src/main/res/xml/locales_config.xml), which is
what puts the app in the system's per-app language screen:

```xml
<locale android:name="fr" />
```

That's it. Run `gradle test` and open the app.

## What the build checks for you

`TranslationsTest` fails the build if:

- a key from the default file is **missing** in a translation
- a translation carries a key the default **no longer defines**
- a value is **empty**
- a placeholder is **dropped or changed** — `%1$s` in the default must appear in the
  translation, in whatever position the sentence needs
- a `values-<tag>` folder exists but the language is **not offered** in `Locales.kt`,
  or **not declared** in `locales_config.xml`

```bash
gradle test
```

## Right-to-left languages

Nothing to do as a translator. Arabic is the worked example; Hebrew, Persian and
Urdu behave the same way.

If you are writing UI code, two things Android cannot mirror for you, both checked
by `RtlTest`:

- **Icons that mean a direction** must come from `Icons.AutoMirrored.Filled.*`.
  `Icons.Filled.ArrowBack` keeps pointing left in Arabic, where back is to the right.
- **Position must be written in `start`/`end` terms**, never `left`/`right`. Padding,
  alignment, and text alignment all have start/end forms.

Everything else — the order of a row, which side a list item's timestamp sits on,
the drawer, the sheet — Android mirrors on its own because the manifest declares
`supportsRtl`.

## Style notes

- Keep it short. Phone labels are read at a glance, and a long word can push a
  button off screen — check the composer row and the settings rows after translating.
- Match the tone of the default file: plain, direct, no exclamation marks.
- Product names stay as they are: *Hermes Studio*, *Telegram*, *Discord*, model ids.
- Leave technical values alone: `https://hermes.example.com`, `logo.png`, `%1$s`.
