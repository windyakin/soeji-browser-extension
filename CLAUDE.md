# Browser Extension - CLAUDE.md

NovelAI（https://novelai.net）で生成した画像をsoejiに直接アップロードするChrome/Firefox両対応の拡張機能。

## ディレクトリ構造

```
browser-extension/
├── manifest.json           # 拡張機能マニフェスト (MV3)
├── background.js           # Service Worker
├── content-scripts/
│   ├── upload.js           # NovelAI用アップロードスクリプト
│   └── upload.css          # スタイル定義
├── popup/
│   ├── popup.html          # 設定ポップアップHTML
│   ├── popup.js            # 設定ポップアップロジック
│   └── popup.css           # ポップアップスタイル
└── docs/
    ├── nai-history-dom-behavior.md  # NAI履歴アイテムのDOM挙動詳細
    └── history-tracking.md          # history Mapによるアップロード状態管理
```

## 技術仕様

- **Manifest V3**: Chrome/Firefox両対応
- **認証**: `X-Watcher-Key`ヘッダー（backend の watcher と同じ方式）
- **CORS**: Content Scriptから直接バックエンドにアップロード
- **ストレージ**: `browser.storage.local`（設定保存）

## コンポーネント

### Content Script (`content-scripts/upload.js`)

NovelAIの画像グリッドにアップロードボタンを注入するスクリプト。

#### 主要クラス: `SoejiUploader`

| プロパティ | 型 | 説明 |
|-----------|-----|------|
| `uploadQueue` | Array | アップロード待機キュー（`{id, blobUrl, bgHash, status}`） |
| `history` | Map | 画像状態の一元管理（bgHash → `{status, index}`）。indexはDOM位置（0=最新） |
| `currentBatchHasError` | boolean | 現在のバッチでエラーが発生したか |
| `resultBadgeTimeout` | number | 結果バッジ非表示タイマーID |
| `currentButton` | Element | バッジ更新用のボタン参照 |
| `historyBadgeTimeouts` | Map | bgHash → タイムアウトID（完了バッジ自動非表示用） |
| `historyObserver` | MutationObserver | 履歴コンテナ監視（新規アイテム検出時にインデックスシフト） |

#### アップロードフロー

1. `injectButton()`: `.image-grid-image`要素を検出し、アップロードボタンを注入
   - 画像srcの変更を`MutationObserver`で監視し、アイコンの半透明状態を更新
2. `handleUpload()`: ボタンクリック時にキューに追加
   - 同じbgHashがキュー内にある場合は追加しない（連打防止）
   - 既にアップロード済みの画像でも再アップロード可能
   - `history` Mapにstatusを追加し、`syncHistoryBadges()`でバッジを同期
3. `processQueue()`: キューから1件ずつアップロードを開始
4. `executeUpload()`: blob URLから画像を取得し、バックエンドにPOST
5. `showResultStatus()`: キュー完了時に結果バッジを表示
6. `updateBadges()`: キュー状態に応じてバッジを更新

### UI要素

#### アップロードボタン (`.soeji-upload-btn`)

- NAIの既存ボタンと並んで表示
- アイコン: インラインSVG（アップロード矢印）
- アップロード済み/中の画像ではアイコン（SVG）のみ `opacity: 0.4`（半透明）
  - `.soeji-uploaded` クラスで制御
  - バッジは半透明にならない
- `disabled`にはしない（いつでも押せる）
- 既にアップロード済みの画像でも再アップロード可能（何かあったときの救済措置）

#### アップロード進捗バッジ (`.soeji-badge`、右上)

| 状態 | クラス | 表示 | 色 |
|------|--------|------|-----|
| アップロード中 | `soeji-badge-uploading` | スピナー（回転） | 青 (#3b82f6) |
| 完了 | `soeji-badge-success` | チェックマーク (✓) | 緑 (#22c55e) |
| エラー | `soeji-badge-error` | エクスクラメーション (!) | 赤 (#ef4444) |
| 非表示 | `soeji-badge-hidden` | - | - |

**状態遷移:**
- アップロード中のスピナーは常に表示
- 完了・エラーは3秒後に自動で非表示
- 完了/エラー表示中に新規アップロード開始 → スピナーが優先
- エラー後に新バッチが成功 → 成功を表示（`currentBatchHasError`をリセット）
- スピナーは `appendChild` でDOM要素として追加

#### キュー数バッジ (`.soeji-queue-badge`、右下)

- アップロード中 + 待機中の合計数を表示
- 0のときは非表示
- 白背景に黒文字

### Background Script (`background.js`)

Service Workerとして動作し、以下を担当:
- 設定の読み込み・保存
- Content Scriptへの設定提供

### Popup (`popup/`)

拡張機能アイコンクリック時の設定画面:
- バックエンドURL入力
- API Key入力
- 接続テスト機能

## 開発コマンド

```bash
cd browser-extension
npm install

# 開発モード
npm run dev:firefox  # Firefox で開発
npm run dev:chrome   # Chrome で開発

# ビルド
npm run build        # パッケージ作成（Chrome / Firefox 両対応）

# Lint
npm run lint         # web-ext lint
```

## CSS実装ルール

1. **SVGアイコン**: `innerHTML`でインラインSVGを挿入（アップロードアイコン）
2. **スピナー**: `.soeji-spinner` クラスを持つ `<span>` 要素を `appendChild` で追加
3. **アイコン半透明**: `.soeji-uploaded` クラスをボタンに付与し、`.soeji-upload-btn.soeji-uploaded svg` で `opacity: 0.4` を指定

## バックエンドとの連携

### エンドポイント

| パス | メソッド | 説明 |
|-----|---------|------|
| `/api/upload` | POST | 画像アップロード |
| `/api/upload/test` | GET | API Key検証 |

### リクエストヘッダー

```
X-Watcher-Key: <API Key>
Content-Type: multipart/form-data
```

### レスポンス

```json
{
  "success": true,
  "duplicate": false,
  "image": { ... }
}
```

- `duplicate: true` の場合も成功として扱う（エラーにはしない）

## 履歴アイテムとの紐付け

> 詳細は以下のドキュメントを参照:
> - [docs/nai-history-dom-behavior.md](docs/nai-history-dom-behavior.md) — NAI 履歴アイテムの DOM 挙動
> - [docs/history-tracking.md](docs/history-tracking.md) — history Map によるアップロード状態管理

## Firefox Add-ons 対応

`manifest.json` に以下の設定が必要（Firefox 142以降）:

```json
"browser_specific_settings": {
  "gecko": {
    "data_collection_permissions": {
      "required": ["none"]
    }
  }
}
```
