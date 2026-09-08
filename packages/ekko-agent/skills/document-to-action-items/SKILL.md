---
name: document-to-action-items
description: Turn documents, notes, transcripts, and meeting records into traceable action items, decisions, owners, deadlines, and follow-ups without inventing missing commitments.
metadata:
  keywords:
    - action items
    - meeting action items
    - document to tasks
---

# Document to action items

Use this Skill when the user wants a document converted into tasks, decisions, follow-ups, or an execution plan.

## Read the source accurately

Use the matching built-in Skill:

- .docx: docx
- PDF: pdf, with ocr-and-documents only when normal extraction fails
- .pptx: powerpoint
- .xlsx or CSV: xlsx
- plain text or Markdown: read_file

For a URL, use an available browser or HTTP tool, keep the source URL, and do not assume a specific connector exists.

## Extraction rules

Separate these categories:

- Action: an explicit or strongly implied task.
- Owner: only a named person or role actually assigned in the source.
- Deadline: preserve the exact date, time, and timezone; resolve relative dates against the document date only when that date is known.
- Decision: an agreed outcome, not a proposal.
- Open question: unresolved information or ownership.
- Dependency or risk: something that can block the action.
- Evidence: page, slide, sheet/cell, section, paragraph, timestamp, or source URL.

Do not invent an owner, deadline, priority, or decision. Use Unassigned, No deadline stated, or Needs confirmation when the source is silent.

## Output

Use a compact table by default:

| Action | Owner | Deadline | Status | Dependency/Risk | Evidence |
|---|---|---|---|---|---|

Then list decisions and open questions separately. Deduplicate repeated actions without losing distinct evidence.

## External writes

Creating tasks, calendar events, tickets, reminders, or database records changes external state. First show the proposed items and confirm the destination and scope unless the user already gave explicit authorization. Use only tools that are actually available, preserve source links in created records, and verify each write. Report partial failures precisely; never claim an item was created without a successful result.
