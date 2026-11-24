# HAIA

FailurePrism のメニューで **HAIA** を選ぶか、`#haia` を開きます。Gateway が認証を要求する環境では「実行設定」にクライアントトークンを入力してください。

## タスクとモデル

- 「実行」でタスクを選び、本文を入力します。システムプロンプト欄にはワークフロー XML を直接入力できます。
- 「タスク」は既存タスクの編集、名前変更（リネーム）、新規登録、削除に使えます。変更はインストール先の `tasks.local.json` に保存されます。名前変更時は旧名称のタスクが自動で置き換わります。
- 「Alias メンテナ」は `app/haia/models.json` を更新します。保存後に **Haia を再起動** すると、HAIA 内で対応表が再読込されます。開発時のインストールフォルダは `.runtime/haia` です。
- ワークフローには `alias` または `default_model_alias` を指定します。未登録 Alias には `models.json` の `defaultAlias` を使用し、実行ログに切り替えを記録します。配布シードの既定は `gemini38_flash` です。使用可能な Provider、モデル、API キーは Gateway 側の設定に従います。
- LLM のタイムアウトは無通信時間を秒で指定します。リクエストの送信と応答データの受信で計測をやり直します。`0` は Haia 側のタイムアウトを無効にします。
- 既存のワークフローは原文のまま収録されています。未完成のタスクや旧モデル属性は、実行時に表示されるステップを確認して手作業で修正してください。
- 更新時は利用者の `models.json` と `tasks.local.json` を新しい配布先へ引き継いでください。同じフォルダに上書き展開する場合、配布シードは `models.default.json` の名前で配置されます。

## 文書と字幕

- TXT、Markdown、PDF を画面から読み込めます。DOCX、ODT、EPUB、HTML の読み込みと DOCX、ODT、PPTX、HTML、EPUB の出力には Pandoc が必要です。
- 字幕の取得には公式配布の yt-dlp と、同ツールが対応する Node.js が必要です（Node.js 22 以降）。GUI の「YouTube 字幕」では、言語コードと手動作成・自動生成の区別を確認してトラックを選べます。字幕は YouTube へ直接接続して取得します。 [yt-dlp の配布元と設定](https://github.com/yt-dlp/yt-dlp#installation)
- Windows では `pandoc.exe` と `yt-dlp.exe` を `app/haia/bin/` または PATH から利用できます。管理者が固定の実行ファイルを指定する場合は、FailurePrism 起動前に環境変数 `HAIA_PANDOC` と `HAIA_YT_DLP` にそれぞれ絶対パスを設定してください。
- ワークフローの `languages="ja,en"` は日本語、英語の順に探します。`prefer="manual"` は選んだ言語内で手動字幕を優先し、`manual_only` は手動字幕がある言語を探します。言語指定を省略したときは実行画面の優先言語を使用します。投稿者名が取得できない場合、`SANITIZED_AUTHOR_NAME` は Python 版互換の `unknown_author` になり、保存先パスは `temp/unknown_author/` になります（別の既定フォルダを使いたい場合は、ワークフロー側で `type="string" op="sanitize_path" default="outputs"` などを指定してください）。
- `file_read`、`file_write`、`convert` は Haia インストールフォルダの `temp/` 内を使います。`convert` の `fast` プロファイルは PDF.js でテキストを抽出します。テキスト書き込みは UTF-8、UTF-8 BOM 付き、UTF-16LE、Latin-1、ASCII に対応します。テキスト読み込みはこれら（`utf_8` や `utf8sig` などの別名を含む）に加え、`shift_jis` / `cp932` / `euc-jp` の読み込み専用デコードにも対応します。

音声合成と音声用の自動配役は後続フェーズで扱います。
