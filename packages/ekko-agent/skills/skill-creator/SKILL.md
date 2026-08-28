---
name: skill-creator
description: Create, revise, extend, or archive reusable Ekko Agent Skills in the current Profile using Ekko's managed Skill tools.
metadata:
  keywords:
    - create skill
    - edit skill
    - skill creator
    - update skill
---

# Ekko Skill creator

Use this Skill when the user wants to create a new reusable Skill or maintain an existing one in the current Ekko Profile.

## Design the right Skill

A Skill should provide reusable, non-obvious guidance that changes how Ekko handles a recognizable class of requests. Do not turn a one-off answer, a temporary workaround, or an unrelated product preference into a permanent Skill.

- Preserve the user's requested scope, tools, and authorization boundaries.
- Assume the model already has general reasoning ability; include domain knowledge, decision criteria, fragile procedures, or reusable automation that materially improves results.
- Make the frontmatter description concise and discriminating for fallback discovery.
- Maintain a compact `metadata.keywords` list of specific English phrases for host-side exact matching. These keywords are not injected into the model; Ekko injects only available Skill names and lets the main model map requests in any language to a name before calling `skill_view`.
- Keep shared instructions in SKILL.md. Put substantial conditional detail in references and load it only when relevant.
- Add scripts only when deterministic repeated execution is more reliable than recreating the logic each time.
- Refer only to tools and Skills available in the target Ekko environment.

Ask a question only when missing information would materially change the Skill's purpose, location, side effects, or supported workflow.

## Ekko Skill structure

Every Skill requires:

    skill-name/
    └── SKILL.md

Optional text resources supported by skill_manage:

    references/   Detailed guidance needed only in particular modes
    templates/    Reusable text templates
    scripts/      Node.js, Python, or shell helpers
    assets/       Text assets used in generated output

Do not create empty directories, placeholder examples, README files, changelogs, or duplicated quick references without a concrete need. skill_manage writes UTF-8 text support files; do not encode binary assets into text. If a Skill genuinely requires a binary asset, explain that it must be imported through an appropriate file or UI workflow.

## Create a Skill

1. Call skill_list with a focused query. Update an existing matching Skill instead of creating a duplicate.
2. Choose a name of at most 64 characters using lowercase letters, digits, hyphens, or underscores, with an alphanumeric first and last character.
3. Prepare complete SKILL.md content with scalar name and description fields plus a non-empty keyword list:

       ---
       name: example-skill
       description: Handle a specific reusable workflow and state when it applies.
       metadata:
         keywords:
           - exact user phrase
           - specific workflow phrase
       ---

       # Example Skill

       Essential instructions.

4. Call skill_manage with action=create, the exact name, and the complete content. Use category only when the user requested or the Profile already uses a meaningful single-level category.
5. Add necessary support files with action=write_file. Paths must stay under references/, templates/, scripts/, or assets/.
6. Confirm discovery with skill_list, then load the result with skill_view.

Choose keywords that are specific enough to avoid unrelated matches. Prefer 3–5 short English phrases, use ASCII text or technical identifiers only, and avoid generic single words such as `file`, `code`, `help`, or `tool`. The Skill name is always matched separately, so do not repeat it unless its spaced form is a useful phrase. Do not add translations, exhaustive synonyms, regexes, descriptions, or whole example prompts to `metadata.keywords`; multilingual routing belongs to the main model using the injected Skill names.

skill_manage validates the required frontmatter, matching name, non-empty metadata.keywords, description, and non-empty Markdown body. Fix a reported validation error instead of bypassing the managed tool.

## Update an existing Skill

Call skill_list, then read the exact target with skill_view in the same run before any mutation.

- Prefer action=patch for a focused change. Provide a unique oldString and its replacement.
- Use action=edit only when a substantial rewrite is necessary.
- Review and update `metadata.keywords` whenever the Skill's supported requests or boundaries change. Preserve still-valid keywords for narrow edits.
- Read a support file with skill_view before overwriting, patching, or removing that existing file.
- After each successful mutation, call skill_view again before making another change; the read-before-write guard is intentionally consumed.
- Preserve useful existing instructions and resources unless the user asked to replace or remove them.

Managed replacements create recoverable backups. Built-in Skills cannot be deleted. Deleting a user-created Skill requires clear user intent, a same-run skill_view, and action=delete with confirmed=true; Ekko archives it instead of erasing it.

## Validate behavior

After creation or revision:

1. Confirm skill_list returns the intended name and discriminating description, then use skill_view to inspect the internal keyword metadata.
2. Use skill_view to inspect the final SKILL.md and every changed support file.
3. Execute new or changed scripts on a safe representative input with terminal_exec. Check dependencies first and do not install them silently.
4. Test representative positive and negative English phrases when practical: intended exact phrases should hard-match, while nearby unrelated requests should not. For other languages, verify that the main model can select the injected Skill name and call skill_view. Also test observable workflow invariants; avoid tests that only assert headings or exact prose.
5. Report what was created or changed, any validation limitation, and whether external dependencies or binary assets remain for the user.

Improve a Skill from demonstrated usage failures with the narrowest correction that resolves the problem. Do not accumulate universal rules for every isolated example.
