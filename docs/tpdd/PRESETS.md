# TPDD設計プリセット

新規プロジェクト画面に表示する設計プリセットは、インストール先の `app/dist/tpdd-presets.json` で編集できます。JSONをUTF-8で保存し、TPDD-Editorを再読み込みすると反映されます。開発環境ではリポジトリの `public/tpdd-presets.json` が同じ設定ファイルです。

各配列要素は1つのプリセットです。

- `id`: プリセットを識別する一意の文字列
- `label`: 新規プロジェクト画面に表示する名称
- `description`: 同画面に表示する説明
- `nodeKinds`: ノード種別の一覧（`id`, `label`, `description`, `paletteKey`）。`paletteKey` は `blue`, `cyan`, `teal`, `lime`, `yellow`, `orange`, `pink`, `olive`, `gray` のいずれか
- `levels`: 左から右へ並ぶ列の一覧（`id`, `label`, `description`）

種別IDと列IDは、それぞれのプリセット内で重複しないようにしてください。種別は最大24件、列は最大12件です。JSONの形式が不正な場合は組み込みプリセットに切り替え、画面に警告を表示します。設定ファイルはアプリの更新で置き換わる場合があるため、組織で変更したファイルは更新前に退避し、更新後に再配置してください。
