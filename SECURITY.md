# Security Policy

## Supported Versions

現在セキュリティアップデートを提供しているバージョンは以下の通りです。

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

---

## セキュリティ設計原則 (Security Architecture)

**FailurePrism** および同梱の **LLM-Gateway v2.0.0** は、以下のセキュリティ原則に基づいて設計・実装されています。コントリビューションの際もこれらの原則を厳守してください。

1. **API キー・認証情報の保護**:
   - 外部 LLM プロバイダ（OpenRouter 等）の API キーや Gateway 認証トークンは、`MaintenanceTool.exe` を通じて **Windows 資格情報マネージャー（Windows Credential Manager / ユーザー領域）** にのみ保存されます。
   - 設定ファイル（`gateway/config/*.json`）や Git リポジトリ、ブラウザの永続ストレージ（`localStorage`, `sessionStorage`, `IndexedDB`）には API キーや認証トークンを一切保存しません。
2. **ローカル通信限定バインド**:
   - Web サーバー（`scripts/server.mjs`）および `llm-gateway.exe` は既定でループバックアドレス（`127.0.0.1`）にのみバインドされ、外部ネットワークからの直接アクセスを遮断します。
3. **ディレクトリトラバーサル防止**:
   - 内蔵静的ファイル配信サーバーは `path.relative` による厳密な境界検証を行い、配信ルート（`dist/`）外へのアクセス（`..` や別ドライブ指定など）をすべて `403 Forbidden` で拒否します。

---

## 脆弱性の報告方法 (Reporting a Vulnerability)

セキュリティ上の脆弱性を発見された場合は、**公開 Issue には投稿せず**、以下の手順でご報告ください。

1. GitHub リポジトリの **Security Advisories (Report a vulnerability)** 機能、またはメンテナへの直接連絡をご利用ください。
2. 再現手順、影響範囲、可能であれば修正案を添えてご連絡ください。
3. 報告内容を確認後、修正パッチの作成およびリリースを行った上で公開します。
