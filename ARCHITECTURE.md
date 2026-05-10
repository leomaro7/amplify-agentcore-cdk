# amplify-agentcore-cdk アーキテクチャ全体像

## プロジェクト概要

AWS Amplify Gen2 + AWS Bedrock AgentCore を使った**サーバーレス AI エージェント Web アプリ**のテンプレートです。
ユーザーがチャットで質問すると、AI エージェント（Claude Haiku）が AWS の最新情報 RSS を取得・分析して回答します。

---

## システム全体構成

```mermaid
graph TB
    subgraph User["ユーザー環境"]
        Browser["ブラウザ<br/>(React SPA)"]
    end

    subgraph AWS["AWS クラウド (ap-northeast-1)"]
        subgraph Hosting["Amplify Hosting"]
            CF["CloudFront CDN"]
            S3["S3 (静的ファイル)"]
        end

        subgraph Auth["認証基盤"]
            Cognito["Amazon Cognito<br/>(User Pool)"]
        end

        subgraph AgentRuntime["Bedrock AgentCore"]
            Runtime["AgentCore Runtime<br/>(マネージドコンテナ)"]
            subgraph Container["Pythonコンテナ (ARM64)"]
                App["app.py<br/>(Strands Agent)"]
                LLM["Claude Haiku<br/>jp.anthropic.claude-haiku-4-5"]
                Tool["RSS Feed Tool"]
            end
        end

        subgraph CICD["CI/CD"]
            Amplify["AWS Amplify<br/>(Git連携)"]
            CFn["CloudFormation<br/>(CDKスタック)"]
            CodeBuild["CodeBuild<br/>(Dockerビルド)"]
            ECR["ECR<br/>(コンテナレジストリ)"]
        end
    end

    subgraph External["外部サービス"]
        RSS["AWS What's New<br/>RSS フィード"]
        GitHub["GitHub<br/>(ソースコード)"]
    end

    Browser -->|"HTTPS + Cognito Token"| CF
    CF --> S3
    Browser -->|"認証"| Cognito
    Browser -->|"POST /runtimes/{ARN}/invocations<br/>SSE ストリーミング"| Runtime
    Cognito -->|"トークン検証"| Runtime
    Runtime --> Container
    App --> LLM
    App --> Tool
    Tool -->|"RSS 取得"| RSS

    GitHub -->|"push"| Amplify
    Amplify --> CFn
    CFn --> CodeBuild
    CodeBuild --> ECR
    ECR --> Runtime
```

---

## ディレクトリ構成

```mermaid
graph LR
    Root["amplify-agentcore-cdk/"]

    Root --> amplify["📁 amplify/<br/>(バックエンド定義)"]
    Root --> src["📁 src/<br/>(フロントエンド)"]
    Root --> pkg["📄 package.json"]
    Root --> yml["📄 amplify.yml<br/>(CI/CD)"]
    Root --> vite["📄 vite.config.ts"]

    amplify --> backend["📄 backend.ts<br/>(メイン定義)"]
    amplify --> auth["📁 auth/<br/>resource.ts<br/>(Cognito)"]
    amplify --> agent["📁 agent/"]

    agent --> res["📄 resource.ts<br/>(CDKスタック)"]
    agent --> app["📄 app.py<br/>(Strands Agent)"]
    agent --> docker["📄 Dockerfile"]
    agent --> req["📄 requirements.txt"]

    src --> main["📄 main.tsx<br/>(エントリポイント)"]
    src --> apptsx["📄 App.tsx<br/>(チャットUI)"]
    src --> css["📄 App.css"]
```

---

## データフロー（リクエスト処理）

```mermaid
sequenceDiagram
    actor User as ユーザー
    participant FE as React Frontend
    participant Cognito as Amazon Cognito
    participant AC as AgentCore Runtime
    participant Agent as Strands Agent<br/>(Python)
    participant Bedrock as Claude Haiku<br/>(Bedrock)
    participant RSS as AWS RSS Feed

    User->>FE: メッセージ入力・送信
    FE->>Cognito: アクセストークン取得
    Cognito-->>FE: JWT Token

    FE->>AC: POST /runtimes/{ARN}/invocations<br/>Authorization: Bearer {token}<br/>Body: {"prompt": "..."}

    AC->>AC: Cognito トークン検証

    AC->>Agent: リクエスト転送

    Agent->>Bedrock: Claude Haiku 呼び出し
    Bedrock-->>Agent: ツール使用決定

    Agent->>RSS: RSS フィード取得
    RSS-->>Agent: XML データ

    Agent->>Bedrock: RSS データ + 分析依頼
    Bedrock-->>Agent: テキスト回答 (ストリーム)

    Agent-->>AC: SSE イベントストリーム
    AC-->>FE: SSE ストリーミング

    loop ストリーミング受信
        FE->>FE: イベント種別判定
        Note over FE: text → テキスト追記<br/>tool_use → ツール使用表示
        FE-->>User: リアルタイム表示
    end
```

---

## インフラ構成（CDK スタック）

```mermaid
graph TD
    subgraph CDK["CDK スタック (amplify/agent/resource.ts)"]
        Stack["AgentCoreStack"]

        Stack --> Runtime["AgentCoreRuntime<br/>(L2 Construct)"]
        Stack --> IAM["IAM Role<br/>(bedrock:InvokeModel)"]

        Runtime --> Image["コンテナイメージ<br/>(ARM64 Linux)"]
        Runtime --> AuthCfg["認証設定<br/>(Cognito UserPool)"]
        Runtime --> Network["ネットワーク<br/>(Public)"]

        Image --> CB["CodeBuild<br/>(Dockerビルド)"]
        CB --> ECR["ECR リポジトリ"]

        AuthCfg --> UP["Cognito User Pool<br/>(Amplify Auth から参照)"]
    end

    subgraph Amplify["Amplify Gen2 (amplify/backend.ts)"]
        BE["defineBackend()"]
        BE -->|"auth"| AuthRes["Auth Resource<br/>(Cognito)"]
        BE -->|"agent"| AgentRes["Agent Resource<br/>(CDK Stack)"]
    end
```

