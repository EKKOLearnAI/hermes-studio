# hello-local Hermes Plugin

This is a minimal local plugin for testing the Hermes plugin loader.

## Install As A User Plugin

Copy this directory to:

```text
~/.hermes/plugins/hello-local
```

Then open Hermes Web UI > Plugins and enable `hello-local`. Start a new Hermes session and run:

```text
/hello-local kk
```

## Install As A Project Plugin

Copy this directory to:

```text
.hermes/plugins/hello-local
```

Start the Web UI with:

```text
HERMES_ENABLE_PROJECT_PLUGINS=1
```

Project plugin scanning is opt-in so untrusted workspace code is not imported or activated accidentally.
