def register(ctx):
    def hello(raw_args: str = "") -> str:
        name = (raw_args or "").strip() or "Hermes"
        return f"Hello, {name}. Plugin system is alive."

    ctx.register_command(
        "hello-local",
        hello,
        description="Check that a local plugin is loaded.",
        args_hint="[name]",
    )
