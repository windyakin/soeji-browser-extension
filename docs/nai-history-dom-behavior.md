# NovelAI 履歴アイテムのDOM挙動

NovelAI の履歴コンテナ (`#historyContainer`) における DOM 操作は特殊な挙動をするため、拡張機能のインデックス管理において注意が必要。

## DOM構造

```
#historyContainer
  ├─ div（ヘッダー: 「履歴」ラベル、ヘルプアイコン、設定ボタン）
  ├─ div（履歴アイテムコンテナ ← _findHistoryItemContainer() で取得）
  │   ├─ div[role="button"][aria-label="choose image"]（履歴アイテム[0]、最新）
  │   │   └─ button[aria-label="delete image(s)"]（削除ボタン）
  │   ├─ div[role="button"][aria-label="choose image"]（履歴アイテム[1]）
  │   │   └─ button[aria-label="delete image(s)"]
  │   ├─ div[role="button"][aria-label="choose image"]（履歴アイテム[2]）
  │   │   └─ button[aria-label="delete image(s)"]
  │   └─ ...
  └─ div（フッター: 「一括で圧縮保存」ボタン、「Clear History」ボタン）
```

### セレクタの抽象化

sc-* クラス名はビルド毎に変わるため使用しない。実装では以下のセレクタで要素を特定する:

| 対象 | セレクタ / 取得方法 |
|------|-------------------|
| ルート | `#historyContainer` |
| アイテムコンテナ | `[role="button"][aria-label="choose image"]` で最初のアイテムを見つけ `.parentElement` |
| 全アイテム | `container.children`（Array.from で配列化） |
| 削除ボタン | `button[aria-label="delete image(s)"]` |
| 選択中アイテム | `borderColor` の computed style が非透明（`transparent` / `rgba(0,0,0,0)` 以外） |
| アイテム同一性 | `background-image` の computed style を djb2 ハッシュ化 |

## アイテム追加時の挙動

### 概要

新しい画像が生成されると、履歴アイテムが追加される。ただし、**DOM要素の追加は末尾**に行われ、**`background-image` の指定が1つずつ後ろにずれる**ことで、表示上は最新アイテムが先頭に見える。

### 詳細

1. 新しい DOM 要素がコンテナの**末尾**に `appendChild` される
2. 既存の各 DOM 要素の `background-image` が**1つ後ろのDOM要素**にずれる
3. 先頭の DOM 要素（index 0）に新しい画像の `background-image` が設定される
4. 結果として、DOM の並び順は変わらないまま、表示内容だけがシフトする

### 例

```
【追加前】DOM順:
  [0] bg=画像A（最新）
  [1] bg=画像B
  [2] bg=画像C

↓ 画像Dが生成される

【追加後】DOM順:
  [0] bg=画像D（最新）← background-image が差し替わる
  [1] bg=画像A        ← 元の[0]の bg が移動
  [2] bg=画像B        ← 元の[1]の bg が移動
  [3] bg=画像C        ← 新規DOM要素（末尾に追加）、元の[2]の bg が移動
```

### 拡張機能への影響

- `MutationObserver` で `childList` の変更を検出すると、DOM 要素数の増加として検知できる
- しかし、追加された DOM 要素は末尾にあり、**中身（`background-image`）は既存要素からずれて移動している**
- そのため、**全エントリの index を +1 シフト**する必要がある（`shiftHistoryIndices(count)`）
- `getHistoryItems()` で取得した配列は DOM 順のまま使用可能（reverse 不要）

## アイテムの同一性判定

### `background-image` の dataURI によるハッシュ比較

- 各履歴アイテムの `background-image` には dataURI が指定されている
- アイテムが同一かどうかは、この dataURI を比較することでのみ判定可能
- dataURI は巨大なため、**そのまま保持せず djb2 ハッシュ化**して `bgHash` として管理する

```javascript
getBackgroundImageHash(element) {
  const style = window.getComputedStyle(element);
  const bgImage = style.backgroundImage;
  if (!bgImage || bgImage === 'none') return null;
  return this.hashString(bgImage); // djb2 → 8桁hex
}
```

## アイテム削除時の挙動

### 概要

履歴アイテムが削除されると、DOM 要素数が減少する。削除されたアイテムの位置によって、他のアイテムのインデックスがずれる可能性がある。

### 検出と修正のアルゴリズム

`handleHistoryDeletion()` で以下の手順を実行する:

1. 各 history Map エントリについて、現在の `data.index` の DOM 要素の `bgHash` を確認
2. 一致すれば、そのエントリの位置は正しい（変更なし）
3. **不一致**の場合、`index - 1` の位置を確認
4. それでも不一致なら `index - 2`、`index - 3`、... と**後方に向かってループで探索**
5. どの位置でも見つからなければ、そのエントリ自体が削除されたと判断し、history Map から削除

### 削除パターン別の動作

```
【初期状態】
  [0] bg=D（bgHash=xxx） ← 追跡中
  [1] bg=C
  [2] bg=B（bgHash=yyy） ← 追跡中
  [3] bg=A

ケース1: [1]（画像C）が削除された場合
  [0] bg=D  ← index 0、bgHash=xxx → 一致 ✓
  [1] bg=B  ← 追跡中の画像B、元は index 2
  [2] bg=A
  → 画像Bの bgHash を index 2 で確認 → 不一致
  → index 1 で確認 → 一致 ✓ → index を 1 に更新

ケース2: [2]（画像B、追跡対象）自体が削除された場合
  [0] bg=D  ← index 0、bgHash=xxx → 一致 ✓
  [1] bg=C
  [2] bg=A
  → 画像Bの bgHash を index 2 で確認 → 不一致
  → index 1 で確認 → 不一致
  → index 0 で確認 → 不一致
  → history Map から削除
```

## まとめ: 拡張機能が守るべきルール

| 操作 | 対応 |
|------|------|
| アイテム追加検出 | `childList` 変更で DOM 要素数の増加を検知し、全エントリの index を `+count` シフト |
| アイテム同一性判定 | `background-image` の dataURI を djb2 ハッシュ化した `bgHash` で比較 |
| アイテム削除検出 | DOM 要素数の減少を検知し、`bgHash` で現在位置から後方探索して index を修正 |
| 探索失敗時 | 該当エントリを history Map から削除（管理対象外にする） |
| DOM 順序 | `Array.from(container.children)` がそのまま表示順（reverse 不要） |
