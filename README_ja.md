<p align="center">
  <strong>Hermes Web UI</strong>
  <a href="./README.md">English</a> |
  <a href="./README_zh.md">中文</a> |
  <a href="./README_ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a> 向けのフル機能 Web ダッシュボードです。<br/>
  AI チャットセッションの管理、使用量とコストの監視、プラットフォームチャネルの設定、<br/>
  Cron ジョブの管理、スキルの閲覧を、すべてクリーンでレスポンシブな Web UI から行えます。
</p>

<p align="center">
  <code>npm install -g hermes-web-ui && hermes-web-ui start</code>
</p>

<p align="center">
  <img src="https://github.com/EKKOLearnAI/hermes-web-ui/blob/main/packages/client/src/assets/image1.png" alt="Hermes Web UI デモ" width="680"/>
</p>

<p align="center">
  <img src="https://github.com/EKKOLearnAI/hermes-web-ui/blob/main/packages/client/src/assets/image2.png" alt="Hermes Web UI デモ" width="680"/>
</p>

<p align="center">
  <strong>モバイル版</strong>
</p>

<p align="center">
  <video src="https://github.com/EKKOLearnAI/hermes-web-ui/blob/main/packages/client/src/assets/video.mp4?raw=true" width="360" controls></video>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/hermes-web-ui"><img src="https://img.shields.io/npm/v/hermes-web-ui?style=flat-square&color=blue" alt="npm version"/></a>
  <a href="https://github.com/EKKOLearnAI/hermes-web-ui/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/hermes-web-ui?style=flat-square" alt="license"/></a>
  <a href="https://github.com/EKKOLearnAI/hermes-web-ui/stargazers"><img src="https://img.shields.io/github/stars/EKKOLearnAI/hermes-web-ui?style=flat-square" alt="stars"/></a>
</p>

---

## 機能

### AI チャット

- Socket.IO `/chat-run` によるリアルタイムのチャットストリーミング。実行は Hermes agent bridge 経由
- 複数セッション管理: 作成、名前変更、削除、切り替え
- **独自セッションデータベース**: Web UI セッションはローカル SQLite に保存。Hermes state.db は Hermes 履歴 API 用の読み取り専用ソース
- Telegram、Discord、Slack などのソース別セッショングルーピングと折りたたみ表示
- アクティブセッションのリアルタイムインジケータ — 実行中のセッションを上部に固定し、スピナーで状態を表示
- 最新メッセージ時刻によるセッション並び替え
- Markdown レンダリング、シンタックスハイライト、コードコピー
- ツール呼び出し詳細の展開表示（引数 / 結果）
- Profile 単位で分離されたファイルアップロード
- ファイルダウンロード — 解決されたパス経由でユーザーアップロードファイルと Agent 生成ファイルの両方をダウンロード可能。local、Docker、SSH、Singularity など複数の terminal backend に対応
- セッション検索: Ctrl+K で Web UI ローカルセッション DB を検索。読み取り専用の Hermes 履歴セッションは対象外
- アカウントがアクセス可能な Hermes Profile から利用可能モデルを検出するモデルセレクター
- セッションごとのモデルバッジとコンテキスト Token 使用量表示

### プラットフォームチャネル

1 つの画面で **8 つのプラットフォーム**をまとめて設定できます。

| プラットフォーム | 機能 |
| --- | --- |
| Telegram | Bot token、メンション制御、リアクション、自由返信チャット |
| Discord | Bot token、メンション、自動スレッド、リアクション、チャンネル許可/拒否リスト |
| Slack | Bot token、メンション制御、Bot メッセージ処理 |
| WhatsApp | 有効/無効、メンション制御、メンションパターン |
| Matrix | Access token、Homeserver、自動スレッド、DM メンションスレッド |
| Feishu (Lark) | App ID / Secret、メンション制御 |
| WeChat | QR コードログイン（ブラウザでスキャンし、認証情報を自動保存） |
| WeCom | Bot ID / Secret |

- 認証情報は `~/.hermes/.env` に書き込み
- チャネル動作設定は `~/.hermes/config.yaml` に書き込み
- プラットフォームごとの設定済み/未設定ステータス検出

