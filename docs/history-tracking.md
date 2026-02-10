# 履歴アイテムのアップロード状態管理

NAI の履歴アイテムとアップロード状態を紐付けて管理する仕組み。

> NAI の履歴アイテムの DOM 挙動については [nai-history-dom-behavior.md](nai-history-dom-behavior.md) を参照。

## history Map

画像のアップロード状態を `history` Map で一元管理する。

```javascript
this.history = new Map(); // bgHash → { status, index }
```

### キー: `bgHash`

履歴アイテムの `background-image`（dataURI）を djb2 ハッシュ化した 8 桁 hex 文字列。

- NAI は履歴アイテムを選択するたびに新しい blob URL を生成するため、blob URL は識別子として使えない
- `background-image` の dataURI は同一画像であれば不変のため、そのハッシュを安定した識別子として使用する

```javascript
getBackgroundImageHash(element) {
  const style = window.getComputedStyle(element);
  const bgImage = style.backgroundImage;
  if (!bgImage || bgImage === 'none') return null;
  return this.hashString(bgImage); // djb2 → 8桁hex
}
```

### 値: `{ status, index }`

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `status` | string | `'pending'`/`'uploading'`/`'success'`/`'duplicate'`/`'error'`/`'hidden'` |
| `index` | number | DOM上の位置（0 = 最新/一番上） |

### 設計方針

- **DOM参照なし**: DOM要素への参照は持たず、`index` でDOM位置を追跡する
- **削除検出**: キー自体が `bgHash` のため、DOM要素の `background-image` と直接突合してインデックスを修正する

## 半透明判定（`soeji-uploaded`）

アップロード済みの画像を選択中のとき、アップロードボタンのアイコンを半透明にする。

```
1. getSelectedHistoryIndex() で選択中の履歴アイテムのインデックスを取得
2. getBackgroundImageHash() でその履歴アイテムの bgHash を取得
3. history.has(bgHash) で判定
```

- 選択中の履歴アイテムがない場合（`index === -1`）は半透明にしない
- `bgHash` が null の場合も半透明にしない

## アップロードキュー

```javascript
uploadQueue item: { id, blobUrl, bgHash, status }
```

| フィールド | 説明 |
|-----------|------|
| `id` | `crypto.randomUUID()` による一意 ID |
| `blobUrl` | 画像データ取得用の blob URL（フェッチに使用） |
| `bgHash` | history Map のキー（状態管理に使用、null の場合あり） |
| `status` | `'pending'`/`'uploading'` |

- キューの重複チェックは `bgHash` で行う（blob URL は毎回変わるため不可）
- `bgHash` が null の場合（履歴に未反映の画像）は重複チェックをスキップし、history 追跡なしでアップロードのみ実行する

## インデックス管理

### 追加時のシフト

新しい履歴アイテムが DOM に追加されると、既存アイテムのインデックスがずれる。`MutationObserver` で履歴コンテナの `childList` を監視し、要素数の増加を検出して全エントリの index をシフトする。

```javascript
shiftHistoryIndices(count) {
  for (const [, data] of this.history) {
    data.index += count;
  }
}
```

### 削除時の修正

履歴アイテムが削除されると、`bgHash` を使って DOM 要素と突合しインデックスを修正する。

```
各エントリについて:
1. data.index（DOM要素数以内にクランプ）の位置の bgHash を確認
2. 一致すれば index を更新（クランプされた場合のみ）
3. 不一致の場合、index - 1 → index - 2 → ... → 0 とループで後方探索
4. どの位置でも一致しなければ、そのエントリ自体が削除されたと判断
   → history Map から削除
```

## バッジ同期

状態変更時に毎回 DOM を走査してバッジを同期する方式（`syncHistoryBadges()`）。

### フロー

1. `updateHistoryStatus(bgHash, status, index)`: history Map の status/index を更新
2. `syncHistoryBadges()`: history Map の内容を DOM に反映
   - すべての既存バッジを削除
   - history Map を走査し、`data.index` に対応する DOM 要素にバッジを作成
3. 完了/重複の場合は 3 秒後に status を `'hidden'` に変更して再同期

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
| `getHistoryItems()` | 履歴アイテムの DOM 要素配列を取得（0 番目が最新） |
| `getSelectedHistoryIndex()` | 現在選択中の履歴アイテムのインデックスを取得 |
| `getBackgroundImageHash(element)` | 要素の `background-image` から djb2 ハッシュ値を取得 |
| `updateHistoryStatus(bgHash, status, index)` | history Map の status/index を更新し同期 |
| `syncHistoryBadges()` | history Map を DOM に同期（毎回全バッジを再作成、削除ボタン状態も管理） |
| `createHistoryBadge(element, state)` | 指定要素にバッジを作成 |
| `shiftHistoryIndices(count)` | 全エントリの index を count 分シフト |
| `handleHistoryDeletion()` | 削除検出時に bgHash で突合してインデックスを修正 |
| `startHistoryObserver()` | 履歴コンテナの監視を開始（追加/削除検出用） |
