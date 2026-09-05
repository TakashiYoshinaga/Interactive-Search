/**
 * 辞書と t()。
 *
 * 受講者は日本語話者だが、ノートブックもワークショップ本体も英語なので
 * 画面だけ日本語に閉じてしまうと対応が取れなくなる。両方を等価に持ち、
 * いつでも切り替えられるようにする。
 *
 * 訳してはいけないもの: Cypher の本文、ラベル名、リレーション型、ノード名。
 * これらは DB から来た文字列そのものであり、訳すと画面と DB が食い違う。
 * 辞書に埋め込むのは「その周りの説明文」だけで、DB 由来の値は {placeholder}
 * として差し込む。
 *
 * 文中の記法は screens.js の簡易レンダラが解釈する:
 *   `...`  等幅（コード・URI・セル名）
 *   **...** 強調
 *   \n     段落の区切り
 * どちらも innerHTML を通さず DOM を組み立てるので、辞書に HTML は書かない。
 */

export const LANGS = ['ja', 'en'];

const STORE_KEY = 'gl.lang';

const NOTEBOOK_URL =
  'https://colab.research.google.com/github/noctetemp/nordwind-workshop/blob/main/session3_graphs_en.ipynb';
const REPO_URL = 'https://github.com/noctetemp/nordwind-workshop';

