#!/usr/bin/env python3
"""Encrypt or decrypt a PDF with passwords (AES-256 via pypdf).

Note: permission flags set at encryption time are advisory — viewers may honor
them, but any PDF library can strip them. Only the user password gates content.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def read_password(value: str | None, file_path: str | None, label: str) -> str | None:
    if value is not None:
        return value
    if file_path is None:
        return None
    try:
        password = Path(file_path).read_text(encoding="utf-8").rstrip("\r\n")
    except OSError as error:
        raise ValueError(f"could not read {label} file: {error}") from error
    if not password:
        raise ValueError(f"{label} file is empty")
    return password


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    parser = argparse.ArgumentParser(description="Encrypt/decrypt PDFs (pypdf, AES-256).")
    parser.add_argument("pdf", help="Input PDF path")
    parser.add_argument("-o", "--output", required=True, help="Output PDF path")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--encrypt", action="store_true", help="Encrypt the PDF")
    mode.add_argument("--decrypt", action="store_true", help="Remove encryption (password required)")
    user_password = parser.add_mutually_exclusive_group()
    user_password.add_argument("--user-password", help="User password for --encrypt (visible in process arguments)")
    user_password.add_argument("--user-password-file", help="UTF-8 file containing the user password")
    owner_password = parser.add_mutually_exclusive_group()
    owner_password.add_argument("--owner-password", help="Owner password for --encrypt (visible in process arguments)")
    owner_password.add_argument("--owner-password-file", help="UTF-8 file containing the owner password")
    decrypt_password = parser.add_mutually_exclusive_group()
    decrypt_password.add_argument("--password", help="Known password for --decrypt (visible in process arguments)")
    decrypt_password.add_argument("--password-file", help="UTF-8 file containing the known password")
    args = parser.parse_args()

    try:
        user_password_value = read_password(
            args.user_password,
            args.user_password_file,
            "user password",
        )
        owner_password_value = read_password(
            args.owner_password,
            args.owner_password_file,
            "owner password",
        )
        decrypt_password_value = read_password(
            args.password,
            args.password_file,
            "password",
        )
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2

    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        print("Missing dependency: install with 'python3 -m pip install pypdf'", file=sys.stderr)
        return 2

    reader = PdfReader(args.pdf)
    if args.encrypt:
        if not user_password_value:
            print("Error: --encrypt requires --user-password or --user-password-file", file=sys.stderr)
            return 2
        if reader.is_encrypted:
            print("Error: input already encrypted; decrypt first", file=sys.stderr)
            return 3
        writer = PdfWriter()
        writer.append(reader)
        writer.encrypt(
            user_password=user_password_value,
            owner_password=owner_password_value or user_password_value,
            algorithm="AES-256",
        )
        action = "encrypted"
    else:
        if not reader.is_encrypted:
            print("Error: input is not encrypted", file=sys.stderr)
            return 3
        if decrypt_password_value is None or not reader.decrypt(decrypt_password_value):
            print("Error: wrong or missing --password/--password-file", file=sys.stderr)
            return 4
        writer = PdfWriter()
        writer.append(reader)
        action = "decrypted"

    with open(args.output, "wb") as fh:
        writer.write(fh)
    print(json.dumps({"output": args.output, "action": action, "page_count": len(reader.pages)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
