# Recommended Skills

This page collects useful community skill repositories that can extend Hermes, Claude Code, Codex-style agents, and similar local agent workflows.

Community skills are third-party code and instructions. Review them before installing, especially when a skill can read API keys, cookies, browser sessions, local files, repositories, shell scripts, package managers, or social media accounts.

Useful skill recommendations are welcome. If you find a high-quality skill that should be listed here, please submit a pull request on GitHub with the repository link, usage scenario, and any security notes.

## Maintenance Guidelines

- Keep this document in English. Update `skill-recommendations.zh.md` separately for the Chinese version.
- Add recommendations under the closest existing category before creating a new category.
- Use the same structure for each item: repository link, focus, good-for scenarios, representative skills or capabilities when available, and notes when there are installation, API, or security concerns.
- Keep descriptions factual and concise. Prefer information confirmed from the repository README, `SKILL.md`, examples, or package metadata.
- Do not paste secrets, private tokens, install commands that auto-execute remote code, or unverifiable marketing claims.
- Put security-sensitive skills in context: mention when they can access credentials, browsers, local files, shells, package managers, external APIs, or social accounts.
- For unsupported locales, the UI falls back to this English document.

## Security First

- Treat every third-party skill as untrusted until reviewed.
- Read `SKILL.md`, scripts, hooks, and dependency installers before running.
- Be extra careful with skills that post to social media, access browsers, read credentials, install packages, execute shell commands, or send local files to external APIs.
- Prefer testing new skills in a disposable profile or sandboxed project first.
- Use a security review skill such as SlowMist Agent Security when evaluating unknown repositories, URLs, MCP servers, or skill packages.

## Official And General-Purpose Skills

### Anthropic Official Skills

- Repository: [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills)
- Focus: official reference skills for Claude-style agents.
- Good for: learning the expected skill structure, adapting stable examples, and bootstrapping common workflows.
- Representative skills: `docx`, `pdf`, `pptx`, `xlsx`, `frontend-design`, `webapp-testing`, `skill-creator`, `mcp-builder`, `theme-factory`, `web-artifacts-builder`.
- Notes: a good first source when you want conservative, well-structured examples.

### Matt Pocock Skills

