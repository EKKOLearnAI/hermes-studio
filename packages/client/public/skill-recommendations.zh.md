# Skills 推荐清单

这是一份适合 Hermes、Claude Code、Codex 类本地 Agent 工作流的社区 Skill 推荐清单。它主要用于帮助你发现可安装、可参考或可改造的 Skill 来源。

社区 Skill 本质上是第三方指令和代码。安装前请先审计，尤其是会读取 API Key、Cookie、浏览器登录态、本地文件、仓库内容，或者会执行 shell、安装依赖、自动发帖、访问外部 API 的 Skill。

欢迎大家推荐各种好用的 Skill。如果你发现值得收录的高质量 Skill，可以到 GitHub 提交 PR，并附上仓库链接、适用场景和必要的安全说明。

## 维护规范

- 这份文档只维护中文内容；英文版请同步维护 `skill-recommendations.en.md`。
- 新增推荐时优先放入最接近的现有分类，不要轻易新增大类。
- 每个条目尽量保持同一结构：仓库链接、方向、适合场景、代表 Skills 或能力、必要备注。
- 描述要简洁、事实化，优先依据仓库 README、`SKILL.md`、示例或包元数据，不写无法验证的宣传语。
- 不要写入密钥、私有 token、会自动执行远程代码的安装命令，或无法确认来源的内容。
- 涉及安全风险的 Skill 要明确说明上下文，例如是否会访问凭据、浏览器、本地文件、shell、包管理器、外部 API 或社交账号。
- 前端只维护中文和英文两份推荐文档，其他语言统一回退到英文版。

## 安全优先

- 默认把所有第三方 Skill 当成不可信内容，审计后再启用。
- 安装前阅读 `SKILL.md`、脚本、hooks、依赖安装逻辑和插件配置。
- 对会访问浏览器、读取凭据、执行 shell、安装 npm/pip/brew 依赖、自动发帖或上传本地文件的 Skill 保持谨慎。
- 建议先在一次性 profile 或沙盒项目里测试新 Skill。
- 可以使用 SlowMist Agent Security 这类安全审计 Skill 来检查陌生仓库、URL、MCP、Skill 包和链上地址。

## 官方与通用 Skills

### Anthropic 官方 Skills

