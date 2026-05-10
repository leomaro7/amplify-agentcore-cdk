# アーキテクチャ図

## シーケンス図

```mermaid
sequenceDiagram
    actor User as ユーザー
    participant UI as フロントエンド<br/>(React + Amplify)
    participant Cognito as Cognito<br/>User Pool
    participant AgentCore as AgentCore<br/>Runtime
    participant App as app.py<br/>(Strands Agent)
    participant STM as AgentCore Memory<br/>(STM)
    participant Bedrock as Amazon Bedrock<br/>(Nova Lite)
    participant RSS as RSSツール

    %% ログインフロー
    User->>UI: アクセス
    UI->>Cognito: 認証要求
    Cognito-->>UI: Access Token (JWT)

    %% チャットフロー
    User->>UI: メッセージ送信
    UI->>Cognito: fetchAuthSession()
    Cognito-->>UI: Access Token
    UI->>AgentCore: POST /invocations<br/>Authorization: Bearer <AccessToken><br/>body: { prompt }
    AgentCore->>Cognito: JWT 検証
    Cognito-->>AgentCore: 検証OK
    Note over AgentCore: workload_access_token に<br/>JWT をセット

    %% エージェント処理
    AgentCore->>App: invoke_agent(payload, context)
    Note over App: context.session_id を取得<br/>JWT の sub を actor_id として取得

    App->>STM: get_last_k_turns(<br/>  actor_id=sub,<br/>  session_id=session_id<br/>)
    STM-->>App: 過去の会話履歴

    Note over App: 履歴を Strands の<br/>messages 形式に変換

    App->>Bedrock: stream_async(prompt, messages=history)
    Bedrock-->>App: ストリーミング応答開始

    loop ツール呼び出しが必要な場合
        Bedrock->>App: tool_use イベント
        App->>RSS: RSS フィード取得
        RSS-->>App: フィードデータ
        App->>Bedrock: ツール結果を渡す
    end

    Bedrock-->>App: テキスト応答（ストリーミング）

    App-->>AgentCore: SSE イベント yield<br/>{ type: "tool_use" / "text", ... }
    AgentCore-->>UI: SSE ストリーム転送
    UI-->>User: リアルタイム表示

    %% STM 保存
    App->>STM: create_event(<br/>  actor_id=sub,<br/>  session_id=session_id,<br/>  messages=[(prompt, USER),<br/>            (response, ASSISTANT)]<br/>)
    STM-->>App: 保存完了
```

## コンポーネント構成

| コンポーネント | 技術 | 役割 |
|---|---|---|
| フロントエンド | React + Vite + Amplify UI | チャット UI・認証 |
| 認証 | Amazon Cognito | JWT 発行・検証 |
| ホスティング | AWS Amplify | フロントエンド配信・CI/CD |
| AIランタイム | Bedrock AgentCore Runtime | エージェントコンテナ実行・認証検証 |
| エージェント | Strands Agents (Python) | LLM オーケストレーション |
| LLM | Amazon Nova Lite (Bedrock) | 推論 |
| 短期記憶 | AgentCore Memory (STM) | セッション内会話履歴の保持 |
| ツール | strands-agents-tools (RSS) | 外部情報取得 |

## 認証の流れ

```
JWT の sub クレーム（Cognito ユーザー固有 UUID）
  → AgentCore が workload_access_token にセット
  → app.py が JWT デコードで sub を取得
  → STM の actor_id として使用（ユーザーごとに履歴を分離）
```

---

## 参考：IAM 認証のシーケンス図

本プロジェクトは JWT 認証を採用しているが、IAM 認証（Cognito Identity Pool + SigV4）を使う場合の比較参考図。

