# Product screenshots

Captured on 2026-09-10 from Ekko Studio v0.7.18, using the client at commit
`ae4af8df` (the preceding branding change only changes documentation and metadata).

- `workspace.png`: current chat components rendered with a fictional product-demo conversation through the existing Playwright API/socket fixtures.
- `workflow.png`: current workflow editor with a demonstration research → coding → review definition. The workflow is idle and has not been executed.
- `agent-manager.png`: the local installation’s actual agent status, with the conversation sidebar collapsed.
- `skills.png`: the actual Ekko Agent Skills page displaying the GitHub skill.

All four are direct Chromium screenshots at a 1440 × 960 CSS viewport and 2×
device scale (2880 × 1920 pixels). No UI elements were painted into the images.
The demo data stayed in the capture browser; no demo conversations or workflows
were saved to the user’s Studio database. Authentication state and private
conversation screenshots are not included in this directory.

The main README uses repository-relative image links. Inspect every replacement
at full size before publishing, including sidebar content, clipping, and loaded
fonts. Keep the English and Chinese README galleries synchronized.