### 使用量分析

- Token 使用量の内訳（入力 / 出力）
- セッション数と日次平均
- 推定コストとキャッシュヒット率
- モデル使用分布チャート
- 30 日間の日次トレンド（棒グラフ + データテーブル）

### スケジュールジョブ

- Cron ジョブの作成、編集、一時停止、再開、削除
- 即時実行
- Cron 式のクイックプリセット

### モデル管理

- 認証情報プール（`~/.hermes/auth.json`）からモデルを自動検出
- 各 Provider エンドポイント（`/v1/models`）から利用可能モデルを取得
- Provider の追加、更新、削除（プリセットおよび OpenAI 互換カスタム）
- OpenAI Codex と Nous Portal OAuth ログイン
- `/v4` など非 v1 API バージョンの Provider URL 自動検出
- Provider 単位のモデルグループ化とデフォルトモデル切り替え

### マルチ Profile

- Hermes Profile の作成、名前変更、削除、切り替え
- 既存 Profile の複製、または `.tar.gz` アーカイブからのインポート
- バックアップや共有のための Profile エクスポート
- 設定、キャッシュ、アップロード、セッション、ジョブ、使用量、メモリ、スキル、プラグイン、Provider、モデル表示を Profile 単位で分離
- アカウントに紐づく Profile 権限: スーパー管理者はすべての Profile を管理可能。一般管理者は割り当てられた Profile のみ利用可能

### ファイルブラウザー

- local、Docker、SSH、Singularity backend 上のファイルを閲覧
- ファイルのアップロード、ダウンロード、名前変更、コピー、移動、削除
- アップロードファイルは選択/要求された Hermes Profile 配下に保存。Agent が生成したアップロードディレクトリ外の成果物もパス解決によりダウンロード可能
- ディレクトリ作成
- シンタックスハイライト付きのファイル内容表示

### グループチャット

- Socket.IO によるリアルタイムなマルチ Agent チャットルーム
- @メンションルーティング: Agent をメンションして文脈付き返信を実行
- コンテキスト圧縮: 履歴が Token 閾値を超えたときに自動要約
- 入力状態と返信進行状況の表示
- ルーム作成、削除、招待コード管理
- Agent 管理: ルーム内 Agent の追加/削除と Agent ごとの Profile 指定
- SQLite によるメッセージ永続化
- モバイル対応の折りたたみサイドバー

### スキルとメモリ

- インストール済みスキルの閲覧と検索
- スキル詳細と関連ファイルの表示
- ユーザーノートと Profile 管理

### ログ

- Agent / Server / Error ログの表示
- ログレベル、ログファイル、キーワードによるフィルタリング
- 構造化ログ解析と HTTP アクセスログのハイライト

### 認証

- Token ベース認証（初回起動時に自動生成、または `AUTH_TOKEN` 環境変数で指定）
- ユーザー名/パスワードログインと Settings 内のアカウント管理
- デフォルトの bootstrap 認証情報は `admin` / `123456` です。ログイン後、デフォルトのユーザー名とパスワードを変更するよう促されます
- スーパー管理者はユーザーと Profile の紐づけを管理可能。一般管理者は自分のアカウント情報のみ管理可能

CLI メンテナンスコマンド:

```bash
# 永続化されたログイン IP ロック記録を削除
hermes-web-ui clear-login-locks

# ログインロックを削除し、実行中の Web UI プロセスを再起動
hermes-web-ui clear-login-locks --restart

# デフォルトのスーパー管理者を admin / 123456 として作成またはリセット
hermes-web-ui reset-default-login
```

`clear-login-locks` は `${HERMES_WEB_UI_HOME:-~/.hermes-web-ui}/.login-lock.json` を削除します。サーバーが実行中の場合、メモリ上のロック状態を消すには再起動が必要です。`reset-default-login` は Web UI アカウントデータベースを更新します。`admin` ユーザーが既に存在する場合、パスワードを `123456` にリセットし、スーパー管理者として有効化します。

### 設定

