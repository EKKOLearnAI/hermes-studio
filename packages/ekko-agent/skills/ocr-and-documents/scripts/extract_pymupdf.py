#!/usr/bin/env python3
"""Extract text, Markdown, tables, images, or metadata with PyMuPDF."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def parse_pages(value: str | None) -> list[int] | None:
    if value is None:
        return None
    pages: list[int] = []
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start_text, end_text = part.split("-", 1)
            start, end = int(start_text), int(end_text)
            if start > end:
                raise argparse.ArgumentTypeError("page range start must not exceed end")
            pages.extend(range(start, end + 1))
        else:
            pages.append(int(part))
    if any(page < 0 for page in pages):
        raise argparse.ArgumentTypeError("page indexes must be zero or greater")
    return pages


def extract_text(path: str, pages: list[int] | None = None) -> str:
    import pymupdf

    document = pymupdf.open(path)
    page_range = range(len(document)) if pages is None else pages
    chunks: list[str] = []
    for index in page_range:
        if index >= len(document):
            continue
        chunks.append(f"--- Page {index + 1}/{len(document)} ---\n\n{document[index].get_text()}")
    return "\n".join(chunks)


def extract_markdown(path: str, pages: list[int] | None = None) -> str:
    import pymupdf4llm

    return str(pymupdf4llm.to_markdown(path, pages=pages))


def extract_tables(path: str) -> str:
    import pymupdf

    document = pymupdf.open(path)
    chunks: list[str] = []
    for page_index, page in enumerate(document):
        tables = page.find_tables()
        for table_index, table in enumerate(tables.tables):
            chunks.append(
                f"--- Page {page_index + 1}, Table {table_index + 1} ---\n\n"
                f"{table.to_pandas().to_markdown(index=False)}"
            )
    return "\n".join(chunks)


def extract_images(path: str, output_dir: str) -> str:
    import pymupdf

    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    document = pymupdf.open(path)
    count = 0
    for page_index, page in enumerate(document):
        for image_index, image in enumerate(page.get_images(full=True)):
            pixmap = pymupdf.Pixmap(document, image[0])
            if pixmap.n >= 5:
                pixmap = pymupdf.Pixmap(pymupdf.csRGB, pixmap)
            output_path = destination / f"page{page_index + 1}_img{image_index + 1}.png"
            pixmap.save(output_path)
            count += 1
    return f"Extracted {count} images to {destination.resolve()}"


def show_metadata(path: str) -> str:
    import pymupdf

    document = pymupdf.open(path)
    return json.dumps({
        "pages": len(document),
        "title": document.metadata.get("title", ""),
        "author": document.metadata.get("author", ""),
        "subject": document.metadata.get("subject", ""),
        "creator": document.metadata.get("creator", ""),
        "producer": document.metadata.get("producer", ""),
        "format": document.metadata.get("format", ""),
    }, indent=2, ensure_ascii=False)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document", help="Input document path")
    parser.add_argument("-o", "--output", help="Write textual output to this UTF-8 file")
    parser.add_argument("--pages", help="Zero-based page indexes, such as 0-4 or 0,2,5")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--markdown", action="store_true", help="Extract Markdown with pymupdf4llm")
    modes.add_argument("--tables", action="store_true", help="Extract detected tables as Markdown")
    modes.add_argument("--images", metavar="DIRECTORY", help="Extract embedded images")
    modes.add_argument("--metadata", action="store_true", help="Print document metadata as JSON")
    args = parser.parse_args()

    try:
        pages = parse_pages(args.pages)
        if args.metadata:
            output = show_metadata(args.document)
        elif args.tables:
            output = extract_tables(args.document)
        elif args.images:
            output = extract_images(args.document, args.images)
        elif args.markdown:
            output = extract_markdown(args.document, pages)
        else:
            output = extract_text(args.document, pages)
    except (ImportError, OSError, ValueError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2

    if args.output:
        destination = Path(args.output)
        destination.write_text(output, encoding="utf-8")
        print(json.dumps({"output": str(destination.resolve())}, ensure_ascii=False))
    else:
        print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
