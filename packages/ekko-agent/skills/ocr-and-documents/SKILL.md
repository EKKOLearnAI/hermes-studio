---
name: ocr-and-documents
description: Extract and structure text from scanned PDFs and document images with a local-first OCR workflow, layout-aware fallbacks, and explicit heavyweight dependency controls.
metadata:
  keywords:
    - ocr
    - scanned pdf
    - document ocr
    - image text extraction
---

# OCR and scanned documents

Use this Skill when ordinary document extraction fails because the source is scanned, image-based, or layout-heavy.

## Start here

Call skill_view for this Skill and use its returned baseDirectory. Helpers live in <baseDirectory>/scripts.

Prefer local processing. Do not upload a private document to an external OCR service unless the user explicitly authorizes that transfer.

## Choose the lightest path

1. Normal extraction first. For PDFs, try the bundled pdf Skill. For .docx, use docx. Do not OCR born-digital text.
2. A few scanned pages. Render pages with the pdf Skill and inspect images using view_image; transcribe only the requested pages.
3. Text-oriented scanned PDF. Try extract_pymupdf.py; this is the lighter local path.
4. Complex layout, tables, math, or many scanned pages. Use extract_marker.py only after confirming the need and checking resources.

## Helpers

    python3 <baseDirectory>/scripts/extract_pymupdf.py input.pdf -o extracted.md
    python3 <baseDirectory>/scripts/extract_marker.py --check
    python3 <baseDirectory>/scripts/extract_marker.py input.pdf -o extracted.md

Run helpers with terminal_exec, using python3 as the command and arguments as an array. Use --help for exact options.

extract_pymupdf.py requires PyMuPDF:

    python3 -m pip install pymupdf

Its --markdown mode additionally requires pymupdf4llm.

extract_marker.py uses marker-pdf, which can require several gigabytes of packages and model downloads. Never install it automatically. Check available disk space and ask the user before installing or downloading large models.

## URLs

If the source is a URL, first use an available browser or HTTP tool to identify whether it points to HTML or a document. Download only the requested document, respect authentication and access boundaries, and then process the local copy. Do not assume a specific web tool exists.

## Verification

- Preserve reading order, page references, headings, tables, footnotes, and confidence caveats.
- Compare extracted text against representative rendered pages with view_image.
- Mark uncertain characters and fields instead of guessing.
- For tables, verify column alignment and numeric values separately.
- Return both the extracted artifact path and the original source/page mapping when possible.
