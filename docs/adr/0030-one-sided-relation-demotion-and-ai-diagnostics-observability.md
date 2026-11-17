# ADR-0030: 片側主体未指定関係の安全な格下げ・自己治癒とAI診断パッケージの観測性強化

- **ステータス**: Accepted
- **決定日**: 2026-11-09
- **対象コンポーネント**: VTA Engine (`eventLedger.ts`, `relationContract.ts`, `aiDiagnostics.ts`), Prompts (`prompts.json`, `eventPrompts.ts`, `prompts.ts`)
- **関連ドキュメント・コミット**: [ADR-0004](file:///docs/adr/0004-normalization-audit-and-human-traceability.md), [ADR-0009](file:///docs/adr/0009-structured-ai-diagnostics-and-log-cost-optimization.md), [ADR-0020](file:///docs/adr/0020-vta-relation-deduplication-and-revert-preservation.md), [ADR-0023](file:///docs/adr/0023-ledger-prompt-disambiguation-and-preliminary-downgrade.md), [ADR-0024](file:///docs/adr/0024-ledger-parser-resilience-and-parse-error-diagnostics.md), [ADR-0025](file:///docs/adr/0025-ai-diagnostics-trace-hygiene-and-full-pipeline-observability.md), [ADR-0027](file:///docs/adr/0027-relation-id-disambiguation-and-stream-progress-observability.md)

## 1. コンテキストと課題 (Context & Problem Statement)

東武鉄道日光線新鹿沼駅触車事故シナリオ（約7,000文字）の実機検証において、E20（列車触車事故・作業員4名死亡・運転士関与）からE22（非常停止手配）への影響関係R21（`R21 impact E20 - E22 OP_1020`）に対し、以下の台帳修復エラーが発生した：

```
[台帳修復] 関係/R21: [impact] 元主体: 受信=-、許容=イベントに割当済みの主体ID [relation_attribute / impact / 元主体 / 受信=- / 許容=イベントに割当済みの主体ID] 対象行だけを再取得します（1/2、修復指示 1593文字）。
```

この結果、LLM再取得処理（台帳修復）により、R21は以下のように[整理]reviewへと退避された：
```
R21 review p60,p65 触車による異音感知から非常停止手配への影響関係 E20の触車に関与した複数作業員および運転士の中から元主体を原文から特定できないため
```
これにより、抽出されていた最重要の事故波及関係（触車発生から停止手配への接続）がVTAツリーのキャンバスから完全に脱落した。

### 根本原因の分析
1. **多人数関与事象における主体特定困難**:
   触車、衝突、多人数被災、火災・爆発などの重大事象では、1つのイベントに多数の主体（作業員複数名、現場代理人、運転士など）が関与する。LLMは特定個人を元主体と断定することを避け、元主体列を半角ハイフン`-`で出力した。
2. **関係属性契約の硬直性**:
   `relation-attributes-2`契約では、`transfer/impact/mutual/common`において両端主体の割当が厳格に必須と定義されているため、片側が`-`であるだけで`RelationContractError`を発出し、台帳修復（LLM追加呼び出し）を強制していた。
3. **AI診断パッケージ（v1.0）の観測性不足**:
   - `findLatestAnalysis`が最終ステップのスナップショットから`analysis`を取得する際、`graph.projection`に`outcome`が保持されていないためセクション1の帰結メタデータが欠落していた。
   - `extractParagraphs`の段落分割ロジックが`sourceFromText`と乖離しており、`p60,p65`のような複数段落引用で原文抜粋が正しく抽出されなかった。
   - 台帳修復によって関係が`[関係]`から`[整理]`へ変異した際、同一ステップ内で上書きされ変異の系譜（`MUTATED`）が可視化されていなかった。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **事実性担保と推測の排除**: 事実性方針（ADR-0004）に基づき、LLMやパーサーが勝手に元主体を推測・捏造して単一主体に断定することは厳禁。
- **重要因果の完全性**: 複数主体関与事象からの波及関係を、片側主体未特定という形式的理由だけで完全脱落（[整理]退避）させず、ツリー上に保持すること。
- **悪質構文エラーの防波堤維持**: 両端ともに`-`であるような未定義関係（例: `R6 mutual E1 - E2 -`）は従来どおり無効として弾き、パイプラインの品質を担保すること。
- **自己治癒と通信コスト削減**: 決定的アルゴリズムで救済可能な軽微な不整合については、LLM修復呼び出し（トークン消費・待ち時間増）を行わずにパイプライン内で自己治癒すること。
- **高精度な診断トレーサビリティ**: AI診断パッケージ（v1.0）において、正確な原文段落抜粋とエンティティの変異系譜を確実に追跡できること。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: プロンプト指示の強化のみ（元主体を必ず1名選ばせる）**
  - 課題: 複数作業員が被災した事故において、特定の1名を無理に元主体に選ばせることは、事実の偏向や過失認定の偏りを生み、事実性ポリシーに抵触する。
- **選択肢2: `impact`等の関係で片側`-`を無条件に許容する**
  - 課題: スイムレーン上でのエッジ描画において始点レーンが定まらず、幾何配置やルーティングエンジンがクラッシュまたは不正な座標を参照する危険がある。
- **選択肢3: 決定論的自己治癒（単一主体自動補完＋複数主体時は`before`へ安全格下げ）およびAI診断刷新（採用）**
  - メリット: レーン配置が確定できる場合は補完し、不確定な場合は時系列先行関係`before`（主体不要）に格下げすることで、エッジ描画を破綻させずに事象間の接続線を確実に残せる。

## 4. 決定事項 (Decision Outcome)

### 4.1. 片側主体未指定関係の決定論的自己治癒（`eventLedger.ts`）

`[関係]`セクションの検証において、片側のみ主体が未指定（`-`）となっている関係に対し、以下の2段階自己治癒アルゴリズムを導入した：

```typescript
// 片側のみ主体未指定（Boolean(sourceEntityId) !== Boolean(targetEntityId)）の場合
if (Boolean(sourceEntityId) !== Boolean(targetEntityId)) {
  // Case A: 対象イベントに割り当てられた主体が1つだけの場合、自動補完
  const missingEndpoint = !sourceEntityId ? 'source' : 'target';
  const targetEventId = missingEndpoint === 'source' ? sourceEventId : targetEventId;
  const assignedEntities = Array.from(entityRolesByEvent.get(targetEventId)?.keys() || []);

  if (assignedEntities.length === 1) {
    if (missingEndpoint === 'source') sourceEntityId = assignedEntities[0];
    else targetEntityId = assignedEntities[0];
    warnings.push(`関係 ${id}: ${missingEndpoint === 'source' ? '元' : '先'}主体が未指定のため、イベント ${targetEventId} に割当済みの主体 ${assignedEntities[0]} を自動補完しました。`);
  } else {
    // Case B: 複数主体または未特定の場合、時系列先行 before に安全格下げ
    if (kind === 'impact' || kind === 'dependency' || kind === 'transfer') {
      const originalKind = kind;
      kind = 'before';
      sourceEntityId = undefined;
      targetEntityId = undefined;
      resource = undefined;
      execution = undefined;
      receipt = 'na';
      warnings.push(`関係 ${id}: [${originalKind}] の${missingEndpoint === 'source' ? '元' : '先'}主体が特定できないため（対象イベントに複数主体または未特定）、安全のため前後関係(before)に格下げしました。`);
    }
  }
}
```

- **両側未指定の防止**: `Boolean(sourceEntityId) !== Boolean(targetEntityId)` を厳格に判定し、両端ともに`-`である行（例: `mutual E1 - E2 -`）は従来どおり `RelationContractError` として扱い、構文崩れの混入を防止する。

### 4.2. プロンプト契約の明文化（`relationContract.ts`, `prompts.json`）

`RELATION_CONTRACT_PROMPT`（および同期対象の `public/prompts.json`）に以下の文言を追記し、LLMが初手から安全な表現を選択できるよう誘導：

> 「複数主体が関与するイベントからの波及など片側の主体を1つに特定できない場合は、impact等に - を書かず、両端主体を - とした before（時間順）として記録すること。」

### 4.3. AI診断パッケージの観測性・系譜トレーサビリティ刷新（`aiDiagnostics.ts`）

1. **帰結メタデータの保持（`findLatestAnalysis`）**:
   最新の`graph.projection`から得られる`subjectPoset`/`entities`と、`ledger.validation`から得られる最新の`analysis`（`outcome`を含む）をマージして返すよう改善。セクション1の帰結情報が空落ちする問題を解消。
2. **段落分割アルゴリズムの厳密同期（`extractParagraphs` / `extractEvidenceParagraph`）**:
   `sourceFromText`と完全に一致する段落IDマッピングを採用し、`p60,p65`のようなカンマ区切りの複数段落引用に対しても、各段落のテキストを確実に抽出・連結して`evidence_paragraph`へ格納。
3. **変異ライフサイクルの追跡（`traceEntityLineage`）**:
   台帳修復によってエンティティが再取得された場合、同一ステップ名であってもライフサイクル状態を`MUTATED`として記録し、所属セクションの変遷（例: `[関係]` $\to$ `[整理]`）を注記に明記。

## 5. 結果と影響 (Consequences)

### メリット
- **脱落防止**: 複数主体が関与する重大事故イベント（衝突・触車など）からの波及関係が、LLMの主体片側未指定によって[整理]へ退避・消失する問題が解消され、VTAツリーの接続線として確実に保持される。
- **無駄なAPI呼び出し削減**: 軽微な片側未指定に対して1,500文字を超える修復プロンプトの送受信が発生しなくなり、実行時間とAPIコストが削減される。
- **デバッグ観測性向上**: AI診断パッケージで引用原文が正確に表示され、台帳修復によるエンティティ変異履歴が明確に把握可能となった。

### トレードオフ・考慮事項
- `impact`から`before`に格下げされた関係は、リソース区分や実施状態の属性（`occurred`等）が失われる（`receipt: 'na'`）。ただし、時系列の有向エッジとしてはツリー上に描画されるため、因果経路の可読性は維持される。

### 影響を受けるファイル・テスト
- `src/tools/vta/features/vta/utils/eventLedger.ts`
- `src/tools/vta/features/vta/utils/relationContract.ts`
- `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
- `public/prompts.json`
- `src/tools/vta/features/vta/utils/ledgerValidation.test.ts`
- `src/tools/vta/services/llm/prompts.test.ts`
- `tests/vta/aiDiagnostics.test.ts`
