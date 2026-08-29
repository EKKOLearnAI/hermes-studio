---
name: python-debugpy
description: Debug Python with pdb, breakpoint(), post-mortem inspection, and debugpy remote or headless attach.
metadata:
  keywords:
    - debugpy
    - python debugger
    - pdb
    - remote python debugging
---

# Python Debugging

Use when Python code needs interactive debugging: hidden locals, confusing state mutation, failing tests, subprocesses, long-running services, or remote attach.

Choose the smallest debugger that reaches the bad frame:

- `breakpoint()`: local code where source edits are acceptable.
- `python3 -m pdb`: launch from the beginning without editing source.
- `python3 -m pdb -c continue`: stop at an unhandled exception.
- `debugpy`: remote/headless processes, DAP clients, an existing PID, or startup races.

## Commands

```bash
python3 -m pdb path/to/script.py arg1
python3 -m pdb -c continue path/to/script.py
python3 -c "import debugpy" || python3 -m pip install debugpy
python3 -m debugpy --listen 127.0.0.1:5678 --wait-for-client path/to/script.py
python3 -m debugpy --listen 127.0.0.1:5678 --wait-for-client -m package.module
python3 -m debugpy --listen 127.0.0.1:5678 --pid <pid>
```

Source-edit attach:

```python
import debugpy

debugpy.listen(("127.0.0.1", 5678))
debugpy.wait_for_client()
debugpy.breakpoint()
```

Post-mortem inspection:

```python
import pdb
import sys

try:
    run()
except Exception:
    pdb.post_mortem(sys.exc_info()[2])
    raise
```

## pdb commands

- Flow: `n`, `s`, `r`, `c`, `q`.
- Stack and source: `w`, `u`, `d`, `a`, `l`, `ll`.
- Values: `p expr`, `pp expr`, `display expr`.
- Breakpoints: `b file.py:42`, `b func`, `b file.py:42, condition`, `cl <num>`.
- Evaluate or mutate: `!statement`; full REPL: `interact`.

## Rules

- Reproduce with the smallest command or test first.
- Disable parallel test workers for pdb; worker pools usually break interactive stdin.
- Keep `debugpy` in the active environment. Do not add it as a project dependency unless the project needs it.
- Bind debug servers to `127.0.0.1`; expose them only on an isolated network or through a secure tunnel.
- Treat PID attach as process injection. Avoid security-sensitive or production targets unless explicitly approved.
- On Linux, check ptrace and container privileges before changing a target when PID attach fails.
- Before committing, run `rg -n 'breakpoint\\(|pdb\\.set_trace|debugpy\\.' --type py` and remove accidental breakpoints.
- Rerun the normal project test gate without the debugger.
