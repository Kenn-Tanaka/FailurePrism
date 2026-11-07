# ADR-0002: 受動客体における帰結ノード（Outcome）の通常カード表示維持

- **ステータス**: Accepted
- **決定日**: 2026-11-04
- **対象コンポーネント**: VTA Geometry / Node Projection / SVG Export
- **関連ADR**: ADR-0003 (作用主体と受動客体のノード分離)

---

## 1. コンテキストと課題 (Context & Problem Statement)

ADR-0003において、受動客体（`entity_role === 'object'`）ノードを円形ドット（`vtaObjectJunction`, 24×24px）に縮約投影する機能を導入した。これにより共有イベントにおけるレーン間の横方向・縦方向の視覚的混雑が大幅に緩和された。

しかし、事故・インシデントの終局を示す**帰結ノード（`type === 'outcome'`、損失・損傷・停止・回復）**が受動客体側レーンに存在する場合（例: 航空機衝突事故において、滑走路上で待機していた側や衝突された側の機体レーンに帰結が記録された場合）、デフォルトの客体ドット化ルールがそのまま適用されると、最重要ノードである帰結ノードが小さなドットになってしまい、タイトルや損失情報が隠没してしまうリスクがあった。

ツリー上で事故の帰結が見えなくなると、「片側のレーンだけに帰結が起きた」あるいは「終局がどこにあるか分からない」という重大な誤認が生じるため、安全分析の図面として致命的な問題となる。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

1. **安全分析における帰結ノードの絶対的重要度**:
   帰結ノードはVTAツリー全体のゴールであり、損失の規模や態様を示す最重要カードであるため、視認性を最優先しなければならない。
2. **客体ドット化ルールとの調和**:
   通常の作業ノード（`normal` / `variation`）は客体としてコンパクト化する利点を生かしつつ、帰結ノードのみを的確に保護すること。
3. **ユーザーの明示的操作の尊重**:
   もしアナリストが意図して特定の帰結ノードをドット化したい場合には、個別設定（`object_display_style === 'dot'`）によってオーバーライド可能であること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: 帰結ノードは客体に分類せず、強制的に能動主体（`subject`）へ変換する**
  - デメリット: イベント台帳上の実際の参加役割（`target` や `affected`）と矛盾し、データ整合性が崩れる（不採用）。
- **選択肢2: 幾何投影ロジックで帰結ノードの自動ドット化を抑止する（採用）**
  - `shouldDisplayAsObjectJunction` の判定ロジックにおいて、`data.type === 'outcome'` かつ明示的な `object_display_style === 'dot'` がない限り、デフォルトで `false`（通常カード表示）を返すガードを追加する。

---

## 4. 決定事項 (Decision Outcome)

[`src/tools/vta/features/vta/utils/nodeGeometry.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/nodeGeometry.ts) の `shouldDisplayAsObjectJunction` に以下の保護ルールを実装した：

```typescript
export function shouldDisplayAsObjectJunction(
  data?: {
    entity_role?: 'subject' | 'object';
    object_display_style?: 'dot' | 'card';
    type?: VTANodeType;
  },
  defaultObjectDisplayStyle?: 'dot' | 'card'
): boolean {
  if (!data || data.entity_role !== 'object') return false;
  
  // 1. ユーザーの明示的な個別指定（カード or ドット）を最優先
  if (data.object_display_style === 'card') return false;
  if (data.object_display_style === 'dot') return true;

  // 2. 帰結ノード（outcome）は事故の終局を示す最重要ノードであるため、
  //    ユーザーの明示的なドット指定がない限り、受動客体であっても通常カード表示を維持
  if (data.type === 'outcome') return false;

  // 3. グローバル設定に従う
  return defaultObjectDisplayStyle !== 'card';
}
```

この変更により、キャンバス上のノード投影（`projectDisplayNode`）、ノード幾何計算（`getDisplayRect`）、およびSVGエクスポート（`generateVTASVG`）のすべてにおいて、一貫して帰結ノードの通常カード表示（深紅・琥珀色の太枠および帰結バッジ）が維持される。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 被害を受けた側の客体レーンであっても、衝突・炎上・全損・緊急停止等の重大な終局がフルサイズのカードとして目立つ形で表示され、事故シナリオの全体像が一目で理解できるようになった。
  - データモデル上の役割（`entity_role: 'object'`）を歪めることなく、プレゼンテーション層の保護のみで安全に課題を解決した。
- **影響ファイル**:
  - `src/tools/vta/features/vta/utils/nodeGeometry.ts`
  - `tests/vta/subjectObjectNode.test.tsx`
