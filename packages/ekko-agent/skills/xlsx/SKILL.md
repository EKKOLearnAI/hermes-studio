---
name: xlsx
description: Create, inspect, edit, restructure, recalculate, convert, and visually verify Excel .xlsx workbooks and CSV data.
metadata:
  keywords:
    - .xlsx
    - excel workbook
    - spreadsheet
    - excel formulas
---

# Excel workbooks

Use this Skill for .xlsx and CSV creation, analysis, editing, restructuring, formula work, and export.

## Start here

Call skill_view for this Skill and use its baseDirectory; helpers live under <baseDirectory>/scripts.

Default to a new output file. Inspect workbook sheets, dimensions, formulas, merged cells, names, tables, charts, validations, hidden content, and external links before modifying an existing file.

Core dependency:

    python3 -m pip install openpyxl

Formula recalculation and visual rendering may require LibreOffice. Check first and do not silently install dependencies.

## Helpers

- xlsx_read.py: inspect workbook values, formulas, styles, structure, and metadata.
- xlsx_create.py: create a workbook from structured JSON.
- xlsx_edit.py: perform targeted cell, range, formula, style, row, column, and sheet edits.
- xlsx_restructure.py: split, merge, normalize, pivot, or reshape tabular data.
- xlsx_recalc.py: recalculate through LibreOffice when available.
- csv_to_xlsx.py and xlsx_to_csv.py: convert formats.

Run helpers through terminal_exec with python3 and an argument array. Use --help for exact options.

    python3 <baseDirectory>/scripts/xlsx_read.py input.xlsx --json
    python3 <baseDirectory>/scripts/xlsx_create.py spec.json -o output.xlsx
    python3 <baseDirectory>/scripts/xlsx_edit.py input.xlsx edits.json -o output.xlsx
    python3 <baseDirectory>/scripts/xlsx_recalc.py output.xlsx

For non-trivial data reshaping, read references/restructuring.md through skill_view.

## Workflow

1. Inspect the workbook and identify the authoritative sheets, headers, formulas, and units.
2. Validate source data types and row counts before transforming data.
3. Apply the smallest requested edit into a new workbook.
4. Re-read formulas and values. Recalculate when the output depends on formula results.
5. For visible formatting or charts, export relevant sheets to PDF with LibreOffice, render the pages with the bundled pdf Skill, and inspect them using view_image.
6. Return the absolute path plus any assumptions about formulas, locale, dates, or missing recalculation.

## Data integrity

- Never invent missing values. Mark unknown data explicitly.
- Preserve formulas unless the user asks to replace them with values.
- Treat hidden sheets, filters, named ranges, validations, macros, and external links as meaningful.
- .xlsx sheet protection is not encryption; do not represent it as secure access control.
- Do not execute workbook macros or refresh untrusted external data sources.
