# Weixin Autopilot Reminders Design

## Goal

Use the existing personal Weixin/iLink scan-login channel as the proactive delivery path for Personal Autopilot reminders.

The purpose is not to build a generic notification center. The purpose is to make Hermes intervene at the right moment when the user is drifting away from body transformation and daily order.

## Product Principle

Personal Autopilot decides what matters. Weixin only delivers the smallest useful intervention.

```text
Autopilot State -> Reminder Policy -> Weixin Sender -> Delivery Log
```

The user should receive one practical next action, not a plan dump.

Example:

```text
现在最该做：睡前收束
原因：今天已经晚了，恢复比继续安排任务更重要
保底：洗脸 + 关灯 + 明早称重
```

## Existing Context

Hermes Studio already has Weixin setup support:

- `packages/server/src/controllers/hermes/weixin.ts` gets an iLink QR code, polls QR status, and saves credentials.
- Credentials are saved as profile-scoped `WEIXIN_ACCOUNT_ID`, `WEIXIN_TOKEN`, and optional `WEIXIN_BASE_URL`.
- Saving credentials restarts the profile gateway.
- Client API helpers already exist for QR code, QR status, and credential save.

What does not exist yet:

- A local reminder queue.
- A Personal Autopilot reminder policy.
- A Weixin outbound sender owned by the Web UI.
- Delivery logs, dedupe, quiet hours, or daily rate limits.

## Scope

First version:

- Send reminders to the user's own personal Weixin identity configured through the existing iLink scan flow.
- Bind reminders to Personal Autopilot only.
- Send one action-focused message at a time.
- Support test send.
- Persist delivery attempts for dedupe and debugging.

Out of scope for the first version:

- Group reminders.
- Multiple recipients.
- Generic notification rules for every subsystem.
- Complex retry workers.
- LLM-written long reports pushed to Weixin.
- Enterprise WeChat webhook support.

## Reminder Levels

The reminder service consumes Autopilot output and only sends when intervention is useful.

- `silent`: never send.
- `nudge`: lightweight reminder for meal, workout, skincare, bedtime, or order windows.
- `correct`: the user is drifting; send a realistic substitute.
- `takeover`: the day is collapsing; send one minimum viable action.
- `review`: short night or weekly review.
- `urgent`: reserved for rare high-priority health or recovery reminders.

The service should prefer fewer reminders. If a notification would not change behavior, it should not be sent.

## Message Format

Messages should be short and action-oriented.

Required fields:

- Next action title.
- Reason.
- Fallback action.

Optional fields:

- Mode label.
- Deadline or time window.
- One-tap reply hint, if a later Weixin reply flow is added.

Template:

```text
现在最该做：{title}
原因：{reason}
保底：{fallback}
```

## Anti-Spam Policy

The anti-spam policy is part of the feature, not a later polish task.

Rules:

- Do not send during quiet hours.
- Do not send in `silent` mode.
- Do not send the same action twice.
- Do not exceed the daily send limit.
- Do not send if the previous reminder was too recent.
- Do not retry forever when Weixin delivery fails.

Default settings:

- Enabled: false until the user enables it.
- Daily limit: 5 messages.
- Minimum interval: 60 minutes.
- Quiet hours: 23:30-08:00.
- Check interval: 10 minutes.

## Data Model

Use a lightweight profile-scoped SQLite store or existing Web UI state store.

### Settings

`autopilot_reminder_settings`

- `profile`
- `enabled`
- `channel`
- `daily_limit`
- `minimum_interval_minutes`
- `quiet_start`
- `quiet_end`
- `created_at`
- `updated_at`

Initial channel value:

- `weixin`

### Delivery Log

`autopilot_reminder_deliveries`

- `id`
- `profile`
- `channel`
- `mode`
- `action_id`
- `action_title`
- `message`
- `status`
- `error`
- `sent_at`
- `created_at`

Status values:

- `sent`
- `skipped`
- `failed`

Skip reasons can be stored in `error` for first version:

- `disabled`
- `quiet_hours`
- `duplicate_action`
- `daily_limit`
- `minimum_interval`
- `silent_mode`
- `missing_weixin_credentials`

## Sender Design

Add a Weixin outbound sender behind a narrow interface:

```ts
sendWeixinTextReminder(profile: string, message: string): Promise<{ ok: boolean; error?: string }>
```

The sender should resolve profile-scoped Weixin credentials from the same source used by the existing Weixin setup. It should use `WEIXIN_BASE_URL` when configured.

If the exact iLink outbound API is unavailable or different from gateway message sending, keep the sender isolated so the transport can be replaced without changing reminder policy.

## Triggering

First version should use a simple server-side periodic checker:

- Runs every 10 minutes while the Web UI server is running.
- For each enabled profile, loads Personal Autopilot overview.
- Applies reminder policy.
- Sends if allowed.
- Records delivery or skip.

The checker should be conservative and easy to disable.

Future versions can move this into the existing jobs/cron surface once the Autopilot reminder loop is proven.

## UI

Add reminder controls to the Personal OS or Settings surface:

- Enable Weixin reminders.
- Show Weixin connection status.
- Configure quiet hours.
- Configure daily limit.
- Send test reminder.
- Show recent delivery attempts.

The UI should avoid a complex rule builder in the first version.

## Testing

Tests should cover:

- Reminder policy skips disabled settings.
- Reminder policy skips quiet hours.
- Reminder policy skips duplicate action.
- Reminder policy respects daily limit and minimum interval.
- Reminder service sends a formatted message for `nudge`, `correct`, and `takeover`.
- Weixin sender reports missing credentials clearly.
- Controller and client API expose settings, recent deliveries, and test send.

## Success Criteria

The feature is working when:

- The user can enable Weixin reminders after scanning Weixin credentials.
- Hermes sends only action-focused Autopilot reminders.
- Reminders are deduped and rate-limited.
- Quiet hours are respected.
- Delivery attempts are visible for debugging.
- Smart Planning remains in the background; Weixin surfaces only the current best action.