- Repository: [mattpocock/skills](https://github.com/mattpocock/skills)
- Focus: engineering and productivity skills from a real development workflow.
- Good for: TypeScript engineering, test-driven work, triage, diagnosis, reviews, prototyping, and product handoff workflows.
- Representative skills: `tdd`, `triage`, `diagnose`, `prototype`, `review`, `to-prd`, `to-issues`, `handoff`, `write-a-skill`.
- Notes: useful when you want agent behavior that is direct, structured, and engineering-oriented.

## Design, Slides, And Visual Work

### Frontend Slides

- Repository: [zarazhangrui/frontend-slides](https://github.com/zarazhangrui/frontend-slides)
- Focus: creating web-native slide decks with frontend techniques.
- Good for: HTML/CSS slide decks, visual storytelling, and browser-rendered presentations.
- Notes: useful when a deck should be designed as a rich web artifact rather than a traditional office file.

### Huashu Design

- Repository: [alchaincyf/huashu-design](https://github.com/alchaincyf/huashu-design)
- Focus: HTML-native design work for Claude Code and agent workflows.
- Good for: high-fidelity prototypes, slides, animation concepts, visual review, and export-oriented design flows.
- Notes: includes design philosophy, review heuristics, and presentation-oriented workflows.

### Guizang PPT Skill

- Repository: [op7418/guizang-ppt-skill](https://github.com/op7418/guizang-ppt-skill)
- Focus: polished HTML slide decks with editorial, magazine, and Swiss-style layouts.
- Good for: presentation decks, social covers, image prompts, and visual narrative work.
- Notes: includes a presentation runtime and style-oriented slide generation patterns.

### HTML PPT Skill

- Repository: [lewislulu/html-ppt-skill](https://github.com/lewislulu/html-ppt-skill)
- Focus: HTML PPT Studio for professional HTML presentations.
- Good for: themed slide decks, layout-rich presentations, and animated browser presentations.
- Representative capabilities: multiple themes, layout templates, animation patterns, and HTML presentation scaffolding.

### PPT Image First

- Repository: [NyxTides/ppt-image-first](https://github.com/NyxTides/ppt-image-first)
- Focus: image-first presentation generation.
- Good for: decks where the visual direction should lead the content structure.
- Notes: designed for Codex, Claude Code, and OpenCode-style CLI agents.

### GPT Image To PPT

- Repository: [JuneYaooo/gpt-image2-ppt-skills](https://github.com/JuneYaooo/gpt-image2-ppt-skills)
- Focus: cloning or adapting PowerPoint visual layouts using image generation.
- Good for: recreating a deck style from an existing `.pptx` template while replacing the actual content.
- Notes: useful for template-driven presentations, but review external image generation/API behavior before use.

### Fireworks Tech Graph

- Repository: [yizhiyanhua-ai/fireworks-tech-graph](https://github.com/yizhiyanhua-ai/fireworks-tech-graph)
- Focus: technical diagram generation.
- Good for: architecture diagrams, workflow charts, UML-style visuals, AI agent workflow diagrams, and production-ready SVG/PNG outputs.
- Notes: a practical choice when you need diagrams rather than full slide decks.

### Diagram Skill

- Repository: [312362115/claude diagram skill](https://github.com/312362115/claude/blob/main/skills/diagram/SKILL.md)
- Focus: diagram generation inside a broader Claude skill collection.
- Good for: generating structured diagrams, templates, and visual explanations.
- Notes: this is a direct skill file link, so review the surrounding `references`, `scripts`, and `templates` folders before installing.

## Writing, Documents, And Knowledge Work

### Huashu Markdown To HTML

- Repository: [alchaincyf/huashu-md-html](https://github.com/alchaincyf/huashu-md-html)
- Focus: Markdown and HTML conversion pipelines.
- Good for: converting files or URLs to Markdown, turning Markdown into polished HTML, and converting HTML back to Markdown.
- Representative tools: MarkItDown, Pandoc, html-to-markdown, and trafilatura-based workflows.
- Notes: useful for content publishing, document cleanup, and HTML presentation pages.

### Chinese Web Novel Skill

- Repository: [Tomsawyerhu/Chinese-WebNovel-Skill](https://github.com/Tomsawyerhu/Chinese-WebNovel-Skill)
- Focus: Chinese web novel writing workflows.
- Good for: long-form fiction planning, chapter writing, style continuity, and web-novel oriented drafting.
- Representative skill: `webnovel-writing`.

### Software Copyright Skill

- Repository: [Fokkyp/SoftwareCopyright-Skill](https://github.com/Fokkyp/SoftwareCopyright-Skill)
- Focus: preparing Chinese software copyright application materials.
- Good for: generating `.docx` application documents from a local software project.
- Representative skills: `software-copyright-materials`, `docx-toolkit`.
- Notes: this may read local project files. Review file access and document generation behavior before running.

### Patent Disclosure Skill

- Repository: [handsomestWei/patent-disclosure-skill](https://github.com/handsomestWei/patent-disclosure-skill)
- Focus: patent disclosure drafting.
- Good for: extracting patentable points from project documents, novelty checks, desensitized drafting, and self-review loops.
- Notes: may involve web research and sensitive technical documents. Review data handling carefully.

## Image, Media, And Social Publishing

### Baoyu Skills

- Repository: [JimLiu/baoyu-skills](https://github.com/JimLiu/baoyu-skills)
- Focus: image generation, content transformation, publishing, and media workflows.
- Good for: image cards, article illustrations, slide decks, URL-to-Markdown conversion, YouTube transcripts, Markdown-to-HTML, and social posting workflows.
- Representative skills: `baoyu-image-gen`, `baoyu-imagine`, `baoyu-slide-deck`, `baoyu-markdown-to-html`, `baoyu-post-to-x`, `baoyu-post-to-wechat`, `baoyu-post-to-weibo`, `baoyu-url-to-markdown`, `baoyu-youtube-transcript`, `baoyu-translate`, `baoyu-diagram`, `baoyu-comic`.
- Security note: posting and web-reading skills may access account sessions, cookies, browser state, or external APIs. Review carefully before use.

### Virtual Couple Travel Vlog

- Repository: [vibeshotclub/vsc-skills / virtual-couple-travel-vlog](https://github.com/vibeshotclub/vsc-skills/tree/main/virtual-couple-travel-vlog)
- Focus: travel-vlog style media generation.
- Good for: short-form visual storytelling, character-based travel content, and repeatable media production prompts.
- Notes: this is a subdirectory skill inside a larger skill collection.

## Research, Web Access, And Content Monitoring

### Web Access

- Repository: [eze-is/web-access](https://github.com/eze-is/web-access)
- Focus: giving an agent structured web access through layered routing and browser/CDP workflows.
- Good for: web research, browser-assisted tasks, parallel information gathering, and pages that require interaction.
- Security note: browser access can expose logged-in sessions and local browser state. Audit before enabling.

### OpenCLI

- Repository: [jackwener/opencli](https://github.com/jackwener/opencli)
- Focus: converting websites, browser sessions, Electron apps, and local tools into CLI-accessible automation surfaces for humans and AI agents.
- Good for: letting agents operate logged-in Chrome pages, building reusable website adapters, wrapping local binaries, and turning browser workflows into deterministic commands.
- Representative skills: `opencli-browser`, `opencli-adapter-author`, `opencli-autofix`, `opencli-usage`.
- Security note: browser-backed commands can use logged-in sessions and local browser state. Review the extension, daemon, adapters, and any generated commands before enabling in sensitive profiles.

### Follow Builders

- Repository: [zarazhangrui/follow-builders](https://github.com/zarazhangrui/follow-builders)
- Focus: monitoring AI builders across X, blogs, and YouTube podcasts.
- Good for: tracking builders rather than influencers, summarizing feeds, and creating digest-style updates.
- Representative data/config files: X feeds, blog feeds, podcast feeds, prompts, and state files.
- Security note: any social or feed automation should be reviewed for account/session access.

### SlowMist Agent Security

- Repository: [slowmist/slowmist-agent-security](https://github.com/slowmist/slowmist-agent-security)
- Focus: security review for AI agents operating with untrusted inputs.
- Good for: checking skills, MCP servers, repositories, URLs, prompts, and crypto/on-chain addresses for security risks.
- Core idea: external input should be considered untrusted until verified.
- Notes: recommended before installing or running unfamiliar community skills.

## Persona, Thinking, And Advisory Skills

### Huashu Nuwa Skill

- Repository: [alchaincyf/nuwa-skill](https://github.com/alchaincyf/nuwa-skill)
- Focus: distilling a person or viewpoint into a reusable agent skill.
- Good for: advisory-board style thinking, mental models, decision heuristics, and writing in a specific perspective.
- Representative perspectives: Huashu Nuwa, Feynman, Steve Jobs, Elon Musk, Naval Ravikant, Paul Graham, Nassim Taleb.
- Notes: useful for brainstorming and viewpoint simulation, not for factual authority.

### PUA / Anti-PUA Skills

- Repository: [tanweai/pua](https://github.com/tanweai/pua)
- Focus: high-agency, confrontational, coaching, or anti-PUA style agent behavior.
- Good for: motivation, critique, resistance to manipulation, and intentionally sharp agent feedback.
- Representative skills: `pua`, `pua-en`, `pua-ja`, `pua-loop`, `mama`, `p7`, `p9`, `p10`, `pro`, `shot`, `yes`.
- Notes: these skills intentionally change tone and interaction style. Review before enabling in shared or user-facing environments.

### Ex Skill

- Repository: [therealXiaomanChu/ex-skill](https://github.com/therealXiaomanChu/ex-skill)
- Focus: distilling an ex-partner/persona into an AI skill that speaks in that style.
- Good for: persona experiments, emotional roleplay, and style simulation.
- Representative skill: `create-ex`.
- Notes: use carefully. Persona skills can strongly alter tone and emotional framing.

## Quick Shortlist

If you only want a practical starter set:

- [Anthropic Official Skills](https://github.com/anthropics/skills/tree/main/skills) for reference implementations.
- [Matt Pocock Skills](https://github.com/mattpocock/skills) for engineering workflows.
- [Baoyu Skills](https://github.com/JimLiu/baoyu-skills) for image, media, and publishing workflows.
- [Huashu Design](https://github.com/alchaincyf/huashu-design) for high-fidelity HTML-native design.
- [Guizang PPT Skill](https://github.com/op7418/guizang-ppt-skill) or [HTML PPT Skill](https://github.com/lewislulu/html-ppt-skill) for browser-based presentations.
- [Huashu Markdown To HTML](https://github.com/alchaincyf/huashu-md-html) for Markdown/HTML document conversion.
- [Web Access](https://github.com/eze-is/web-access) for web research workflows.
- [OpenCLI](https://github.com/jackwener/opencli) for logged-in browser automation and reusable website CLI adapters.
- [Fireworks Tech Graph](https://github.com/yizhiyanhua-ai/fireworks-tech-graph) for technical diagrams.
- [SlowMist Agent Security](https://github.com/slowmist/slowmist-agent-security) for reviewing risky community skills.

## Original Source List

This document was compiled from a curated Hermes / Claude skill sharing list and expanded with public GitHub repository metadata.