- 仓库：[anthropics/skills](https://github.com/anthropics/skills/tree/main/skills)
- 方向：Claude 官方参考 Skill。
- 适合：学习标准 Skill 结构、参考稳定实现、搭建通用工作流。
- 代表 Skills：`docx`、`pdf`、`pptx`、`xlsx`、`frontend-design`、`webapp-testing`、`skill-creator`、`mcp-builder`、`theme-factory`、`web-artifacts-builder`。
- 备注：如果你想找保守、规范、可参考的 Skill 示例，优先看这个。

### Matt Pocock Skills

- 仓库：[mattpocock/skills](https://github.com/mattpocock/skills)
- 方向：工程与生产力工作流。
- 适合：TypeScript 工程、TDD、问题诊断、代码评审、原型开发、PRD/Issue/Handoff 等开发流程。
- 代表 Skills：`tdd`、`triage`、`diagnose`、`prototype`、`review`、`to-prd`、`to-issues`、`handoff`、`write-a-skill`。
- 备注：适合希望 Agent 更像工程协作者时使用。

## 设计、幻灯片与可视化

### Frontend Slides

- 仓库：[zarazhangrui/frontend-slides](https://github.com/zarazhangrui/frontend-slides)
- 方向：用前端技术生成网页幻灯片。
- 适合：HTML/CSS 幻灯片、视觉叙事、浏览器渲染的演示稿。
- 备注：适合把演示稿当成 Web Artifact 来做，而不是传统 Office 文件。

### 华叔 Design

- 仓库：[alchaincyf/huashu-design](https://github.com/alchaincyf/huashu-design)
- 方向：Claude Code 中的 HTML 原生设计 Skill。
- 适合：高保真原型、幻灯片、动画概念、视觉评审和导出型设计流程。
- 备注：包含设计哲学、评审维度和演示型工作流。

### 归藏 PPT Skill

- 仓库：[op7418/guizang-ppt-skill](https://github.com/op7418/guizang-ppt-skill)
- 方向：生成高质量 HTML 幻灯片。
- 适合：杂志风、编辑风、瑞士风等视觉风格的演示稿、社交封面、图片提示词和叙事型页面。
- 备注：包含演示运行时和风格化生成模式。

### HTML PPT Skill

- 仓库：[lewislulu/html-ppt-skill](https://github.com/lewislulu/html-ppt-skill)
- 方向：HTML PPT Studio。
- 适合：主题化幻灯片、复杂布局演示稿和带动画的浏览器演示。
- 代表能力：多主题、多布局、动画模式和 HTML 演示脚手架。

### PPT Image First

- 仓库：[NyxTides/ppt-image-first](https://github.com/NyxTides/ppt-image-first)
- 方向：图片优先的 PPT 生成。
- 适合：视觉方向先行的演示稿创作。
- 备注：面向 Codex、Claude Code、OpenCode CLI 等 Agent 工作流。

### GPT Image To PPT

- 仓库：[JuneYaooo/gpt-image2-ppt-skills](https://github.com/JuneYaooo/gpt-image2-ppt-skills)
- 方向：用图像生成能力复刻或改造 PPT 视觉版式。
- 适合：从已有 `.pptx` 模板中学习版式，再替换成自己的内容。
- 备注：涉及图像生成和外部 API 时请先检查配置与数据发送逻辑。

### Fireworks Tech Graph

- 仓库：[yizhiyanhua-ai/fireworks-tech-graph](https://github.com/yizhiyanhua-ai/fireworks-tech-graph)
- 方向：技术图表生成。
- 适合：架构图、流程图、UML 风格图、AI Agent 工作流图，以及 SVG/PNG 输出。
- 备注：需要图表而不是整套演示稿时很实用。

### Diagram Skill

- 仓库：[312362115/claude diagram skill](https://github.com/312362115/claude/blob/main/skills/diagram/SKILL.md)
- 方向：结构化图表生成。
- 适合：生成图表、模板化视觉解释和技术说明。
- 备注：这是一个直接指向 `SKILL.md` 的链接，安装前也要检查同目录下的 `references`、`scripts` 和 `templates`。

## 写作、文档与知识工作

### 华叔 Markdown To HTML

- 仓库：[alchaincyf/huashu-md-html](https://github.com/alchaincyf/huashu-md-html)
- 方向：Markdown 与 HTML 双向转换流水线。
- 适合：把文件或网页转 Markdown，把 Markdown 转精美 HTML，把 HTML 再转回 Markdown。
- 代表工具：MarkItDown、Pandoc、html-to-markdown、trafilatura。
- 备注：适合内容发布、文档清理和 HTML 页面生成。

### 中文网文写作 Skill

- 仓库：[Tomsawyerhu/Chinese-WebNovel-Skill](https://github.com/Tomsawyerhu/Chinese-WebNovel-Skill)
- 方向：中文网文小说写作。
- 适合：长篇小说规划、章节创作、风格延续和网文式叙事。
- 代表 Skill：`webnovel-writing`。

### 软件著作权材料 Skill

- 仓库：[Fokkyp/SoftwareCopyright-Skill](https://github.com/Fokkyp/SoftwareCopyright-Skill)
- 方向：中国软件著作权申请材料生成。
- 适合：根据本地项目生成 `.docx` 软著申请材料。
- 代表 Skills：`software-copyright-materials`、`docx-toolkit`。
- 备注：可能读取本地项目文件，运行前请审计文件访问和文档生成逻辑。

### 专利交底书 Skill

- 仓库：[handsomestWei/patent-disclosure-skill](https://github.com/handsomestWei/patent-disclosure-skill)
- 方向：专利技术交底书生成。
- 适合：从项目文档挖掘专利点、联网查新、脱敏成文和自检。
- 备注：可能涉及敏感技术资料和联网检索，使用前请关注数据处理方式。

## 图片、媒体与社交发布

### 宝玉 Skills

- 仓库：[JimLiu/baoyu-skills](https://github.com/JimLiu/baoyu-skills)
- 方向：图片生成、内容转换、发布和媒体工作流。
- 适合：图片卡片、文章配图、幻灯片、URL 转 Markdown、YouTube 字幕、Markdown 转 HTML、社交平台发布。
- 代表 Skills：`baoyu-image-gen`、`baoyu-imagine`、`baoyu-slide-deck`、`baoyu-markdown-to-html`、`baoyu-post-to-x`、`baoyu-post-to-wechat`、`baoyu-post-to-weibo`、`baoyu-url-to-markdown`、`baoyu-youtube-transcript`、`baoyu-translate`、`baoyu-diagram`、`baoyu-comic`。
- 安全提示：发帖和网页读取类 Skill 可能访问账号会话、Cookie、浏览器状态或外部 API，使用前务必审计。

### Virtual Couple Travel Vlog

- 仓库：[vibeshotclub/vsc-skills / virtual-couple-travel-vlog](https://github.com/vibeshotclub/vsc-skills/tree/main/virtual-couple-travel-vlog)
- 方向：旅行 vlog 风格媒体生成。
- 适合：短视频视觉叙事、角色化旅行内容和可复用媒体提示词。
- 备注：这是一个大仓库里的子目录 Skill。

## Web 访问、研究与内容监控

### Web Access

- 仓库：[eze-is/web-access](https://github.com/eze-is/web-access)
- 方向：为 Agent 提供结构化联网能力。
- 适合：网页研究、浏览器辅助任务、并行信息收集和需要交互的网站。
- 安全提示：浏览器访问可能暴露已登录状态和本地浏览器数据，启用前要审计。

### OpenCLI

- 仓库：[jackwener/opencli](https://github.com/jackwener/opencli)
- 方向：把网站、浏览器会话、Electron 应用和本地工具转换成 CLI 可调用的自动化入口。
- 适合：让 Agent 操作已登录的 Chrome 页面、编写可复用网站适配器、封装本地命令，以及把浏览器流程变成稳定命令。
- 代表 Skills：`opencli-browser`、`opencli-adapter-author`、`opencli-autofix`、`opencli-usage`。
- 安全提示：浏览器命令可能使用已登录会话和本地浏览器状态。启用前请审计扩展、daemon、适配器和生成的命令，敏感 profile 里尤其要谨慎。

### Follow Builders

- 仓库：[zarazhangrui/follow-builders](https://github.com/zarazhangrui/follow-builders)
- 方向：跟踪 AI builders 的 X、博客和 YouTube 播客内容。
- 适合：关注 builder 而不是 influencer，生成摘要和内容 digest。
- 代表内容：X feed、blog feed、podcast feed、prompts 和状态文件。
- 安全提示：社交和 feed 自动化要关注账号、Cookie 和访问权限。

### SlowMist Agent Security

- 仓库：[slowmist/slowmist-agent-security](https://github.com/slowmist/slowmist-agent-security)
- 方向：AI Agent 安全审计框架。
- 适合：检查 Skill、MCP、仓库、URL、Prompt 和链上地址的安全风险。
- 核心原则：所有外部输入在验证前都不可信。
- 备注：安装陌生社区 Skill 前建议优先使用。

## Persona、思维方式与顾问类 Skills

### 华叔 Nuwa Skill

- 仓库：[alchaincyf/nuwa-skill](https://github.com/alchaincyf/nuwa-skill)
- 方向：把某个人或视角蒸馏成可复用 Skill。
- 适合：顾问团式思考、心智模型、决策启发式和特定视角写作。
- 代表视角：华叔 Nuwa、Feynman、Jobs、Musk、Naval、Paul Graham、Taleb。
- 备注：适合头脑风暴和视角模拟，不应当作事实权威。

### PUA / 反 PUA 类 Skills

- 仓库：[tanweai/pua](https://github.com/tanweai/pua)
- 方向：高能动性、强反馈、反操控或尖锐教练风格的 Agent 行为。
- 适合：动机强化、批判反馈、反操控和刻意强风格交互。
- 代表 Skills：`pua`、`pua-en`、`pua-ja`、`pua-loop`、`mama`、`p7`、`p9`、`p10`、`pro`、`shot`、`yes`。
- 备注：这类 Skill 会明显改变语气和互动方式，不建议直接用于共享或面向用户的环境。

### Ex Skill

- 仓库：[therealXiaomanChu/ex-skill](https://github.com/therealXiaomanChu/ex-skill)
- 方向：把某个前任/人格风格蒸馏成 AI Skill。
- 适合：Persona 实验、情绪化角色扮演和特定语气模拟。
- 代表 Skill：`create-ex`。
- 备注：Persona 类 Skill 可能强烈影响语气和情绪框架，使用前请确认场景合适。

## 快速推荐

如果你只想先装一批实用的，可以从这些开始：

- [Anthropic 官方 Skills](https://github.com/anthropics/skills/tree/main/skills)：参考实现和通用能力。
- [Matt Pocock Skills](https://github.com/mattpocock/skills)：工程流程。
- [宝玉 Skills](https://github.com/JimLiu/baoyu-skills)：图片、媒体和发布。
- [华叔 Design](https://github.com/alchaincyf/huashu-design)：高保真 HTML 设计。
- [归藏 PPT Skill](https://github.com/op7418/guizang-ppt-skill) 或 [HTML PPT Skill](https://github.com/lewislulu/html-ppt-skill)：浏览器演示稿。
- [华叔 Markdown To HTML](https://github.com/alchaincyf/huashu-md-html)：Markdown/HTML 文档转换。
- [Web Access](https://github.com/eze-is/web-access)：网页研究。
- [OpenCLI](https://github.com/jackwener/opencli)：已登录浏览器自动化和可复用网站 CLI 适配器。
- [Fireworks Tech Graph](https://github.com/yizhiyanhua-ai/fireworks-tech-graph)：技术图表。
- [SlowMist Agent Security](https://github.com/slowmist/slowmist-agent-security)：社区 Skill 安全审计。

## 来源说明

本文档基于一份 Hermes / Claude Skills 分享清单整理，并补充了公开 GitHub 仓库描述与目录信息。
