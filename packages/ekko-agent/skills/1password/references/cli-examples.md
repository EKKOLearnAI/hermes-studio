# Safe `op` CLI patterns

## Authentication and accounts

```bash
op whoami
op account list
op signin --account <shorthand-or-signin-address>
```

## Run a command with secret references

Keep secret references, not resolved values, in an environment file or environment variables:

```bash
export DB_PASSWORD="op://app-prod/db/password"
op run -- printenv SAFE_NON_SECRET_VALUE
op run --env-file="./.env" -- your-command
```

Do not demonstrate success by printing the secret-bearing environment variable. Avoid `--no-masking` unless the user explicitly needs it and the output destination is safe.

## Inject a template

```bash
op inject -i config.yml.tpl -o config.yml
```

The generated file contains resolved secrets. Create it only when the user requested a persisted file, restrict its permissions, exclude it from version control, and clean it up when possible.

## Read

```bash
op read "op://app-prod/db/one-time password?attribute=otp"
op read --out-file ./key.pem "op://app-prod/server/ssh/key.pem"
```

`op read` writes the secret to stdout unless `--out-file` is used. Use it only when a trusted local consumer needs the value, suppress captured output, and never include the value in the assistant response. An output file needs the same persisted-secret safeguards as an injected file.
