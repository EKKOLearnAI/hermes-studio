---
name: pdf
description: Read, create, merge, split, fill, watermark, stamp, secure, inspect, render, and visually verify PDF files, including AcroForm workflows.
metadata:
  keywords:
    - .pdf
    - pdf form
    - merge pdf
    - create pdf
---

# PDF documents

Use this Skill for PDF extraction, generation, page operations, forms, metadata, attachments, encryption, and visual review.

## Start here

Call skill_view for this Skill first and use the returned baseDirectory for all bundled helpers under <baseDirectory>/scripts.

Default to a new output file. Do not overwrite or remove source PDFs unless the user explicitly asks. Inspect an input before transforming it, and preserve page order, orientation, dimensions, annotations, and form intent unless the request says otherwise.

Common dependencies:

    python3 -m pip install pypdf reportlab pdfplumber

Page rendering uses pypdfium2 when available and can fall back to Poppler's pdftoppm. Check dependencies first; do not install them silently.

## Helpers

- pdf_read.py: extract text and document information.
- pdf_page_image.py: render selected pages to images.
- pdf_create.py: create a PDF from structured input.
- pdf_merge.py and pdf_split.py: page composition.
- pdf_fill_form.py, pdf_form_layout.py, and pdf_make_form.py: AcroForm inspection, filling, and creation.
- pdf_watermark.py and pdf_stamp.py: page overlays.
- pdf_meta.py: metadata and attachment operations.
- pdf_secure.py: encrypt or decrypt using password files.

Run helpers with terminal_exec, using python3 as the command and an argument array. Use --help to inspect exact arguments.

    python3 <baseDirectory>/scripts/pdf_read.py input.pdf --json
    python3 <baseDirectory>/scripts/pdf_page_image.py input.pdf -o rendered --pages 1-3
    python3 <baseDirectory>/scripts/pdf_merge.py first.pdf second.pdf -o merged.pdf
    python3 <baseDirectory>/scripts/pdf_split.py input.pdf -o pages

For form work, read references/forms.md through skill_view before editing.

## Workflow

1. Inspect text, metadata, page count, page sizes, encryption state, and form fields as relevant.
2. Perform the smallest requested transformation into a new output.
3. Re-read the output to verify page count, text, metadata, attachments, or field values.
4. Render every changed page, or a representative sample for a large generated document, and inspect it with view_image. Check crop boxes, rotation, clipping, font rendering, overlays, and form appearance.
5. Return the absolute output path and list any validation limitations.

Use OCR only when normal text extraction is empty or clearly incomplete. Route scanned documents through the ocr-and-documents Skill.

## Passwords and sensitive PDFs

- Do not put PDF passwords in chat, logs, or command arguments.
- Store a supplied password in a temporary file with restrictive permissions and pass --password-file, --user-password-file, or --owner-password-file. Remove that temporary file after the operation.
- PDF permission flags are advisory; do not describe them as strong access control.
- Do not send sensitive PDF contents to external services without the user's authorization.
