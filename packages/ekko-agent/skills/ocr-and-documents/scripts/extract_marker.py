#!/usr/bin/env python3
"""Extract Markdown or JSON from documents with marker-pdf."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path


def convert(
    path: str,
    output_dir: str | None = None,
    output_format: str = "markdown",
    use_llm: bool = False,
) -> str:
    from marker.config.parser import ConfigParser
    from marker.converters.pdf import PdfConverter
    from marker.models import create_model_dict

    config_parser = ConfigParser({"use_llm": True} if use_llm else {})
    converter = PdfConverter(
        config=config_parser.generate_config_dict(),
        artifact_dict=create_model_dict(),
    )
    rendered = converter(path)

    if output_format == "json":
        output = json.dumps({
            "markdown": rendered.markdown,
            "metadata": rendered.metadata if hasattr(rendered, "metadata") else {},
        }, indent=2, ensure_ascii=False)
    else:
        output = rendered.markdown

    if output_dir and getattr(rendered, "images", None):
        destination = Path(output_dir)
        destination.mkdir(parents=True, exist_ok=True)
        for name, image_data in rendered.images.items():
            image_path = destination / name
            if hasattr(image_data, "save"):
                image_data.save(image_path)
            else:
                image_path.write_bytes(image_data)
        print(
            f"Saved {len(rendered.images)} image(s) to {destination.resolve()}",
            file=sys.stderr,
        )
    return output


def check_requirements() -> int:
    free_gb = shutil.disk_usage(Path.cwd().anchor or os.sep).free / (1024**3)
    if free_gb < 5:
        print(f"Only {free_gb:.1f}GB free. marker-pdf needs about 5GB.")
        print("Use extract_pymupdf.py or free disk space.")
        return 1
    print(f"{free_gb:.1f}GB free; sufficient for marker-pdf.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document", nargs="?", help="Input document path")
    parser.add_argument("-o", "--output", help="Write Markdown or JSON to this UTF-8 file")
    parser.add_argument("--output-dir", "--output_dir", help="Directory for extracted images")
    parser.add_argument("--json", action="store_true", help="Emit structured JSON")
    parser.add_argument("--use-llm", "--use_llm", action="store_true", help="Enable marker's configured LLM enhancement")
    parser.add_argument("--check", action="store_true", help="Check disk space without loading marker")
    args = parser.parse_args()

    if args.check:
        return check_requirements()
    if not args.document:
        parser.error("document is required unless --check is used")

    try:
        output = convert(
            args.document,
            output_dir=args.output_dir,
            output_format="json" if args.json else "markdown",
            use_llm=args.use_llm,
        )
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