- 表示（ストリーミング、コンパクトモード、推論表示、コスト表示）
- Agent（最大ターン数、タイムアウト、ツール強制）
- メモリ（有効/無効、文字数制限）
- セッションリセット（アイドルタイムアウト、スケジュールリセット）
- プライバシー（PII マスキング）
- モデル設定（デフォルトモデル & Provider）
- Profile と Provider 設定

### Web ターミナル

- node-pty と @xterm/xterm による統合ターミナル
- 複数セッション対応: 作成、切り替え、終了
- WebSocket によるキーボード入力と PTY 出力のリアルタイム転送
- ウィンドウサイズ変更に対応

---

## クイックスタート

### npm（推奨）

```bash
npm install -g hermes-web-ui
hermes-web-ui start
```

**http://localhost:8648** を開きます。

### Docker Compose

Hermes Agent を内蔵した単一コンテナ構成です。

```bash
# 事前ビルド済みイメージを使用（推奨）
WEBUI_IMAGE=ekkoye8888/hermes-web-ui docker compose up -d

# またはソースからビルド
docker compose up -d --build

docker compose logs -f hermes-webui
```

**http://localhost:6060** を開きます。

- 永続化される Hermes データは `./hermes_data` に保存
- Web UI 認証 Token は `./hermes_data/hermes-web-ui/.token` に保存
- 認証有効時の初回起動では、Token がコンテナログに出力されます
- 実行時設定は `docker-compose.yml` の環境変数で制御されます

詳しい説明とトラブルシューティングは [`docs/docker.md`](./docs/docker.md) を参照してください。

### Hermes Agent Runtime の検出

Web UI がバックエンドのチャット機能を起動するとき、まず `~/.hermes/hermes-agent` のような `run_agent.py` を含むソースチェックアウトを探します。見つからない場合は、インストール済みの `hermes` コマンドが使用する Python 環境にフォールバックし、さらに system Python にフォールバックします。これにより、ソースインストールと `pip install hermes-agent` のようなパッケージインストールの両方に対応します。

## Web UI 環境変数

