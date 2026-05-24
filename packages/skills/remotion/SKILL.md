---
name: remotion
description: "Create editable AI video projects with Remotion and React, then preview and render them to MP4. Use for vertical short videos, product demos, story-driven animations, HUD/tech visuals, feed ads, tutorial videos, subtitles, voiceover, sound effects, and code-based video iteration."
version: 1.0.0
author: Ekko
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    source: skills-sh/google-labs-code/stitch-skills/remotion
    tags: [remotion, react-video, ai-video, mp4, animation, short-video]
prerequisites:
  commands: [node, npx]
---

# Remotion

Use this skill when the user wants Hermes to turn a short video idea into an editable, renderable React video project with Remotion.

Remotion is different from prompt-only AI video tools: it produces a code project. That means the agent can repeatedly edit subtitles, timing, characters, scenes, voiceover, sound effects, and visual rhythm, then render a new MP4.

Good fits include vertical short videos, product demos, story-driven animations, HUD/tech-style videos, feed ad creatives, tutorial explainers, caption-heavy clips, and reusable video templates.

## Setup

If the upstream Remotion skill is not installed, install it first:

```bash
hermes skills install skills-sh/google-labs-code/stitch-skills/remotion
```

For a new Remotion project, scaffold from an empty folder:

```bash
npx create-video@latest --yes --blank --no-tailwind my-video
```

Replace `my-video` with a short project name based on the user's brief.

## Workflow

1. Turn the request into a concise production brief: purpose, audience, duration, aspect ratio, style, scenes, text, narration, music, sound effects, and output path.
2. Use practical defaults when the user does not specify them: 1080x1920 for vertical short video, 1920x1080 for horizontal video, 30 fps, MP4 output, and a duration that fits the requested platform.
3. Create or reuse a Remotion project.
4. Build the video as React components and Remotion compositions. Keep scene data, captions, colors, timing, and copy easy to edit.
5. Use Remotion primitives for timing and media: `Composition`, `Sequence`, `AbsoluteFill`, `Audio`, `Video`, `Img`, `useCurrentFrame`, `useVideoConfig`, `interpolate`, and `spring`.
6. Preview in Remotion Studio while iterating:

```bash
npx remotion studio
```

7. For non-trivial layouts, render at least one still frame to catch layout, color, and timing issues:

```bash
npx remotion still <composition-id> --scale=0.25 --frame=30
```

8. Render the final MP4:

```bash
npx remotion render <composition-id> out/final.mp4
```

## Implementation Guidelines

- Prefer code that is easy to revise over one-off generated visuals.
- Keep copy, scene timing, colors, and asset references in clear constants or data arrays.
- Make captions readable on mobile: high contrast, generous line height, and safe margins.
- Use deterministic animation. Avoid time-based randomness that changes between renders.
- Use Remotion's frame-based timing instead of browser timers.
- Use separate components for scenes, captions, overlays, lower thirds, and recurring visual motifs.
- When adding voiceover or sound effects, keep audio timing explicit and easy to adjust.
- When using user assets, keep their original files in the project and reference them through Remotion's asset path conventions.

## Checks

Before delivery, run the strongest practical validation for the scope:

```bash
npm run build
npx remotion still <composition-id> --scale=0.25 --frame=30
npx remotion render <composition-id> out/final.mp4
```

If the project uses a different package script, follow that project instead. If rendering fails because of missing browser, FFmpeg, codec, or dependency setup, report the blocker and run the relevant Remotion or environment diagnostic before retrying.

## Delivery

When finished, tell the user:

- the Remotion project path;
- the rendered MP4 path;
- the preview command or Studio URL if a preview server is running;
- the composition ID used for rendering;
- any assumptions about duration, aspect ratio, voiceover, music, assets, or style.

Do not stop at a concept. A Remotion video task is complete when the project is editable and the requested MP4 is rendered, unless the user explicitly asks for source code only.
