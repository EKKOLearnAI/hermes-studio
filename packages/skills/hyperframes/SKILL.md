---
name: hyperframes
description: "Create AI videos with HyperFrames in Hermes using HTML, CSS, and JavaScript compositions, then validate and render them to MP4. Use for short video intros, cinematic trailers, product promos, subtitle animations, HUD/tech visuals, web-to-video work, and motion graphics."
version: 1.0.0
author: Ekko
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [hyperframes, ai-video, html-video, animation, motion-graphics, mp4]
prerequisites:
  commands: [node, npx]
---

# HyperFrames

Use this skill when the user asks Hermes to make a video with HyperFrames, such as a 30-second vertical video, a short intro, a cinematic micro-trailer, a product promo, animated captions, HUD-style tech visuals, a website-to-video piece, or an HTML/CSS/JS motion graphics render.

HyperFrames treats HTML as the video source of truth. Build video scenes as HTML compositions with CSS layout and JavaScript animation, validate the layout, then render the result to MP4.

## Setup

If HyperFrames is not installed or the official skill is missing, install it first:

```bash
hermes skills install official/creative/hyperframes
```

Use `npx hyperframes` for project operations. HyperFrames requires Node.js and FFmpeg. If rendering or preview fails, run:

```bash
npx hyperframes doctor
```

## Workflow

1. Convert the user's request into a short production brief: duration, aspect ratio, target platform, language, style, music or voiceover needs, and final output path.
2. For incomplete briefs, make reasonable defaults. Use 1080x1920 for vertical short video, 1920x1080 for horizontal video, 30 fps, and MP4 output.
3. Create or reuse a HyperFrames project:

```bash
npx hyperframes init my-video --non-interactive
```

4. Write the composition in HTML/CSS/JS. Make the static hero frame layout correct before adding animation.
5. Validate before rendering:

```bash
npx hyperframes lint
npx hyperframes inspect --samples 15
```

6. Preview when useful:

```bash
npx hyperframes preview
```

7. Render the final video:

```bash
npx hyperframes render --output final.mp4 --quality standard
```

Use `--quality draft` for fast iteration and `--quality high` for final delivery when the user asks for a polished export.

## Composition Rules

- Use a root element with `data-composition-id`, `data-width`, and `data-height`.
- Use `data-start`, `data-duration`, and `data-track-index` for timed clips.
- Register GSAP timelines synchronously on `window.__timelines`.
- Use CSS as the final layout state, then animate from or to that state.
- Keep media playback under the HyperFrames runtime. Do not manually call `play()`, `pause()`, or seek media.
- Avoid nondeterministic animation logic such as `Math.random()` or `Date.now()` unless using a seeded generator.
- Do not use infinite repeats. Calculate finite repeat counts from the composition duration.
- Check that text, captions, UI panels, and HUD elements stay inside the frame on every inspected timestamp.

## Delivery

When finished, tell the user:

- the rendered MP4 path;
- the preview URL if a preview server is running;
- any assumptions made about duration, aspect ratio, style, narration, or music;
- any validation issues that remain unresolved.

Do not stop after writing HTML. A HyperFrames task is only complete after the composition has been checked with `lint` and `inspect`, and rendered to an MP4 unless the user explicitly asks for source files only.
