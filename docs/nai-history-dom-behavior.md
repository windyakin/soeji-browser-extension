# NovelAI の DOM 挙動

NovelAI 画像生成ページ（https://novelai.net/image）のうち、拡張機能が依存している DOM 構造と挙動のまとめ。
sc-* クラス名はビルド毎に変わるため使用せず、安定したクラス名・属性・computed style で要素を特定する。

> 2026-08 の NAI アップデートで構造が大きく変わった。以前の「1枚表示＋画像ごとのボタンバー」「履歴は末尾追加＋background-image シフト」という挙動は**もう存在しない**。

## 全体構造

```
.image-gen-output-region
├─ .image-gen-canvas
│   └─ div（パン可能なキャンバス）
│       ├─ svg ×N（装飾、aria-hidden）
│       ├─ .image-gen-canvas-tile [style: left/top/width/height]   ← 画像タイル（新しいものほど上）
│       │   └─ div
│       │       ├─ img.image-grid-image                            ← 表示画像（blob URL）
│       │       ├─ div > .image-gen-save-bar（非選択タイルのみ）     ← ホバー用ボタン群
│       │       └─ div > シードボタン（非選択タイルのみ）
│       └─ .image-gen-canvas-tile ...
└─ .display-grid-bottom                                            ← ビューアバー（ページに1つ、全タイル共通）
    └─ div > .image-gen-viewer-bar
        ├─ div（計測用コピー: visibility:hidden / 0x0）            ← 無視すること
        └─ div（可視バー）
            ├─ div（左: サイズ表示・設定・シードボタン）
            └─ div[style*="margin-left: auto"]（右）
                └─ ... > div                                       ← アップロードボタン注入先
                    ├─ div[style="height: 100%"] > button（ピン留め）
                    ├─ div[style="height: 100%"] > button（コピー）
                    └─ div[style="height: 100%"] > button（保存）

#historyContainer
├─ div（ヘッダー）
├─ div > div（履歴アイテムコンテナ）
│   ├─ div[role="button"][aria-label="choose image"][data-group-id="<UUID>"]   ← 履歴アイテム[0]（最新）
│   │   └─ button[aria-label="delete image(s)"]
│   ├─ div[role="button"][aria-label="choose image"][data-group-id="<UUID>"]   ← 履歴アイテム[1]
│   └─ ...
└─ div（フッター）
```

## ビューアバー（`.display-grid-bottom`）

| 項目 | 内容 |
|------|------|
| 個数 | ページに **1つだけ**。表示中の全タイルで共有され、**選択中の画像**の情報（シード値等）を表示する |
| 計測用コピー | `.image-gen-viewer-bar` の第1子はレイアウト計測用の複製で `visibility: hidden`。`querySelector` で先にヒットするため、**`getComputedStyle(el).visibility !== 'hidden'` で除外必須** |
| ボタン注入先 | 可視要素のうち、直下に `div[style*="height: 100%"] > button` を **2個以上**持つ div（ピン/コピー/保存のグループ）。末尾に `appendChild` すると保存ボタンの右に並ぶ |
| 再描画 | 生成・選択変更ではバーは再構築されない（注入したボタンは残る）。念のため body の MutationObserver で消えていたら再注入する |
| ボタンのクラス | NAI のボタンは状態で styled-components のクラスが差し替わる。画像なし（初回生成開始直後など）は薄い変種（`opacity: 0.5`）、画像ありは通常変種。注入時にコピーしたクラスは自動では変わらないので、定期的に隣のボタンのクラスへ同期する |

## キャンバスタイル（`.image-gen-canvas-tile`）

