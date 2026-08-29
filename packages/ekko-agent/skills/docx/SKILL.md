---
name: docx
description: Create, inspect, edit, validate, and visually verify Microsoft Word .docx documents, including templates, comments, tracked revisions, tables, images, headers, and footers.
metadata:
  keywords:
    - .docx
    - word document
    - microsoft word
    - tracked changes
---

# Word documents

Use this Skill for .docx work. Preserve the user's content and formatting intent, and make the smallest change that satisfies the request.

## Start here

Call skill_view for this Skill before using its resources. It returns baseDirectory; every bundled helper below lives under <baseDirectory>/scripts.

Default to a new output file. Replace the input only when the user explicitly asks for an in-place edit. Before changing a document, inspect it with docx_read.py and keep a recoverable original.

Core dependency:

    python3 -m pip install python-docx lxml

Do not install dependencies silently. Check availability first and explain any missing dependency that blocks the task.

## Helpers

- docx_read.py: extract paragraphs, headings, tables, links, comments, headers, footers, and document metadata.
- docx_create.py: create a document from structured JSON.
- docx_edit.py: perform targeted text, paragraph, table, image, header, and footer edits.
- docx_template.py: inspect placeholders and populate a template.
- docx_comments.py: add, list, or remove comments.
- docx_revisions.py: inspect, accept, or reject tracked revisions.
- docx_validate.py: validate the resulting package and report structural problems.

Run helpers with terminal_exec, passing python3 as the command and arguments as an array. Use --help when a helper's exact arguments are unclear.

    python3 <baseDirectory>/scripts/docx_read.py input.docx --json
    python3 <baseDirectory>/scripts/docx_create.py spec.json -o output.docx
    python3 <baseDirectory>/scripts/docx_edit.py input.docx edits.json -o output.docx
    python3 <baseDirectory>/scripts/docx_validate.py output.docx

For tracked changes and comments, read references/revisions-and-comments.md through skill_view before editing them.

## Workflow

1. Inspect the source document and identify the exact sections to preserve or change.
2. Build a structured specification or edit plan. Do not approximate names, numbers, dates, citations, or legal wording.
3. Generate or edit a new .docx.
4. Run docx_validate.py.
5. When layout matters, convert the result to PDF with LibreOffice if available, render the relevant PDF pages with the bundled pdf Skill, and inspect the images with view_image. Check clipping, page breaks, tables, headers, footers, and image placement.
6. Return the final absolute path and summarize material changes.

If LibreOffice is unavailable, still perform structural validation and clearly state that visual rendering was not available.

## Safety

- Never discard comments or tracked revisions unless the user requested that operation.
- Treat accept-all/reject-all revisions and remove-all comments as destructive transformations; confirm the intended scope when it is ambiguous.
- Do not execute macros or embedded objects.
- Avoid copying sensitive document text into external services unless the user requested a workflow that requires it.
