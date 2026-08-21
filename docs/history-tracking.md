# 履歴アイテムのアップロード状態管理

NAI の履歴アイテムとアップロード状態を紐付けて管理する仕組み。

> NAI の DOM 挙動については [nai-history-dom-behavior.md](nai-history-dom-behavior.md) を参照。

## history Map

画像のアップロード状態を `history` Map で一元管理する。

```javascript
this.history = new Map(); // historyKey → { status }
```

### キー: `historyKey`

履歴アイテムの `data-group-id` 属性（UUID）。NAI がアイテムごとに固定で付与するため、追加・削除・選択変更があっても変わらない。

- `data-group-id` が取れない場合のフォールバックとして、`background-image`（data URI）の djb2 ハッシュ（8桁 hex）を使う
- blob URL は選択のたびに変わりうるので識別子には使わない

```javascript
getHistoryKey(item) {
  return item.getAttribute('data-group-id') || this.getBackgroundImageHash(item);
}
```

### 値: `{ status }`

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `status` | string | `'pending'`/`'uploading'`/`'success'`/`'duplicate'`/`'error'`/`'hidden'` |

### 設計方針

- **DOM参照なし・index なし**: キーが DOM ノードに固定されているため、位置の追跡（シフト／後方探索）は不要
- **削除されたアイテムのエントリは消さない**: 該当ノードが無ければバッジが付かないだけで害はない（セッション中の Map サイズはアップロード数程度）
- **バッジは差分更新**: `syncHistoryBadges()` は現在のバッジ状態（`data-state`）と望ましい状態を比較し、変わったときだけ DOM を触る（MutationObserver のループ防止）

## アップロード対象の解決

ビューアバー（アップロードボタンの置き場所）はページに1つしかなく、表示中の全タイルで共有される。そのため **ボタンクリック時点で**「選択中のタイル」を解決し、その `img.image-grid-image` の blob URL をアップロードする。

```
1. getSelectedTile(): .image-gen-canvas-tile のうち .image-gen-save-bar を持たないもの
   - 候補が複数（生成中の一時状態）なら、生成中でなく画像が読み込まれているものを優先。それでも曖昧なら null
2. getTileImage(tile): tile 内の img.image-grid-image
3. getSelectedHistoryKey(): boxShadow が none でない履歴アイテムの data-group-id
```

## 半透明判定（`soeji-uploaded`）／無効化（`soeji-disabled`）

`updateButtonState()` で一括更新する。body と `#historyContainer` の MutationObserver から呼ばれる。

| 条件 | 状態 |
|------|------|
| 選択中タイルが無い / 画像が無い | `soeji-disabled`（title: No image selected） |
| 生成中（`img.image-grid-image-incoming` あり） | `soeji-disabled`（title: Image is generating...） |
| 選択中履歴アイテムの key が `history` にある | `soeji-uploaded`（アイコン半透明） |

## アップロードキュー

```javascript
uploadQueue item: { id, blobUrl, historyKey, status }
```

| フィールド | 説明 |
|-----------|------|
| `id` | `crypto.randomUUID()` による一意 ID |
| `blobUrl` | 画像データ取得用の blob URL（フェッチに使用） |
| `historyKey` | history Map のキー（状態管理に使用、null の場合あり） |
| `status` | `'pending'`/`'uploading'` |

- キューの重複チェックは `historyKey` で行う
- `historyKey` が null の場合（履歴アイテムが特定できない）は重複チェックをスキップし、history 追跡なしでアップロードのみ実行する

## バッジ同期

### フロー

1. `updateHistoryStatus(historyKey, status)`: history Map の status を更新
2. `syncHistoryBadges()`: 全履歴アイテムを走査し、key に対応するエントリの状態をバッジに反映（差分のみ）
3. 完了/重複の場合は 3 秒後に status を `'hidden'` に変更して再同期

履歴 DOM の変化（追加・削除・選択変更）でも `syncHistoryBadges()` が呼ばれるため、NAI 側で再描画されてもバッジは復元される。

### 履歴アイテムバッジ (`.soeji-history-badge`)

履歴アイテムの右下に表示されるアップロード状態バッジ。

| 状態 | クラス | 表示 | 色 | 自動非表示 |
|------|--------|------|-----|-----------|
| アップロード中/待機中 | `soeji-history-badge-uploading` | スピナー（回転） | 青 (#3b82f6) | なし |
| 完了 | `soeji-history-badge-success` | チェックマーク (✓) | 緑 (#22c55e) | 3秒後 |
| 重複 | `soeji-history-badge-duplicate` | チェックマーク (✓) | 黄 (#eab308) | 3秒後 |
| エラー | `soeji-history-badge-error` | エクスクラメーション (!) | 赤 (#ef4444) | なし |
| 非表示 | `soeji-history-badge-hidden` | - | - | - |

### 動作仕様

- アップロード開始時にスピナーを表示
- 完了/重複の場合は 3 秒後に自動で非表示
- エラーの場合はバッジを保持（リトライを促す）
- 再アップロード実行時はスピナーから再開（既存のタイムアウトをクリア）
- アップロード中/待機中は履歴アイテムの削除ボタンを無効化

## 関連メソッド

| メソッド | 説明 |
|---------|------|
| `findButtonContainer()` | ビューアバー内のボタン注入先を取得 |
| `getSelectedTile()` / `getTileImage(tile)` | 選択中タイルとその画像を取得 |
| `isGenerating(tile)` | 生成中かどうか |
| `getHistoryItems()` | 履歴アイテムの DOM 要素配列を取得（0 番目が最新） |
| `getSelectedHistoryItem()` / `getSelectedHistoryKey()` | 選択中の履歴アイテム／その key を取得 |
| `getHistoryKey(item)` | `data-group-id`（無ければ bgHash）を取得 |
| `updateHistoryStatus(historyKey, status)` | history Map の status を更新し同期 |
| `syncHistoryBadges()` | history Map を DOM に差分同期（削除ボタン状態も管理） |
| `createHistoryBadge(element, state)` | 指定要素にバッジを作成 |
| `updateButtonState()` | アップロードボタンの有効/無効・半透明を更新 |
| `startObserver()` / `startHistoryObserver()` | body／履歴コンテナの監視を開始 |