これらの変数は Hermes Web UI、ローカル Hermes runtime 連携、開発/プレビュー補助機能を設定します。Provider API key と Hermes Agent 関連設定は通常 Hermes Profile で管理されます。ここにある変数はプロセス単位の上書き設定です。

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `PORT` | `8648` | Web UI の待ち受けポート。 |
| `BIND_HOST` | `0.0.0.0` | Web UI の bind host。IPv6 を使う場合は `::` を明示します。 |
| `HERMES_WEB_UI_HOME` | `~/.hermes-web-ui` | Web UI データディレクトリ。認証 token、認証情報、ログ、DB、デフォルトアップロードを保存します。互換 alias として `HERMES_WEBUI_STATE_DIR` も利用できます。 |
| `HERMES_WEBUI_STATE_DIR` | 未設定 | `HERMES_WEB_UI_HOME` の互換 alias。 |
| `UPLOAD_DIR` | `$HERMES_WEB_UI_HOME/upload` | アップロード root の上書き。ファイルは Profile 単位のサブディレクトリに保存されます。 |
| `CORS_ORIGINS` | `*` | Koa CORS origin 設定。 |
| `AUTH_TOKEN` | 自動生成 | 明示的な bearer token。未設定の場合、Web UI が `HERMES_WEB_UI_HOME` 配下に生成します。 |
| `AUTH_JWT_SECRET` | `AUTH_TOKEN` | ユーザー名/パスワードセッション用 JWT 署名 secret の上書き。 |
| `PROFILE` | `default` | 起動時/デフォルト Hermes Profile。実行時リクエストでは、フロントエンドで選択され、現在のアカウントに許可された Profile を使用します。 |
| `LOG_LEVEL` | `info` | Server ログレベル。 |
| `BRIDGE_LOG_LEVEL` | `$LOG_LEVEL` または `info` | Bridge ログレベル。 |
| `MAX_DOWNLOAD_SIZE` | `200MB` | 最大ファイルダウンロードサイズ。 |
| `MAX_EDIT_SIZE` | `10MB` | 最大編集可能ファイルサイズ。 |
| `WORKSPACE_BASE` | `/opt/data/workspace` | Workspace ブラウズの基準ディレクトリ。 |
| `HERMES_HOME` | platform default | Hermes データディレクトリ。Windows は `%LOCALAPPDATA%\hermes`、macOS/Linux は `~/.hermes`。 |
| `HERMES_BIN` | `hermes` | カスタム Hermes CLI バイナリパス。 |
| `HERMES_AGENT_ROOT` | 自動検出 | `run_agent.py` を含む Hermes Agent ソースチェックアウト。 |
| `HERMES_AGENT_BRIDGE_PYTHON` | 自動検出 | agent bridge 起動に使う Python interpreter。 |
| `HERMES_AGENT_BRIDGE_UV` | 自動検出 | 利用可能な場合に agent bridge 起動に使う `uv` executable。 |
| `UV` | 自動検出 | fallback `uv` executable path。 |
| `PYTHON` | 自動検出 | agent bridge 用 fallback Python executable。 |
| `HERMES_AGENT_BRIDGE_ENDPOINT` | platform default | Agent bridge broker endpoint。Windows は `tcp://127.0.0.1:18765`、macOS/Linux は `ipc:///tmp/hermes-agent-bridge.sock`。 |
| `HERMES_AGENT_BRIDGE_TIMEOUT_MS` | `120000` | Node から bridge broker へのリクエストタイムアウト。 |
| `HERMES_AGENT_BRIDGE_CONNECT_RETRY_MS` | `5000` | bridge socket 接続失敗時の短い retry window。 |
| `HERMES_AGENT_BRIDGE_STARTUP_TIMEOUT_MS` | `120000` | Python bridge ready を待つタイムアウト。 |
| `HERMES_AGENT_BRIDGE_AUTO_RESTART` | 有効 | bridge broker が予期せず終了した場合に自動再起動します。`0`、`false`、`no`、`off` で無効化。 |
| `HERMES_AGENT_BRIDGE_RESTART_DELAY_MS` | `1000` | bridge 自動再起動 backoff の基本遅延。 |
| `HERMES_AGENT_BRIDGE_PLATFORM` | `cli` | Hermes Agent に渡す platform identity。 |
| `HERMES_AGENT_BRIDGE_WORKER_TRANSPORT` | platform default | Profile worker transport。loopback TCP は `tcp`、Unix domain socket は `ipc`/`unix`。デフォルトは Windows が TCP、macOS/Linux が IPC。 |
| `HERMES_AGENT_BRIDGE_WORKER_PORT_BASE` | `18780` | TCP worker endpoint の base port。 |
| `HERMES_BRIDGE_PROVIDER` | profile/default | bridge run 用 Provider 上書き。 |
| `HERMES_BRIDGE_TOOLSETS` | profile/default | bridge run 用 toolset 上書き。 |
| `HERMES_BRIDGE_MAX_TURNS` | profile/default | bridge run 用最大ターン数上書き。 |
| `HERMES_BRIDGE_SUPPRESS_PLATFORM_HINT` | `cli` | Hermes Agent に渡す bridge platform hint suppression を制御。 |
| `HERMES_OPENROUTER_APP_REFERER` | `https://ekkolearnai.com` | bridge run が OpenRouter に送信する attribution referer。 |
| `HERMES_OPENROUTER_APP_TITLE` | `Hermes Web UI` | bridge run が OpenRouter に送信する attribution title。 |
| `HERMES_OPENROUTER_APP_CATEGORIES` | `cli-agent,personal-agent` | bridge run が OpenRouter に送信する attribution categories。 |
| `HERMES_WEB_UI_MANAGED_GATEWAY` | platform/runtime dependent | managed legacy gateway process handling を強制します。`1`、`true`、`yes`、`on` で有効化。 |
| `HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN` | production で有効 | Web UI shutdown 時に managed gateway process も停止するかを制御します。`0` または `false` で分離実行。 |
| `GATEWAY_HOST` | `127.0.0.1` | legacy gateway 互換用に Profile config へ書き込まれるデフォルト gateway host。 |
| `HERMES_WEB_UI_PREVIEW_REPO` | package repository | Version Preview が使用する GitHub repository。 |
| `HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_TRANSPORT` | platform default | Version Preview broker transport。macOS/Linux の Preview で loopback TCP を使うには `tcp` を指定。未設定時は `HERMES_AGENT_BRIDGE_WORKER_TRANSPORT=tcp` に従います。 |
| `HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_ENDPOINT` | isolated preview endpoint | Version Preview broker endpoint を直接上書き。 |
| `HERMES_WEB_UI_BACKEND_PORT` | `8648` | Vite dev proxy が使う backend port。 |
| `HERMES_WEB_UI_FRONTEND_PORT` | `8649` | Frontend Vite dev server port。 |