```mermaid
sequenceDiagram
    actor User as ユーザー
    participant UI as フロントエンド<br/>(Amplify)
    participant UserPool as Cognito<br/>User Pool
    participant IdentityPool as Cognito<br/>Identity Pool
    participant STS as AWS STS
    participant AgentCore as AgentCore<br/>Runtime
    participant IAM as AWS IAM
    participant App as app.py<br/>(Strands Agent)
    participant STM as AgentCore Memory<br/>(STM)
    participant Bedrock as Amazon Bedrock

    %% ログインフロー
    User->>UI: ログイン
    UI->>UserPool: 認証要求
    UserPool-->>UI: JWT (ID Token)

    UI->>IdentityPool: JWT を渡して<br/>AWS 認証情報を要求
    IdentityPool->>STS: AssumeRoleWithWebIdentity<br/>(JWT + IAM Role ARN)
    STS-->>IdentityPool: 一時クレデンシャル<br/>(AccessKeyId / SecretKey / SessionToken)
    IdentityPool-->>UI: 一時クレデンシャル
    Note over UI: Identity ID も取得済み<br/>→ actor_id として使用

    %% チャットフロー
    User->>UI: メッセージ送信
    Note over UI: SigV4 で<br/>リクエストに署名
    UI->>AgentCore: POST /invocations<br/>Authorization: AWS4-HMAC-SHA256<br/>body: { prompt, actorId: IdentityId }
    AgentCore->>IAM: 署名を検証
    IAM-->>AgentCore: 検証 OK (IAM Principal 情報)

    %% エージェント処理
    AgentCore->>App: invoke_agent(payload, context)
    Note over App: payload の actorId を取得<br/>context.session_id を取得

    App->>STM: get_last_k_turns(<br/>  actor_id=IdentityId,<br/>  session_id=session_id<br/>)
    STM-->>App: 過去の会話履歴

    App->>Bedrock: stream_async(prompt, messages=history)
    Bedrock-->>App: ストリーミング応答

    App-->>AgentCore: SSE イベント yield
    AgentCore-->>UI: SSE ストリーム転送
    UI-->>User: リアルタイム表示

    App->>STM: create_event(<br/>  actor_id=IdentityId,<br/>  session_id=session_id,<br/>  messages=[...]<br/>)
    STM-->>App: 保存完了
```

## JWT 認証 vs IAM 認証

### エンジニア向け比較

| | JWT 認証（本プロジェクト） | IAM 認証 |
|---|---|---|
| トークン | Cognito Access Token (Bearer) | 一時 IAM クレデンシャル |
| 署名方式 | なし（トークン自体が証明） | SigV4 |
| 検証先 | Cognito | IAM |
| Identity Pool | 不要 | **必要** |
| ユーザー識別 | JWT の `sub` | Cognito Identity ID |
| 複雑さ | シンプル | ステップが多い |

---

### 非エンジニア向けまとめ

#### 🔑 JWT 認証（本プロジェクトの方式）

> 「会員証を見せてそのまま入場する」イメージ

- ✅ **シンプルで速い** — ログインしたらすぐ使える。余分な手続きがない
- ✅ **一般向けサービスに最適** — 不特定多数のユーザーが使うアプリに向いている
- ✅ **開発コストが低い** — 作るのが簡単なので、リリースまでが早い
- ❌ **AWS 内部の細かい権限制御は苦手** — 「このユーザーにはこの機能だけ」という複雑なルールには不向き

**こんなサービスに向いている：** 一般公開のチャットアプリ、社外向けサービス、スタートアップのプロダクト

---

#### 🏢 IAM 認証

> 「受付で身分証を出し、入館証と鍵を借りてから入場する」イメージ

- ✅ **AWS リソースへの細かいアクセス制御ができる** — 「Aさんはこのデータだけ見られる」といった厳密な管理が可能
- ✅ **社内システムや AWS サービス同士の連携に強い** — サーバー同士が自動でやりとりする場面に向いている
- ✅ **大企業・金融・医療など高いセキュリティ要件に対応しやすい** — 既存の社内認証基盤と連携できる
- ❌ **実装が複雑** — 開発に時間とコストがかかる
- ❌ **一般ユーザー向けサービスにはオーバースペック** — 手間に対してメリットが薄い

**こんなサービスに向いている：** 社内ツール、金融・医療系システム、AWS サービス間の自動連携
