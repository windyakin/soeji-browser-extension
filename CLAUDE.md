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
    ├── nai-history-dom-behavior.md  # NAIのDOM構造・挙動（ビューアバー / キャンバスタイル / 履歴）
    └── history-tracking.md          # history Mapによるアップロード状態管理
```

## 技術仕様

- **Manifest V3**: Chrome/Firefox両対応
- **認証**: `X-Watcher-Key`ヘッダー（backend の watcher と同じ方式）
- **CORS**: Content Scriptから直接バックエンドにアップロード
- **ストレージ**: `browser.storage.local`（設定保存）

## コンポーネント

### Content Script (`content-scripts/upload.js`)

NovelAIのビューアバー（画像下のボタン列）にアップロードボタンを注入するスクリプト。

#### 主要クラス: `SoejiUploader`

| プロパティ | 型 | 説明 |
|-----------|-----|------|
| `uploadQueue` | Array | アップロード待機キュー（`{id, blobUrl, historyKey, status}`） |
| `history` | Map | 画像状態の一元管理（historyKey → `{status}`）。historyKey は履歴アイテムの `data-group-id` |
| `currentBatchHasError` | boolean | 現在のバッチでエラーが発生したか |
| `resultBadgeTimeout` | number | 結果バッジ非表示タイマーID |
| `currentButton` | Element | ビューアバーに注入した唯一のアップロードボタン |
| `historyBadgeTimeouts` | Map | historyKey → タイムアウトID（完了バッジ自動非表示用） |
| `observer` | MutationObserver | body 監視（`childList` + `class`/`src` 属性。ボタン再注入・状態更新） |
| `stateInterval` | number | 2秒ごとの `updateButtonState()` セーフティネット |
| `historyObserver` | MutationObserver | `#historyContainer` 監視（追加/削除/選択変更でバッジ同期） |

#### アップロードフロー

1. `injectButton()`: `.display-grid-bottom`（ビューアバー、ページに1つ）の可視領域からピン/コピー/保存ボタンのグループを探し、アップロードボタンを1つ注入
   - バーは表示中の全画像で共有されるため、ボタンは画像に紐付かない
2. `handleUpload()`: ボタンクリック時に**その時点で選択中のタイル**（`.image-gen-save-bar` を持たない `.image-gen-canvas-tile`）の `img.image-grid-image` を解決してキューに追加
   - 同じ historyKey がキュー内にある場合は追加しない（連打防止）
   - 既にアップロード済みの画像でも再アップロード可能
   - `history` Mapにstatusを追加し、`syncHistoryBadges()`でバッジを同期
3. `processQueue()`: キューから1件ずつアップロードを開始
4. `executeUpload()`: blob URLから画像を取得し、バックエンドにPOST
5. `showResultStatus()`: キュー完了時に結果バッジを表示
6. `updateBadges()`: キュー状態に応じてバッジを更新
7. `updateButtonState()`: 選択中タイル/履歴アイテムに応じて無効化（生成中・未選択）と半透明（アップロード済み）を更新

### UI要素

#### アップロードボタン (`.soeji-upload-btn`)

- ビューアバー右側のピン/コピー/保存ボタンの隣に表示（ページに1つ）
- 見た目は隣の NAI ボタンの sc-* クラスをコピーして合わせる。NAI は状態でクラスを差し替える（画像なし時は `opacity: 0.5` の薄い変種）ので、`updateButtonState()` のたびに `syncButtonClasses()` で現在のクラスへ同期し、CSS でも `.soeji-upload-btn:not(.soeji-disabled) { opacity: 1 }` で保険をかける
- アイコン: CSS `mask-image` によるアップロード矢印（`::before`）
- アップロード済み/中の画像ではアイコン（`::before`）のみ `opacity: 0.4`（半透明）
  - `.soeji-uploaded` クラスで制御
  - バッジは半透明にならない
- 生成中（`img.image-grid-image-incoming` あり）または選択中タイルが無いときのみ `disabled`（`.soeji-disabled`）
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

1. **アップロードアイコン**: `.soeji-upload-btn::before` に data URI の SVG を `mask-image` として指定（色は `background-color` で制御、`innerHTML` は使わない）
2. **スピナー**: `.soeji-spinner` クラスを持つ `<span>` 要素を `appendChild` で追加
3. **アイコン半透明**: `.soeji-uploaded` クラスをボタンに付与し、`.soeji-upload-btn.soeji-uploaded::before` で `opacity: 0.4` を指定
4. **ボタン無効化**: `.soeji-disabled` クラスで `opacity: 0.4` + `pointer-events: none`

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

## NAI の DOM 構造との紐付け

> 詳細は以下のドキュメントを参照:
> - [docs/nai-history-dom-behavior.md](docs/nai-history-dom-behavior.md) — NAI の DOM 構造・挙動（ビューアバー / キャンバスタイル / 履歴）
> - [docs/history-tracking.md](docs/history-tracking.md) — history Map によるアップロード状態管理

要点:
- sc-* クラスには依存しない。`.display-grid-bottom` / `.image-gen-canvas-tile` / `.image-gen-save-bar` / `img.image-grid-image` / `#historyContainer` / `[aria-label]` / `data-group-id` を使う
- ビューアバー内には `visibility: hidden` の計測用コピーがあるので、可視要素のみを対象にする
- 履歴の選択状態は `boxShadow !== 'none'` で判定（`borderColor` は使えない）
- 履歴アイテムは先頭に prepend され、`data-group-id` はノードに固定（index のシフト処理は不要）

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
