---
name: markdown-viewer
description: "Create rich diagrams, data visualizations, technical architecture views, and editorial content cards directly in Markdown using the Markdown Viewer Agent Skills pack. Use for Mermaid-like diagram requests, PlantUML architecture diagrams, Vega charts, JSON Canvas maps, infographics, UML, cloud/network/security/data/IoT diagrams, and polished Markdown documentation visuals."
version: 1.0.0
author: Ekko
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    source: markdown-viewer/skills
    tags: [markdown-viewer, diagrams, visualization, plantuml, vega, infographic, documentation]
prerequisites:
  commands: [node, npx]
---

# Markdown Viewer

Use this skill when the user wants a diagram, visualization, architecture view, data chart, technical documentation graphic, infographic, mind map, or editorial-quality content card directly inside Markdown.

Markdown Viewer Agent Skills is an opinionated skill pack for AI coding agents. It covers diagram generation, data visualization, and technical documentation using multiple Markdown-rendered engines, including PlantUML, Vega/Vega-Lite, JSON Canvas, infographic blocks, and direct HTML/CSS embeds.

## Setup

If the upstream skill pack is not installed, install it first:

```bash
npx skills add markdown-viewer/skills
```

After installation, prefer reading the specific upstream skill for the requested output type before writing complex diagrams. The pack includes detailed syntax rules, examples, and common pitfalls for each renderer.

## Skill Selection

Choose the smallest renderer that fits the user's goal:

| User goal | Use |
| --- | --- |
| Bar, line, scatter, heatmap, area, radar, word cloud, or data-driven chart | `vega` / `vega-lite` |
| KPI card, roadmap, timeline, SWOT, funnel, org chart, or structured visual summary | `infographic` |
| Free-position mind map, concept map, knowledge graph, or planning board | `canvas` |
| System layers, microservices, app/data/infrastructure layers | `architecture` |
| Editorial knowledge card, event card, data highlight, or polished content tile | `infocard` |
| UML class, sequence, activity, state, component, deployment, package, or use-case diagram | `uml` |
| AWS, Azure, GCP, Alibaba Cloud, Kubernetes, serverless, or multi-cloud diagram | `cloud` |
| LAN/WAN, data center, enterprise network, or device topology | `network` |
| Threat model, zero-trust, IAM, firewall, encryption, or compliance view | `security` |
| Enterprise architecture with business/application/technology layers | `archimate` |
| BPMN workflow, swim lanes, integration pattern, or value stream map | `bpmn` |
| ETL/ELT, warehouse, lakehouse, ML pipeline, or analytics workflow | `data-analytics` |
| Sensors, edge computing, smart factory/home, fleet, or digital twin view | `iot` |
| Hierarchical brainstorm tree or study outline | `mindmap` |

## Output Rules

- Write the result in Markdown unless the user asks for a separate file.
- Use the correct code fence for the chosen renderer:
  - `vega-lite` or `vega` for data charts.
  - `infographic` for infographic YAML blocks.
  - `canvas` for JSON Canvas maps.
  - `plantuml` or `puml` for UML, cloud, network, security, ArchiMate, BPMN, data analytics, IoT, and PlantUML mind maps.
- For `architecture` and `infocard`, embed the HTML/CSS directly in Markdown when that renderer expects raw HTML instead of a code fence.
- Keep diagrams focused. Prefer a clear, accurate first version over decorative complexity.
- Label nodes and edges with domain language the user already used.
- For technical diagrams, include enough structure to be useful in docs: boundaries, data flow, dependencies, trust zones, layers, or ownership where relevant.
- For data visualizations, include explicit sample data or use the data the user supplied. Do not invent real metrics without marking them as placeholders.
- For security or compliance diagrams, avoid implying guarantees. Show controls, boundaries, and risks factually.

## Workflow

1. Identify the user's artifact type: chart, diagram, architecture, process, mind map, infographic, or card.
2. Select the renderer from the guide above.
3. If the pack is installed locally, read the corresponding upstream `SKILL.md` for exact syntax and pitfalls.
4. Draft the Markdown artifact with the correct code fence or raw HTML/CSS style.
5. Check syntax before delivery: matching fences, valid JSON/YAML where required, PlantUML starts and ends correctly, and labels are readable.
6. If the user needs a file, save it as `.md` and include only the final artifact plus concise notes.

## Delivery

When finished, tell the user:

- which renderer or sub-skill you used;
- where the Markdown file is, if one was created;
- any placeholder data or assumptions;
- any viewer requirement, such as needing a Markdown Viewer extension or compatible renderer.

Do not use static screenshots when the user asked for Markdown-native visuals. The value of this skill is that the output stays editable, reviewable, and renderable from Markdown.
