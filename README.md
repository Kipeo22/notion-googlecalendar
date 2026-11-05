# 📅 Notion ⇄ Google Calendar 同期

概要 : NotionのTODOデータベースにある「いつやる？」プロパティの日時をGoogleカレンダーに自動同期するシステムです。

目的 : Notionでタスク管理をしてい、いつタスクを実施するかを予定化することでタスク漏れを防ぐためにNotion上でタスク実施時間を設定していた。しかし私がメインで使っているカレンダー(Google calender)に同期したいなと思った。Notion calenderでの良いがスマホの表示が非常に使いずらい。そのためNotion上でタスク管理をしつつ、自動でgoogle calenderに予定として反映冴える機能を作ってしまおうと思った。

## 機能

- ✅ Notionタスクの「いつやる？」（開始・終了日時）をGoogleカレンダーに登録
- ✅ タスクの更新を検知してGoogleカレンダーの予定を更新
- ✅ 「いつやる？」が削除されたらGoogleカレンダーの予定も削除
- ✅ Googleカレンダーで予定のタイトル・日時を変更すると、Notionのタスク名・「いつやる？」にも反映（逆方向同期）
  - 両方で同時に変更された場合は、後から変更した方が優先
  - Googleカレンダーでタイトルを空にした場合は、Notionのタイトルで元に戻ります
  - Googleカレンダーで予定を削除した場合は、Notion側の「いつやる？」が残っていれば再作成されます
- ✅ 差分同期（最近更新されたタスク・予定のみ処理）

## セットアップ

### 1. Notion側の設定

1. [Notion Integrations](https://www.notion.so/my-integrations) でインテグレーションを作成
2. APIキー（`secret_xxx...`）をメモ
3. TODOデータベースページで「...」→「コネクト」→ インテグレーションを追加
4. TODOデータベースに **テキスト型** の `GCalEventID` プロパティを追加
   - データベースのプロパティ追加 → 名前: `GCalEventID` → タイプ: テキスト
5. データベースIDをURLから取得
   - URL例: `https://www.notion.so/xxxx?v=yyyy` の `xxxx` 部分

### 2. Google Cloud側の設定

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. 新しいプロジェクトを作成
3. **APIとサービス** → **APIを有効にする** → **Google Calendar API** を有効化
4. **APIとサービス** → **認証情報** → **サービスアカウントを作成**
   - 名前: 任意（例: `notion-gcal-sync`）
5. 作成したサービスアカウントをクリック → **鍵** タブ → **鍵を追加** → **JSON** → ダウンロード
6. JSONファイルから以下を取得:
   - `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → `GOOGLE_PRIVATE_KEY`
7. [Googleカレンダー](https://calendar.google.com/) の設定 → **特定のユーザーと共有** → サービスアカウントのメールアドレスを追加（権限: **予定の変更**）

### 3. 環境変数の設定

`.env.example` を `.env.local` にコピーして値を設定:

```bash
cp .env.example .env.local
```

| 変数名 | 説明 |
|---------|------|
| `NOTION_API_KEY` | Notionインテグレーションのシークレット |
| `NOTION_DATABASE_ID` | TODOデータベースのID |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | サービスアカウントのメールアドレス |
| `GOOGLE_PRIVATE_KEY` | サービスアカウントの秘密鍵（JSON内の`private_key`） |
| `GOOGLE_CALENDAR_ID` | Googleカレンダーのカレンダー ID（通常はGmailアドレス） |
| `CRON_SECRET` | APIエンドポイント保護用の任意の文字列 |

`OLD_CAL_ID` と `NEW_CAL_ID` は通常の同期処理では使用しません。Vercel の環境変数にも不要です。

### 4. ローカル実行

```bash
npm install
npm run dev
```

同期をテスト:
```bash
# 全件同期
curl -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/sync?full=true"

# 差分同期（過去15分の更新のみ）
curl -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/sync"
```

### 5. Vercelへのデプロイ

```bash
# Vercel CLIでデプロイ
npx vercel

# 環境変数をVercelに設定
npx vercel env add NOTION_API_KEY
npx vercel env add NOTION_DATABASE_ID
npx vercel env add GOOGLE_SERVICE_ACCOUNT_EMAIL
npx vercel env add GOOGLE_PRIVATE_KEY
npx vercel env add GOOGLE_CALENDAR_ID
npx vercel env add CRON_SECRET
```

`NOTION_API_KEY`, `GOOGLE_PRIVATE_KEY`, `CRON_SECRET` は Vercel で Sensitive として保存してください。`GOOGLE_SERVICE_ACCOUNT_EMAIL` は秘密鍵ではありませんが、外部公開する必要はないため Sensitive にして問題ありません。既存の環境変数を Sensitive に変更する場合は、Vercel 上で削除してから Sensitive 有効で再作成し、再デプロイします。

### 6. 頻繁な同期の設定（推奨）

Vercel無料プランのCronは1日1回のため、5分ごとの同期には外部cronサービスを使用:

1. [cron-job.org](https://cron-job.org/) に登録（無料）
2. 新しいcron jobを作成:
   - **URL**: `https://your-app.vercel.app/api/sync`
   - **Schedule**: Every 5 minutes
   - **Headers**: `Authorization: Bearer <CRON_SECRETの値>`

## APIエンドポイント

| エンドポイント | 説明 |
|---------------|------|
| `GET /api/sync` | 過去15分の更新を双方向に同期 |
| `GET /api/sync?full=true` | 全タスクを同期 |

## Notionデータベースの必要プロパティ

| プロパティ名 | タイプ | 説明 |
|-------------|--------|------|
| タイトル | title | タスク名（Googleカレンダーの予定名と双方向に同期） |
| いつやる？ | date | 開始・終了日時（Googleカレンダーの予定日時） |
| GCalEventID | text | 同期用ID（自動入力、手動編集不要） |