| 項目 | 内容 |
|------|------|
| 仮想化 | 履歴の全画像分は描画されず、**選択中の画像とその近傍（2〜3個）**のみ。DOM 順や個数から履歴 index を推定することは**できない** |
| 配置 | `style.top` = 履歴 index × ピッチ（画像高さ＋余白）。画像サイズが異なると崩れるので依存しない |
| 選択中タイル | **`.image-gen-save-bar` を持たない唯一のタイル**。非選択タイルにはホバー用オーバーレイ（`.image-gen-save-bar` にピン/コピー/保存ボタン、別 div にシードボタン）が常に存在する |
| 画像 | `img.image-grid-image`（`src` は blob URL）。同じ画像の img 要素は選択変更で差し替わらない |
| 生成中 | タイル内に `div.image-grid-thumbnail-standin` と `img.image-grid-image-incoming` が現れ、完了すると `img.image-grid-image` に置き換わる。（旧 `img.image-grid-streaming-image` は廃止）<br>ページ読み込み後の**初回生成**では、ビューアバーのボタン群とタイルが先に現れ（この時点で img は無い）、その後 `img.image-grid-image-incoming` ↔ `img.image-grid-image` が class/src の差し替えで切り替わる。ノードの増減を伴わないので、**MutationObserver は `childList` だけでなく `attributes`（class/src）も監視する**必要がある |
| 選択操作 | 履歴アイテムのクリックでキャンバスがそのタイルへパンし、バーの内容が切り替わる。ホイールによるパンでは選択は変わらない |
| 識別子 | タイル DOM には group id に相当する属性は**ない**（React の key にのみ `"<groupId>.<variation>"` が入る） |

## 履歴アイテム（`#historyContainer`）

| 対象 | セレクタ / 取得方法 |
|------|-------------------|
| ルート | `#historyContainer` |
| 全アイテム | `#historyContainer [role="button"][aria-label="choose image"]`（DOM 順 = 表示順、0 が最新） |
| 識別子 | `data-group-id` 属性（UUID、ノードに固定で安定） |
| 削除ボタン | アイテム内の `button[aria-label="delete image(s)"]` |
| 選択中アイテム | computed style の **`boxShadow` が `none` 以外**（選択中: `rgba(245,243,194,.75) 0 0 0 2px, ...`）。`borderColor` は選択状態にかかわらず透明なので使えない |
| サムネイル | `background-image` の data URI（`data-group-id` が無い場合の djb2 ハッシュによるフォールバック用） |

### アイテム追加時の挙動

新しい画像が生成されると、新しい DOM 要素がコンテナの**先頭に prepend** される。既存ノードの `data-group-id` / `background-image` は変化しない。

```
【追加前】          【追加後】
 [0] gid=A           [0] gid=D  ← 新規ノード（先頭に挿入）
 [1] gid=B           [1] gid=A  ← 同じノード
 [2] gid=C           [2] gid=B
                     [3] gid=C
```

→ index ではなく `data-group-id` で追跡すればシフト処理は不要。

### アイテム削除時の挙動

該当ノードが DOM から取り除かれるだけ。他のノードは変化しない。

### 選択変更時の挙動

styled-components のクラスが差し替わる（box-shadow あり/なし）。`class` 属性の変更を MutationObserver で検出できる。

## 拡張機能が守るべきルール

| 操作 | 対応 |
|------|------|
| ボタン注入 | `.display-grid-bottom` 内の可視バーから「`div[height:100%] > button` を2個以上持つ div」を探し、1回だけ注入 |
| アップロード対象 | クリック時に「`.image-gen-save-bar` を持たないタイル」の `img.image-grid-image` を解決する（img を固定しない） |
| 生成中判定 | `img.image-grid-image-incoming` / `.image-grid-thumbnail-standin` の有無 |
| 履歴アイテムの同一性 | `data-group-id`（無ければ `background-image` の djb2 ハッシュ） |
| 選択中履歴アイテム | `boxShadow !== 'none'` |
| 履歴の監視 | `#historyContainer` を `childList`（subtree）＋ `attributes: ['class']` で監視。自分が入れたバッジの増減は無視する |
| 全体の監視 | `document.body` を `childList`（subtree）＋ `attributes: ['class', 'src']` で監視し、ボタン再注入と状態更新を行う。自分のボタン/バッジ配下の変化は無視する |
