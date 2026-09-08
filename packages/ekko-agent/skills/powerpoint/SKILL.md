---
name: powerpoint
description: Create, inspect, edit, template, render, and visually verify Microsoft PowerPoint .pptx presentations.
metadata:
  keywords:
    - .pptx
    - powerpoint
    - slide deck
    - presentation slides
---

# PowerPoint presentations

Use this Skill for .pptx creation and editing. Preserve theme, layout, slide masters, notes, media, and speaker intent when modifying an existing deck.

## Start here

Call skill_view for this Skill and use its returned baseDirectory. Bundled helpers live in <baseDirectory>/scripts.

Default to a new output file. Inspect existing decks before editing them. Never flatten a deck to images unless the user explicitly wants a non-editable result.

Core dependency:

    python3 -m pip install python-pptx

Rendering requires LibreOffice and Poppler. Check first and do not install missing dependencies silently.

## Helpers

- pptx_read.py: inspect slide text, notes, shapes, media, and metadata.
- pptx_create.py: create a deck from structured JSON.
- pptx_edit.py: make targeted edits to an existing deck.
- pptx_from_template.py: populate a user-provided template.
- pptx_render.py: render slides for visual review.

Run them through terminal_exec with python3 and an argument array. Use --help for exact options.

    python3 <baseDirectory>/scripts/pptx_read.py input.pptx --json
    python3 <baseDirectory>/scripts/pptx_create.py spec.json -o output.pptx
    python3 <baseDirectory>/scripts/pptx_edit.py input.pptx edits.json -o output.pptx
    python3 <baseDirectory>/scripts/pptx_render.py output.pptx -o rendered

## Workflow

1. Inspect the source deck or template.
2. Define the narrative, slide order, hierarchy, and visual system before generating.
3. Keep text concise and legible; use real source data and preserve citations.
4. Generate or edit into a new .pptx, then re-read it to verify slide count and content.
5. Render every slide and inspect the output images with view_image. Check overflow, overlaps, low contrast, inconsistent alignment, broken fonts, cropped images, and speaker notes.
6. Iterate until the deck is structurally and visually sound, then return the absolute file path.

If rendering is unavailable, report that limitation instead of claiming visual verification.

## Safety

- Do not execute macros, linked programs, or embedded objects.
- Do not silently remove notes, hidden slides, accessibility text, or source attributions.
- Do not upload private deck content or images to an external service unless the requested task requires it and the user has authorized that use.