const DICT = {
  ja: {
    // ── アプリ本体の枠 ────────────────────────────────────────────────
    'app.title': 'Graph Ladder',
    'app.theme': '表示を切り替える',
    'app.resetView': '表示位置を戻す',
    'app.disconnect': '切断',
    'app.copy': 'コピー',
    'app.status': '{nodes} ノード · {labels} ラベル',
    'graph.hint.2d': 'ドラッグで移動 · ホイールでズーム',
    'graph.hint.3d': 'ドラッグで回転 · ホイールでズーム',
    'graph.hint.select': 'ノードをクリックして絞り込み · 結果欄の名前をクリックしてフォーカス',
    'graph.labels.all': '名前をすべて表示',
    'graph.labels.hint': '通常はホバー中・接続先・ピン留めの名前を表示します。オンにすると他の名前も表示します。',

    // ── 共通の操作 ────────────────────────────────────────────────────
    'common.back': '戻る',
    'common.retry': 'やり直す',
    'common.cancel': 'キャンセル',
    'common.lang': '言語',

    // ── splash ────────────────────────────────────────────────────────
    'splash.title': 'Graph Ladder',
    'splash.tagline': 'Cypher を組み立てて学ぶ',
    'splash.lead':
      'ボタンを押してクエリの形（ラダー）を積み上げると、本物の Cypher が生成されてあなたの Neo4j 上で実行され、該当するノードだけがグラフの中で光ります。',
    'splash.body':
      'noctetemp/nordwind-workshop の **Session 3（グラフDB回）** のための Cypher 学習ツールです。受講者自身の AuraDB にブラウザから直接つなぎます。中継サーバはありません。',
    'splash.repo': 'ワークショップのリポジトリ',
    'splash.notebook': 'Session 3 のノートブック（Colab）',
    'splash.start': 'はじめる',
    'splash.note':
      '先にノートブックでデータを投入しておく必要があります。次の画面で確認します。',
    'splash.author': '作者 — Takashi Yoshinaga',

    // ── prereq ────────────────────────────────────────────────────────
    'prereq.title': '先に Colab でデータを投入してください',
    'prereq.lead':
      'まだ接続していないので、ここでは実際に確認できません。ノートブックで次の **4 つのセル** をこの順に実行してあることを確かめてください。',
    'prereq.col.n': '#',
    'prereq.col.section': 'セクション',
    'prereq.col.cell': 'セル',
    'prereq.col.why': '理由',
    'prereq.s1.cell': '`%pip -q install neo4j pyvis`',
    'prereq.s1.why': 'ドライバを入れる',
    'prereq.s2.cell': 'データセットを GitHub から取得するセル',
    'prereq.s2.why':
      '`teams` / `engineers` / `services` / `incidents` / `rels` を定義する。投入セルはこの変数を読むので、飛ばすと `NameError` になる',
    'prereq.s3.cell': '`driver` と `cypher()` を定義するセル',
    'prereq.s3.why': '投入セルが `cypher()` を呼ぶ',
    'prereq.s4.cell': '`MATCH (n) DETACH DELETE n` と `UNWIND` / `MERGE` のセル',
    'prereq.s4.why': 'これが実際にデータを入れるセル',
    'prereq.note.both':
      'セクション 3 には **接続セルと投入セルの両方** が入っています。接続セルだけ実行して満足しないでください。',
    'prereq.note.skip': 'セクション 1 と 2 は必要ありません。',
    'prereq.note.running':
      'Aura に**データ投入済み**の方は、接続の前に `https://console.neo4j.io` でインスタンスが **Running** になっていることを確認してください。無料の Aura インスタンスは 3 日使わないと自動で一時停止します。Paused のときは Resume を押し、**60 秒ほど待ってから**つないでください。',
    'prereq.warn':
      '投入セルは `MATCH (n) DETACH DELETE n` から始まります。**そのインスタンスの中身は全部消えます。** ワークショップ用の使い捨てインスタンスにだけ向けてください。',
    'prereq.notebook': 'ノートブックを開く',
    'prereq.done': '投入済み — 次へ',

    // ── login ─────────────────────────────────────────────────────────
    'login.title': 'あなたの Neo4j につなぐ',
    'login.lead':
      'ノートブックの `3 · 🔌 Connect to your Neo4j` に貼ったのと同じ接続情報を入れてください。',
    'login.uri': 'BOLT URI',
    'login.uri.hint':
      'ブラウザからは `neo4j+s://` か `bolt+s://` だけが使えます。',
    'login.user': 'USERNAME',
    'login.user.warn':
      '現行の Aura では **ユーザー名は `neo4j` ではなくインスタンス ID**（URI ホスト名の最初のドット区切り）です。ノートブックは `neo4j` を直書きしていて、そのままでは通りません。',
    'login.user.hint':
      '空のままにすると URI から自動で取り出します。',
    'login.user.derived': 'URI から `{id}` を使います。',
    'login.password': 'PASSWORD',
    'login.password.hint':
      'インスタンスを作ったときにダウンロードした認証情報ファイルに入っています。',
    'login.privacy':
      '入力した接続情報は **このタブのメモリの中だけ** にあります。保存もしませんし、あなたのデータベース以外のどこにも送りません。',
    'login.submit': '接続',
    'login.err.uri': 'BOLT URI を入れてください。',
    'login.err.password': 'PASSWORD を入れてください。',
    'login.err.derive':
      'URI からユーザー名を取り出せませんでした。インスタンス ID を直接入れてください。',

    // ── connecting ────────────────────────────────────────────────────
    'connecting.title': '接続しています…',
    'connecting.lead':
      'ハンドシェイクとスキーマの読み取りをしています。数秒かかります。',
    'connecting.note':
      '待たされる場合、7687 番ポートがネットワークで塞がれていることがあります。',

    // ── precheck ──────────────────────────────────────────────────────
    'precheck.title': 'データベースの中身',
    'precheck.nodes': 'ノード',
    'precheck.rels': 'リレーション',
    'precheck.col.label': 'ラベル',
    'precheck.col.count': '件数',
    'precheck.reltypes': 'リレーション型',
    'precheck.nordwind.title': 'ワークショップのデータのようです',
    'precheck.nordwind.body':
      '件数も内訳も想定どおりです。そのまま進めます。',
    'precheck.empty.title': 'データベースが空です',
    'precheck.empty.body':
      'ノードが 1 つもありません。ノートブックの投入セルがまだ実行されていないか、別のインスタンスにつないでいます。\n投入し直してから「もう一度確認」を押してください。',
    'precheck.other.title': '想定と違う中身です',
    'precheck.other.body':
      'ワークショップのデータセットではないようです。このツールは候補も色も **接続先のスキーマから毎回導出する** ので、このまま使えます。\nただしワークショップの資料に出てくる件数（73 ノード / 153 リレーション、`payment-gateway` など）とは一致しません。',
    'precheck.toolarge.title': 'グラフが大きすぎます',
    'precheck.toolarge.body':
      'このツールはグラフ全体を一度に描くので、ワークショップの 73 ノード規模を想定しています。この規模では描画が重くなります。\nそれでも進めることはできます。',
    'precheck.proceed': '進む',
    'precheck.proceedAnyway': 'それでも進む',
    'precheck.recheck': 'もう一度確認',
    'precheck.toPrereq': '投入の手順を見る',

    // ── fatal ─────────────────────────────────────────────────────────
    'fatal.detail': '詳細',
    'fatal.retry': 'やり直す',
    'fatal.auth.title': '認証に失敗しました',
    'fatal.auth.body':
      'いちばん多い原因はユーザー名です。**現行の Aura のユーザー名は `neo4j` ではなくインスタンス ID**（URI ホスト名の最初のドット区切り、たとえば `neo4j+s://5b75437f.databases.neo4j.io` なら `5b75437f`）です。ノートブックは `neo4j` を直書きしているので、そのままコピーすると必ずここで落ちます。\nユーザー名を空にして送れば URI から自動で取り出します。\nパスワードはインスタンス作成時にダウンロードした認証情報ファイルの `NEO4J_PASSWORD` です。ブラウザで表示するコンソールのパスワードとは別物のことがあります。',
    'fatal.ratelimit.title': '試行が多すぎます',
    'fatal.ratelimit.body':
      'Aura は認証に何度か失敗すると数秒間ロックします。**そのまま何度も押さないでください。** 待つほど長くなります。\n30 秒ほど置いてから、ユーザー名とパスワードを見直して 1 回だけやり直してください。',
    'fatal.unreachable.title': 'データベースに届きません',
    'fatal.unreachable.body':
      'このツールは **7687 番ポート** で Bolt を話します。会社・大学・ホテル・会場の Wi-Fi はこのポートを塞いでいることがよくあります。**これがこの画面のいちばん多い原因です。**\nスマートフォンのテザリングや別のネットワークに切り替えて、もう一度試してください。ブラウザで https:// のサイトが見えることは、7687 番が通ることの証明にはなりません。\nあわせて、インスタンスが起動しているか（一時停止していないか）を `https://console.neo4j.io` で確認してください。\nURI のホスト名の綴りも見直してください。',
    'fatal.paused.title': 'インスタンスが一時停止しています',
    'fatal.paused.body':
      '無料の Aura インスタンスは 3 日使わないと自動で一時停止します。\n`https://console.neo4j.io` を開いて Resume を押し、**60 秒ほど待ってから** やり直してください。起動直後は接続できないことがあります。\n一時停止でデータは消えません。',
    'fatal.badscheme.title': 'この URI はブラウザから使えません',
    'fatal.badscheme.body':
      'ブラウザから使えるのは `neo4j+s://` と `bolt+s://` だけです。\n`neo4j://` と `bolt://` は暗号化されていません。このページは https で配信されているので、ブラウザが混在コンテンツとしてブロックします。\n`neo4j+ssc://` は自己署名証明書を許す指定ですが、ブラウザには「この証明書を信じる」と伝える手段がないので使えません。\nAura の URI はもともと `neo4j+s://` です。ノートブックからコピーするときにスキームを書き換えないでください。',
    'fatal.timeout.title': 'クエリが時間内に終わりませんでした',
    'fatal.timeout.body':
      'サーバ側のタイムアウトで打ち切りました。\nホップ数のダイヤル（`×1..2` / `×1..3`）を下げると、たどるパスの数が一気に減ります。まず `×1` に戻してみてください。\n段を減らすのも効きます。',
    'fatal.toolarge.title': 'グラフが大きすぎます',
    'fatal.toolarge.body':
      'このツールはグラフ全体を一度に描きます。ワークショップの 73 ノード / 153 リレーションの規模のために作られていて、それより大きなデータベースは想定していません。\nワークショップ用のインスタンスにつなぎ直してください。',
    'fatal.fileprotocol.title': 'http で開き直してください',
    'fatal.fileprotocol.body':
      'このページが `file://` で開かれています。ES モジュールは `file://` では読み込めないので、何も動きません。\nリポジトリのルートで `node tools/serve.mjs` を実行して、`http://127.0.0.1:8000/docs/` を開いてください。\nPython が入っていれば `python -m http.server` でも構いません（この場合は `http://localhost:8000/docs/`）。',
    'fatal.unknown.title': '予期しないエラーです',
    'fatal.unknown.body':
      '想定していない失敗です。下の詳細に元のメッセージが出ています。\nもう一度試しても直らない場合は、接続情報とネットワークを見直してください。',

    // ── ラダー ────────────────────────────────────────────────────────
    'ladder.title': 'ラダー',
    'ladder.empty': '右の候補から起点のラベルを選んでください。',
    'ladder.unpin': 'ピンを外す',
    'ladder.truncate': 'ここまで戻す',
    'ladder.hops': 'ホップ数を切り替える',

    // ── 候補 ──────────────────────────────────────────────────────────
    'cand.title': '次の候補',
    'cand.start': 'start from {pattern}',
    'cand.stats': '{nodes} ノード · {edges} エッジ',
    'cand.dead': '行き止まり',
    'cand.running': '数えています…',
    'cand.none': 'ここから伸ばせる辺はありません。',
    'cand.error': '候補を数えられませんでした。',
    'cand.clear': 'CLEAR',
    'cand.max': '段はここまでです（最大 {n} 段）。',

    // ── 結果 ──────────────────────────────────────────────────────────
    'results.title': '結果',
    'results.empty': 'まだ実行していません。',
    'results.running': '実行しています…',
    'results.error': '実行に失敗しました。',
    'results.unnamed': '（名前なし）',

    // ── Cypher バー ───────────────────────────────────────────────────
    'cypher.empty': 'ラダーを組むと、ここに実行される Cypher がそのまま出ます。',
    'cypher.stats': '{paths} パス · {ms} ms',
    'cypher.running': '実行しています…',
    'cypher.error': 'エラー',
    'toast.copied': 'Cypher をコピーしました',
    'toast.copyFailed': 'コピーできませんでした',
    'toast.tooLong': 'ラダーは最大 {max} 段です',
    'toast.pinNoKey': 'このノードには固定に使える name / id がありません',
    'toast.pinLabel': '末尾は :{label} です。:{got} のノードには固定できません',
  },

  en: {
    'app.title': 'Graph Ladder',
    'app.theme': 'Toggle light / dark',
    'app.resetView': 'Reset the view',
    'app.disconnect': 'Disconnect',
    'app.copy': 'Copy',
    'app.status': '{nodes} nodes · {labels} labels',
    'graph.hint.2d': 'Drag to pan · Scroll to zoom',
    'graph.hint.3d': 'Drag to rotate · Scroll to zoom',
    'graph.hint.select': 'Click a node to filter · Click a name in Results to focus',
    'graph.labels.all': 'Show all names',
    'graph.labels.hint': 'Normally shows names for hovered, connected and pinned nodes. Turn on to show other names too.',

    'common.back': 'Back',
    'common.retry': 'Try again',
    'common.cancel': 'Cancel',
    'common.lang': 'Language',

    'splash.title': 'Graph Ladder',
    'splash.tagline': 'Learn Cypher by building it',
    'splash.lead':
      'Click buttons to stack up a query shape — a ladder. Real Cypher is generated from it, run against your own Neo4j, and the matching nodes light up in the graph.',
    'splash.body':
      'A Cypher learning tool for **session 3 (the graph database session)** of noctetemp/nordwind-workshop. Your browser talks to your own AuraDB directly; there is no server in between.',
    'splash.repo': 'The workshop repository',
    'splash.notebook': 'The session 3 notebook (Colab)',
    'splash.start': 'Start',
    'splash.note':
      'You need to have loaded the data from the notebook first. The next screen walks through it.',
    'splash.author': 'Author — Takashi Yoshinaga',

    'prereq.title': 'Load the data in Colab first',
    'prereq.lead':
      'Nothing is connected yet, so this cannot be checked here. Make sure you have run these **four cells** in the notebook, in this order.',
    'prereq.col.n': '#',
    'prereq.col.section': 'Section',
    'prereq.col.cell': 'Cell',
    'prereq.col.why': 'Why',
    'prereq.s1.cell': '`%pip -q install neo4j pyvis`',
    'prereq.s1.why': 'Installs the driver',
    'prereq.s2.cell': 'The cell that fetches the dataset from GitHub',
    'prereq.s2.why':
      'It defines `teams` / `engineers` / `services` / `incidents` / `rels`. The load cell reads those Python variables, so skipping it raises `NameError`',
    'prereq.s3.cell': 'The cell that defines `driver` and `cypher()`',
    'prereq.s3.why': 'The load cell calls `cypher()`',
    'prereq.s4.cell': '`MATCH (n) DETACH DELETE n`, then the `UNWIND` / `MERGE` cells',
    'prereq.s4.why': 'This is the cell that actually loads the data',
    'prereq.note.both':
      'Section 3 contains **both the connect cell and the load cell.** Running only the connect cell is not enough.',
    'prereq.note.skip': 'Sections 1 and 2 are not required.',
    'prereq.note.running':
      'If you have **already loaded data**, check at `https://console.neo4j.io` that your instance is **Running** before connecting. Free Aura instances pause automatically after 3 days of no use. If it is paused, press Resume and **wait about 60 seconds** before trying again.',
    'prereq.warn':
      'The load cell begins with `MATCH (n) DETACH DELETE n`. **It erases everything in that instance.** Point it only at a throwaway workshop instance.',
    'prereq.notebook': 'Open the notebook',
    'prereq.done': 'Already loaded — next',

    'login.title': 'Connect to your Neo4j',
    'login.lead':
      'Use the same connection details you pasted into `3 · 🔌 Connect to your Neo4j` in the notebook.',
    'login.uri': 'BOLT URI',
    'login.uri.hint':
      'Only `neo4j+s://` and `bolt+s://` work from a browser.',
    'login.user': 'USERNAME',
    'login.user.warn':
      'On current Aura instances the **username is the instance id** — the first dot-segment of the URI host — **not `neo4j`.** The notebook hardcodes `neo4j`, and that fails.',
    'login.user.hint': 'Leave it blank and it is derived from the URI.',
    'login.user.derived': 'Will use `{id}`, derived from the URI.',
    'login.password': 'PASSWORD',
    'login.password.hint':
      'It is in the credentials file you downloaded when you created the instance.',
    'login.privacy':
      'What you type stays **in this tab\u2019s memory only.** It is never stored, and never sent anywhere except your database.',
    'login.submit': 'Connect',
    'login.err.uri': 'Enter the BOLT URI.',
    'login.err.password': 'Enter the PASSWORD.',
    'login.err.derive':
      'Could not derive a username from that URI. Type the instance id instead.',

    'connecting.title': 'Connecting\u2026',
    'connecting.lead':
      'Shaking hands and reading the schema. This takes a few seconds.',
    'connecting.note':
      'If this hangs, port 7687 may be blocked on this network.',

    'precheck.title': 'What is in the database',
    'precheck.nodes': 'nodes',
    'precheck.rels': 'relationships',
    'precheck.col.label': 'Label',
    'precheck.col.count': 'Count',
    'precheck.reltypes': 'Relationship types',
    'precheck.nordwind.title': 'This looks like the workshop dataset',
    'precheck.nordwind.body':
      'The totals and the per-label breakdown are what we expect. Go ahead.',
    'precheck.empty.title': 'The database is empty',
    'precheck.empty.body':
      'There are no nodes at all. Either the load cell has not been run yet, or this is a different instance.\nLoad the data, then press "Check again".',
    'precheck.other.title': 'This is not what we expected',
    'precheck.other.body':
      'This does not look like the workshop dataset. The tool still works: every candidate, colour and shape is **derived from whatever schema it finds**.\nThe numbers in the workshop material (73 nodes / 153 relationships, `payment-gateway` and so on) will not match.',
    'precheck.toolarge.title': 'This graph is large',
    'precheck.toolarge.body':
      'The tool draws the whole graph at once, and is meant for the workshop\u2019s ~73-node dataset. At this size the display will be slow and crowded.\nYou can still go ahead.',
    'precheck.proceed': 'Proceed',
    'precheck.proceedAnyway': 'Proceed anyway',
    'precheck.recheck': 'Check again',
    'precheck.toPrereq': 'Show the loading steps',

    'fatal.detail': 'Details',
    'fatal.retry': 'Try again',
    'fatal.auth.title': 'Authentication failed',
    'fatal.auth.body':
      'The username is the usual cause. **On current Aura instances the username is the instance id**, the first dot-segment of the URI host — for `neo4j+s://5b75437f.databases.neo4j.io` it is `5b75437f`, not `neo4j`. The notebook hardcodes `neo4j`, so copying it verbatim always fails here.\nLeave the username blank and it is derived from the URI for you.\nThe password is `NEO4J_PASSWORD` from the credentials file you downloaded when the instance was created — not necessarily the one you use for the web console.',
    'fatal.ratelimit.title': 'Too many attempts',
    'fatal.ratelimit.body':
      'Aura locks you out for a few seconds after several failed sign-ins. **Do not keep pressing retry** — each attempt extends the wait.\nWait about 30 seconds, check the username and password, then try once.',
    'fatal.unreachable.title': 'Cannot reach the database',
    'fatal.unreachable.body':
      'This tool speaks Bolt on **port 7687**. Corporate, campus, hotel and conference networks very often block that port. **This is by far the most common reason for this screen.**\nTry a phone hotspot or another network. Being able to load https:// sites proves nothing about port 7687.\nAlso check that the instance is actually running — not paused — at `https://console.neo4j.io`.\nAnd check the host name in the URI for typos.',
    'fatal.paused.title': 'The instance is paused',
    'fatal.paused.body':
      'Free Aura instances pause automatically after 3 days of no use.\nOpen `https://console.neo4j.io`, press Resume, and **wait about 60 seconds** before trying again. Connections right after a resume can still fail.\nPausing does not delete your data.',
    'fatal.badscheme.title': 'That URI cannot be used from a browser',
    'fatal.badscheme.body':
      'Only `neo4j+s://` and `bolt+s://` work here.\n`neo4j://` and `bolt://` are unencrypted. This page is served over https, so the browser blocks them as mixed content.\n`neo4j+ssc://` accepts a self-signed certificate, but a browser has no way to be told to trust one, so it cannot work either.\nAura URIs are already `neo4j+s://`. Do not rewrite the scheme when copying from the notebook.',
    'fatal.timeout.title': 'The query took too long',
    'fatal.timeout.body':
      'The server-side timeout cut it off.\nLower the hop dial (`×1..2` / `×1..3`): the number of paths falls steeply. Try going back to `×1` first.\nRemoving a rung helps too.',
    'fatal.toolarge.title': 'This graph is too large',
    'fatal.toolarge.body':
      'The tool draws the whole graph at once. It is built for the workshop\u2019s ~73-node, ~153-relationship dataset and does not expect anything much bigger.\nConnect to the workshop instance instead.',
    'fatal.fileprotocol.title': 'Open this over http instead',
    'fatal.fileprotocol.body':
      'This page was opened as `file://`. ES modules cannot load from `file://`, so nothing will run.\nFrom the repository root, run `node tools/serve.mjs`, then open `http://127.0.0.1:8000/docs/`.\nIf you have Python, `python -m http.server` works too — then open `http://localhost:8000/docs/`.',
    'fatal.unknown.title': 'Something unexpected happened',
    'fatal.unknown.body':
      'This is a failure the tool does not recognise. The original message is in the details below.\nIf trying again does not help, check the connection details and the network.',

    'ladder.title': 'Ladder',
    'ladder.empty': 'Pick a starting label from the candidates.',
    'ladder.unpin': 'Remove the pin',
    'ladder.truncate': 'Cut back to here',
    'ladder.hops': 'Change the number of hops',

    'cand.title': 'Next steps',
    'cand.start': 'start from {pattern}',
    'cand.stats': '{nodes} nodes · {edges} edges',
    'cand.dead': 'dead end',
    'cand.running': 'counting\u2026',
    'cand.none': 'Nothing leads out of here.',
    'cand.error': 'Could not count the candidates.',
    'cand.clear': 'CLEAR',
    'cand.max': 'That is as far as the ladder goes ({n} rungs).',

    'results.title': 'Results',
    'results.empty': 'Nothing has been run yet.',
    'results.running': 'running\u2026',
    'results.error': 'The query failed.',
    'results.unnamed': '(no name)',

    'cypher.empty': 'Build a ladder and the Cypher that runs appears here, verbatim.',
    'cypher.stats': '{paths} paths · {ms} ms',
    'cypher.running': 'running\u2026',
    'cypher.error': 'error',
    'toast.copied': 'Cypher copied',
    'toast.copyFailed': 'Could not copy',
    'toast.tooLong': 'The ladder is limited to {max} rungs',
    'toast.pinNoKey': 'This node has no name or id that can be used for a pin',
    'toast.pinLabel': 'The tail is :{label}; a :{got} node cannot be pinned here',
  },
};

