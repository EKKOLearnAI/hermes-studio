package us.i3u.hermesstudio

/**
 * What each channel needs before Hermes can talk on it.
 *
 * The paths are the ones the server maps to environment variables in
 * `platformEnvMap`, so `PUT /api/hermes/config/credentials` accepts them
 * verbatim: a bare name is a top-level field, `extra.x` goes under `extra`.
 */
data class ChannelField(
    val path: String,
    val label: String,
    val secret: Boolean = true,
    val hint: String = "",
)

data class ChannelSpec(
    val platform: String,
    val label: String,
    val fields: List<ChannelField>,
    /** Set up outside the app — WhatsApp pairs by scanning a code on the server. */
    val pairedElsewhere: Boolean = false,
)

val CHANNELS = listOf(
    ChannelSpec(
        platform = "telegram",
        label = "Telegram",
        fields = listOf(
            ChannelField("token", "Bot token", hint = "From @BotFather"),
            ChannelField("proxy", "Proxy", secret = false, hint = "Optional"),
        ),
    ),
    ChannelSpec(
        platform = "discord",
        label = "Discord",
        fields = listOf(
            ChannelField("token", "Bot token", hint = "From the Discord developer portal"),
            ChannelField("proxy", "Proxy", secret = false, hint = "Optional"),
        ),
    ),
    ChannelSpec(
        platform = "slack",
        label = "Slack",
        fields = listOf(ChannelField("token", "Bot token", hint = "xoxb-…")),
    ),
    ChannelSpec(
        platform = "whatsapp",
        label = "WhatsApp",
        fields = emptyList(),
        pairedElsewhere = true,
    ),
    ChannelSpec(
        platform = "matrix",
        label = "Matrix",
        fields = listOf(
            ChannelField("extra.homeserver", "Homeserver", secret = false, hint = "https://matrix.org"),
            ChannelField("token", "Access token"),
            ChannelField("extra.user_id", "User id", secret = false, hint = "@name:server"),
            ChannelField("extra.password", "Password"),
            ChannelField("proxy", "Proxy", secret = false, hint = "Optional"),
        ),
    ),
    ChannelSpec(
        platform = "weixin",
        label = "Weixin",
        fields = listOf(
            ChannelField("token", "Token"),
            ChannelField("extra.account_id", "Account id", secret = false),
        ),
    ),
    ChannelSpec(
        platform = "wecom",
        label = "WeCom",
        fields = listOf(
            ChannelField("extra.bot_id", "Bot id", secret = false),
            ChannelField("extra.secret", "Secret"),
        ),
    ),
    ChannelSpec(
        platform = "feishu",
        label = "Feishu",
        fields = listOf(
            ChannelField("extra.app_id", "App id", secret = false),
            ChannelField("extra.app_secret", "App secret"),
            ChannelField("extra.encrypt_key", "Encrypt key"),
            ChannelField("extra.verification_token", "Verification token"),
        ),
    ),
    ChannelSpec(
        platform = "dingtalk",
        label = "DingTalk",
        fields = listOf(
            ChannelField("extra.client_id", "Client id", secret = false),
            ChannelField("extra.client_secret", "Client secret"),
            ChannelField("extra.app_key", "App key"),
        ),
    ),
    ChannelSpec(
        platform = "qqbot",
        label = "QQ Bot",
        fields = listOf(
            ChannelField("extra.app_id", "App id", secret = false),
            ChannelField("extra.client_secret", "Client secret"),
        ),
    ),
)

fun channelSpec(platform: String): ChannelSpec =
    CHANNELS.firstOrNull { it.platform == platform }
        ?: ChannelSpec(platform, platform.replaceFirstChar { it.uppercase() }, emptyList())
