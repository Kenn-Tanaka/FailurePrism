## 概要
<!-- この Pull Request で行った変更の目的と概要を記述してください -->

## 変更の種類
- [ ] バグ修正 (Bug fix)
- [ ] 新機能 (New feature)
- [ ] 新規ツールプラグインの追加 (`src/tools/<tool-id>/manifest.tsx`)
- [ ] リファクタリング / パフォーマンス改善
- [ ] ドキュメント・ライセンス更新

## 確認チェックリスト
- [ ] `npm run typecheck` がエラーなく通過した
- [ ] `npm test` の全テストが PASS した（必要に応じてテストを追加した）
- [ ] `npm run build` が成功した
- [ ] 新規ツールプラグインを追加した場合、`docs/PLUGIN_ARCHITECTURE.md` の規約（`isActive === false` 時のグローバルイベント遮断等）を遵守している
- [ ] API キーや認証トークンを永続ストレージや設定ファイルに保存していない