// 辞書に持たせない外部リンク。訳語ではないので t() の外に置く
export const LINKS = { repo: REPO_URL, notebook: NOTEBOOK_URL };

let current = 'ja';
const subscribers = new Set();

function normalise(lang) {
  const s = String(lang || '').toLowerCase();
  return LANGS.find((l) => s === l || s.startsWith(l + '-')) || null;
}

/** localStorage → navigator.language → 'ja'。見た目の好みなので保存してよい
 *  （認証情報は決して保存しない）。 */
export function storedLang() {
  try {
    const saved = normalise(localStorage.getItem(STORE_KEY));
    if (saved) return saved;
  } catch { /* プライベートウィンドウ等。読めなくても続行する */ }
  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  return normalise(nav) || 'ja';
}

export function getLang() {
  return current;
}

export function setLang(lang) {
  const next = normalise(lang) || 'ja';
  current = next;
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', next);
    applyToDom(document);
  }
  try { localStorage.setItem(STORE_KEY, next); } catch { /* 保存できなくてよい */ }
  for (const fn of [...subscribers]) {
    try { fn(next); } catch { /* 購読者の失敗で切り替えを止めない */ }
  }
  return next;
}

/** 見つからないキーはもう一方の言語 → キー文字列の順に落とす。
 *  訳し忘れても画面が空白にならないようにするため。 */
export function t(key, vars) {
  const other = current === 'ja' ? 'en' : 'ja';
  const raw = (DICT[current] && DICT[current][key]) ??
              (DICT[other] && DICT[other][key]) ??
              key;
  if (!vars) return raw;
  return String(raw).replace(/\{(\w+)\}/g, (m, name) =>
    (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
}

/** [data-i18n] / [data-i18n-title] / [data-i18n-placeholder] を差し替える。
 *  textContent で書くので、辞書に HTML を書いても素通りしない。 */
export function applyToDom(root = document) {
  const scope = root || document;
  const each = (attr, fn) => {
    if (scope.nodeType === 1 && scope.hasAttribute(attr)) fn(scope, scope.getAttribute(attr));
    for (const el of scope.querySelectorAll(`[${attr}]`)) fn(el, el.getAttribute(attr));
  };
  each('data-i18n', (el, key) => { el.textContent = t(key); });
  each('data-i18n-title', (el, key) => { el.setAttribute('title', t(key)); });
  each('data-i18n-placeholder', (el, key) => { el.setAttribute('placeholder', t(key)); });
  return scope;
}

/** 言語が変わったら呼ばれる。戻り値を呼ぶと購読を解除する。 */
export function onLangChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
