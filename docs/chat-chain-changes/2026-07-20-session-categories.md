---
date: 2026-07-20
pr: pending
feature: Session categories
impact: New Web UI chat sessions can carry a global category id through their first run so the category is persisted with the self-built session row.
---

Adds Web UI-owned session categories, a nullable `sessions.category_id`, and categorized collapsible groups in the live Session List.
The category is metadata only: it does not alter model execution, worker scheduling, or the History page.