### CLI コマンド

| コマンド | 説明 |
| --- | --- |
| `hermes-web-ui start` | バックグラウンドで起動（daemon mode） |
| `hermes-web-ui start --port 9000` | カスタムポートで起動 |
| `hermes-web-ui stop` | バックグラウンドプロセスを停止 |
| `hermes-web-ui restart` | バックグラウンドプロセスを再起動 |
| `hermes-web-ui status` | 実行状態を確認 |
| `hermes-web-ui update` | 最新バージョンへ更新して再起動 |
| `hermes-web-ui upgrade` | `update` の alias |
| `hermes-web-ui -v` | バージョン番号を表示 |
| `hermes-web-ui -h` | ヘルプメッセージを表示 |

`update` / `upgrade` はまず `npm cache clean --force` を試し、その後 `npm install -g hermes-web-ui@latest` を実行して再起動します。キャッシュ削除は best-effort です。失敗しても updater は install を継続します。

### 自動設定

BFF server は起動時に次を自動実行します。

- Web UI データディレクトリ、ローカルデータベース、同梱スキルの初期化
- `/chat-run` で使用する Hermes agent bridge の起動
- 起動成功後にブラウザを開く

---

## 開発

```bash
git clone https://github.com/EKKOLearnAI/hermes-web-ui.git
cd hermes-web-ui
npm install
npm run dev
```

- Frontend: http://localhost:8649
- BFF Server: http://localhost:8647

```bash
npm run build   # dist/ に出力
```

プロジェクトの開発ガイドラインは [DEVELOPMENT.md](./DEVELOPMENT.md) を参照してください。

## アーキテクチャ

```
Browser → BFF (Koa, :8648) → Socket.IO /chat-run
                ↓
        Hermes agent bridge → Hermes Agent runtime
                ↓
           Hermes CLI / profiles
           profile config.yaml    (channel/provider behavior)
           profile auth.json      (credential pool)
           Tencent iLink API      (WeChat QR login)
```

フロントエンドは **マルチ Agent 拡張アーキテクチャ** を採用しています。Hermes 関連コードは API、コンポーネント、ビュー、Store を含めて `hermes/` ディレクトリ配下に名前空間化されており、新しい Agent integration を並行して追加しやすい構成です。

BFF layer は Socket.IO チャットストリーミング、Hermes agent bridge、Profile 単位のファイルアップロードとパスベースのダウンロード（local/Docker/SSH/Singularity）、セッション CRUD、アカウント/Profile スコープ管理、設定/認証情報管理、WeChat QR ログイン、モデル検出、スキル/メモリ管理、ログ読み取り、静的ファイル配信を担当します。

## 技術スタック

**Frontend:** Vue 3 + TypeScript + Vite + Naive UI + Pinia + Vue Router + vue-i18n + SCSS + markdown-it + highlight.js

**Backend:** Koa 2 (BFF server) + node-pty (Web terminal)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=EKKOLearnAI/hermes-web-ui&type=Date)](https://star-history.com/#EKKOLearnAI/hermes-web-ui&Date)

<!-- If the chart above doesn't load, visit https://star-history.com/#EKKOLearnAI/hermes-web-ui -->

## ライセンス

[BSL-1.1](./LICENSE)
