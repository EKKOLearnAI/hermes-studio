---
name: video-frames
description: Extract a frame at a timestamp or frame index from a local video using ffmpeg for inspection, thumbnails, and visual debugging.
metadata:
  keywords:
    - video frame
    - extract frame
    - ffmpeg frame
---

# Video Frames

Use this Skill to extract a single image from a local video.

## Prerequisite

```bash
command -v ffmpeg
```

If ffmpeg is absent, tell the user what is required; do not silently install it.

`skill_view` returns this Skill's `baseDirectory`. Use the bundled helper at `<baseDirectory>/scripts/frame.sh`.

First frame:

```bash
<baseDirectory>/scripts/frame.sh /path/to/video.mp4 --out /tmp/frame.jpg
```

At a timestamp:

```bash
<baseDirectory>/scripts/frame.sh /path/to/video.mp4 --time 00:00:10 --out /tmp/frame-10s.jpg
```

At an exact decoded frame index:

```bash
<baseDirectory>/scripts/frame.sh /path/to/video.mp4 --index 120 --out /tmp/frame-120.png
```

Prefer a timestamp when investigating what happens around a moment. Use JPEG for quick sharing and PNG for crisp interface captures. Verify the output file exists before returning it to the user.
