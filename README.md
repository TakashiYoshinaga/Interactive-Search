# Graph Ladder

[English](README.en.md) | 日本語

ボタンでグラフのパターンを積み上げながら、生成された Cypher と検索結果を同時に確認できる学習ツールです。
[nordwind-workshop](https://github.com/noctetemp/nordwind-workshop) の Session 3（グラフデータベース回）で使うことを想定しています。

- **Graph Ladder デモ**  
  [![Graph Ladder デモ](https://img.youtube.com/vi/pRG5rMNnSj8/maxresdefault.jpg)](https://www.youtube.com/watch?v=pRG5rMNnSj8)

**[体験ページを開く](https://takashiyoshinaga.github.io/Interactive-Search/)**

## できること

- 接続先のスキーマを読み取り、次にたどれるラベルとリレーションを自動で候補表示
- 候補を押す前に、次の段で得られるノード数・リレーション数を先読み
- 組み立てたラダーから実行可能な Cypher を生成し、そのまま AuraDB で実行
- 一致した構造だけを固定レイアウトの 2D / 3D グラフ上で強調
- グラフのノードをクリックして末尾の段を1ノードに絞り込み
- リレーションの `×1` / `×1..2` / `×1..3` を切り替えて可変長パスを比較
- 日本語 / English、ライト / ダークテーマに対応

## 事前準備

[Session 3 の Colab ノートブック](https://colab.research.google.com/github/noctetemp/nordwind-workshop/blob/main/session3_graphs_en.ipynb)で、次のセルを順に実行してください。「セクション 3 だけ」ではデータセットを定義する変数がないため足りません。

1. `0 · Setup` の `%pip -q install neo4j pyvis`
2. `0 · Setup` のデータセット取得セル
3. `3 · 🔌 Connect to your Neo4j` の `driver` と `cypher()` を定義するセル
4. 同セクションの `MATCH (n) DETACH DELETE n` と `UNWIND` / `MERGE` を含む投入セル

> [!WARNING]
> 投入セルは接続先にある既存データをすべて削除します。ワークショップ専用の Aura インスタンスだけに使用してください。

Aura インスタンス作成時にダウンロードした認証情報ファイルも用意します。現行の Aura では、ユーザー名は `neo4j` ではなくインスタンス ID です。Graph Ladder では USERNAME を空欄にすれば BOLT URI から自動で導出します。

## 使い方

1. 体験ページを開き、事前準備の確認後に BOLT URI と PASSWORD を入力します。
2. 「次の候補」から起点ラベルを選び、リレーションと次のラベルを追加します。
3. 下部に生成される Cypher、各段の件数、右側の結果、中央のグラフを見比べます。
4. グラフ上のノードをクリックすると末尾の段をそのノードに固定できます。もう一度クリックすると解除できます。
5. ラダーのリレーション行をクリックするとホップ数、段の行をクリックするとその段まで戻せます。

ワークショップの確認例:

```text
(:Engineer)                                      30 / 30
-[:RESPONDED_TO]->(:Incident)                    29 / 30 · 20 / 20
-[:AFFECTED]->(:Service)                         29 / 30 · 20 / 20 · 15 / 15
-[:DEPENDS_ON]->(:Service)                       29 / 30 · 19 / 20 · 11 / 15 · 12 / 15
末尾を payment-gateway に固定                    10 / 30 ·  6 / 20 ·  1 / 15 ·  1 / 15
DEPENDS_ON を ×1..2 に変更                       18 / 30 · 11 / 20 ·  4 / 15 ·  1 / 15
```

## ローカルで開く

セットアップは要りません。**試すだけなら [体験ページ](https://takashiyoshinaga.github.io/Interactive-Search/) をそのまま開いてください。** 以下は手元のコードを動かす場合の手順です。

ES Modules を使うため、`docs/index.html` を `file://` で直接開くことはできません。リポジトリのルートで次を実行します。

```bash
node tools/serve.mjs
```

その後、[http://127.0.0.1:8000/docs/](http://127.0.0.1:8000/docs/) を開いてください。別ポートを使う場合は `PORT` 環境変数で指定できます。

```bash
# macOS / Linux
PORT=8743 node tools/serve.mjs

# PowerShell
$env:PORT=8743; node tools/serve.mjs
```

Python が使える環境では、リポジトリのルートから `python -m http.server 8000` を実行しても構いません。

## 開発時の検証

検証用依存を最初に1回だけ入れます。

```bash
cd tools
npm install
cd ..
```

Aura の認証情報ファイルを `DoNotUpload/` に置いてから実行します。このディレクトリと `.env` は Git の対象外です。

```bash
node tools/verify-ladder.mjs  # ラダー、Cypher、先読み、受け入れ値
node tools/verify-db.mjs      # 接続、precheck、グラフ読込、エラー分類
node tools/bake-layout.mjs    # 決定論的レイアウトを再生成
```

## セキュリティと制約

- URI、ユーザー名、パスワードはタブのメモリ内だけで扱い、Web Storage、Cookie、URL には保存しません。
- 実行時ライブラリは `docs/vendor/` に同梱し、Content Security Policy で第三者スクリプトを禁止しています。
- Aura への Bolt over WebSocket には 7687 番ポートを使います。組織・会場のネットワークで塞がれている場合は、別のネットワークを試してください。
- 全グラフを一度に描画する教材用ツールです。2,000 ノードまたは 5,000 リレーションを超えるデータベースには向きません。
- 可変長パスは結果数が急増します。重い場合はホップ数やラダーの段数を減らしてください。

## ライセンス

[MIT License](LICENSE)。同梱ライブラリのライセンスは `docs/vendor/` にあります。