---

## コンテナ構成（Dockerfile）

```mermaid
graph TD
    Base["ghcr.io/astral-sh/uv:python3.13-bookworm-slim<br/>(ベースイメージ)"]

    Base --> User["非rootユーザー作成<br/>bedrock_agentcore (UID 1000)"]
    User --> Deps["Python依存関係インストール<br/>(uv pip install)"]
    Deps --> Code["app.py コピー"]
    Code --> OTEL["OpenTelemetry<br/>初期化スクリプト"]
    OTEL --> HC["ヘルスチェック<br/>GET /ping:8080"]
    HC --> Run["uvicorn 起動<br/>:8080"]
```

---

## フロントエンドコンポーネント

```mermaid
graph TD
    main["main.tsx<br/>(エントリポイント)"]
    main -->|"Amplify 初期化"| config["amplify_outputs.json<br/>(自動生成設定)"]
    main -->|"認証ラッパー"| Auth["<Authenticator>"]
    Auth --> App["App.tsx<br/>(メインコンポーネント)"]

    App --> State["State 管理"]
    State --> msgs["messages[]<br/>(チャット履歴)"]
    State --> streaming["isStreaming<br/>(送信中フラグ)"]

    App --> sendMsg["sendMessage()"]
    sendMsg --> fetch["fetch() → SSE"]
    fetch -->|"text イベント"| TextRender["テキスト追記"]
    fetch -->|"tool_use イベント"| ToolRender["ツール使用表示"]

    App --> UI["Chat UI"]
    UI --> Markdown["<ReactMarkdown>"]
    UI --> Input["テキスト入力"]
    UI --> Send["送信ボタン"]
```

---

## 技術スタック

```mermaid
mindmap
  root((技術スタック))
    フロントエンド
      React 18.2
      TypeScript 5.4
      Vite 5.4
      Amplify UI React
      React Markdown
    バックエンド/インフラ
      AWS CDK 2.233
      Amplify Gen2
      CloudFormation
    AIエージェント
      Python 3.13
      Strands Agents
      Claude Haiku
      Bedrock AgentCore
    認証
      Amazon Cognito
      JWT Token
    CI/CD
      AWS Amplify Hosting
      GitHub連携
      CodeBuild
    可観測性
      OpenTelemetry
      AWS X-Ray
```

---

## デプロイフロー

```mermaid
flowchart LR
    Dev["開発者<br/>(ローカル)"]
    GitHub["GitHub"]
    Amplify["AWS Amplify<br/>(CI/CD)"]

    subgraph Backend["バックエンドデプロイ"]
        CDKSynth["CDK Synth<br/>(CloudFormation生成)"]
        CFnDeploy["CloudFormation Deploy"]
        DockerBuild["Docker Build<br/>(CodeBuild)"]
        ECRPush["ECR Push"]
        RuntimeCreate["AgentCore Runtime<br/>作成/更新"]
    end

    subgraph Frontend["フロントエンドデプロイ"]
        ViteBuild["Vite Build<br/>(npm run build)"]
        S3Upload["S3 Upload<br/>(dist/)"]
        CFInvalidate["CloudFront<br/>キャッシュ無効化"]
    end

    Dev -->|"git push"| GitHub
    GitHub -->|"Webhook"| Amplify
    Amplify --> CDKSynth
    CDKSynth --> CFnDeploy
    CFnDeploy --> DockerBuild
    DockerBuild --> ECRPush
    ECRPush --> RuntimeCreate
    Amplify --> ViteBuild
    ViteBuild --> S3Upload
    S3Upload --> CFInvalidate
```

---

## SSE イベント形式

フロントエンドが受け取るイベントの種類：

| イベント種別 | 内容 | フロントエンドの動作 |
|------------|------|------------------|
| `text` | AI の回答テキスト（断片） | チャットメッセージに追記 |
| `tool_use` | ツール使用通知（例: RSS取得） | "ツール使用中..." 表示 |
| その他 | デバッグ用イベント | 無視 |

---

## 環境変数・設定

| 設定 | 値 | 設定場所 |
|-----|---|---------|
| AWS リージョン | `ap-northeast-1` (東京) | Dockerfile 環境変数 |
| LLM モデル | `jp.anthropic.claude-haiku-4-5-20251001-v1:0` | app.py |
| エージェントポート | `8080` | Dockerfile |
| ランタイム名 | スタック名から自動生成 | resource.ts |
| 認証方式 | Cognito User Pool | resource.ts |

---

## コスト構成（主要課金コンポーネント）

```mermaid
pie title 主要コストコンポーネント
    "Bedrock (Claude API呼び出し)" : 70
    "AgentCore Runtime" : 20
    "Amplify Hosting / CloudFront" : 5
    "Cognito" : 3
    "その他 (ECR, CodeBuild等)" : 2
```

---

## まとめ

このプロジェクトは以下を実現するテンプレートです：

1. **フロントエンド** — Cognito認証付きチャットUI（React + Amplify）
2. **AIエージェント** — RSS取得ツールを持つ Claude Haiku エージェント（Python + Strands）
3. **インフラ** — 完全サーバーレス（CDK + Amplify Gen2 で自動構築）
4. **CI/CD** — GitHub push で自動デプロイ
