# ADR-0026: クロスレーン矢印始点およびレーン最上端ノードの通常カード表示維持ポリシー

## Status
Accepted

## Date
2026-11-09

## Target Components
- `src/tools/vta/types/vta.ts` (`VTANodeData`, `VTAReactFlowNodeData`)
- `src/tools/vta/features/vta/utils/nodeGeometry.ts` (`shouldDisplayAsObjectJunction`)
- `src/tools/vta/features/vta/utils/nodeTopologyRules.ts` (`annotateNodeTopologyRules`)
- `src/tools/vta/features/vta/utils/layout.ts` (`calculateVTALayout`)
- `src/tools/vta/features/vta/utils/eventAnalysis.ts` (`projectAnalysis`)
- `src/tools/vta/features/vta/utils/animationSequencer.ts`
- `tests/vta/subjectObjectNode.test.tsx`

## Related Requirements / ADRs
- [ADR-0002: 受動客体における帰結ノード（Outcome）の通常カード表示維持](file:///docs/adr/0002-outcome-node-card-preservation-for-passive-objects.md)
- [ADR-0003: 作用主体（能動）と受動客体のノード分離およびジャンクション投影](file:///docs/adr/0003-subject-object-node-differentiation-and-junction-projection.md)
- [ADR-0014: ドット表示ノード（客体・接続点）への配線幾何と手前屈曲の解消ポリシー](file:///docs/adr/0014-junction-edge-routing-and-smooth-arrival.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

ADR-0003 では、レーン間の視覚的混雑を解消するため、受動客体（`entity_role === 'object'`）ノードを24pxの円形インジケーター（`vtaObjectJunction`）として縮約投影する仕様を導入した。また、ADR-0002 では最重要ノードである帰結ノード（`type === 'outcome'`）について通常カード表示を維持する保護ルールを定めた。

しかし、羽田空港衝突事故等の大規模インシデントシナリオにおいて、以下の2つの視覚的・認知的問題が発生した：

1. **他レーンへの伝達・影響線の「始点」がドット化することによる因果の隠没**:
   - ある主体が他組織・他レーンへ向けて人員の引継ぎや情報伝達、作業依存などの矢印を発信している際、そのイベントにおける当該主体の台帳上の役割が受動客体（`target` や `affected` 等）であると、発信元のノードが小さなドットになってしまう。
   - その結果、24pxの小さなドットからラベル付きの矢印（例: `人員 (管理/監督)`）が唐突に伸びる形となり、「何が原因・契機となってその伝達や影響が発生したのか」がカードとして読めず、因果の起点が不可解に見える問題が生じた。
2. **各レーン（アクター）のタイムライン終局ノードがドット化することによる結末の喪失**:
   - VTA図は下から上へと時系列が進行するため、各レーンの最上部（時系列で最後）のノードは、その主体（人物や組織）の最終的な安否や到達ステータス（例: 「救助完了」「病院搬送」など）を表す。
   - ADR-0002 は重大損失（`outcome`）のみを保護していたため、損失フラグの付かない救援・保護・待機等の終局イベントが受動客体である場合、レーンの頂点が小さなドットで途切れてしまい、そのアクターが最終的にどうなったのかが直感的に把握できなくなっていた。
3. **両端がドットのレーン間接続線の出現**:
   - 上記2点が同時に重なると、「ドットからドットへ矢印が結ばれる」という極めて不自然な接続が出現し、両端の事象内容がどちらも隠没してしまう事態となっていた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

1. **因果関係の発信元（起点）の可読性保証**:
   - 他レーンへ影響やリソースを及ぼすイベントは、その相互作用において能動的な原因ノードとして機能しているため、常にカードとして内容が読めなければならない。
2. **各主体のタイムライン終局（レーンサマリー）の可読性保証**:
   - すべてのスイムレーンは、最後の状態を示すカードによって明確に締めくくられるべきである。
3. **客体ドット縮約（ADR-0003）の利点の維持**:
   - 同一レーン内の縦方向時系列線まで含めてしまうと全ノードがカード化されてドット化機能が失われるため、「他レーンへ向かう矢印（クロスレーン矢印）」のみを的確に判定すること。
4. **ユーザー明示的操作の最優先（透過性）**:
   - ユーザーが個別ノードに対して明示的に「👁 図上では接続点として表示」（`object_display_style === 'dot'`）を指定した場合は、ユーザーの意思を最優先してドット化できること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢 A: 台帳レベルで役割（`role`）を強制的に `actor`（能動主体）へ書き換える**:
  - *問題点*: 「発見・保護された」「命令を受諾した」という原文の物理的事実（受動）が歪められ、事実性原則（Factuality）に反する。
- **選択肢 B: 幾何投影およびトポロジー判定層で2つの保護ルールを追加する (採用)**:
  - 台帳の客体役割（`entity_role: 'object'`）をそのまま保持しつつ、表示層の `shouldDisplayAsObjectJunction` において、以下の2条件を満たすノードを通常カード表示として維持する。
    - **ルール①（矢印始点保護）**: 他レーンへの接続線（クロスレーン矢印）の始点となっているノード（`is_cross_lane_source: true`）
    - **ルール②（レーン終端保護）**: 各レーン内で最も上（時系列で最後）のノード（`is_lane_terminal: true`）

---

## 4. 決定事項 (Decision Outcome)

選択肢 B を採用し、以下の設計を実装した。

### 1. データモデルの拡張 (`types/vta.ts`)
`VTANodeData` および `VTAReactFlowNodeData` にトポロジー認識フラグを追加：
```typescript
export interface VTANodeData {
  // ...
  is_cross_lane_source?: boolean; // 他レーンへの接続線（矢印）の始点となっているか
  is_lane_terminal?: boolean;     // レーン内で最上部（時系列で最後）の終端ノードか
}
```

### 2. トポロジー解析モジュールの新設 (`nodeTopologyRules.ts`)
- `annotateNodeTopologyRules(schema, rankMap?)`:
  - **クロスレーン矢印始点判定**:
    - `edge.source !== edge.target` かつ `srcNode.lane !== tgtNode.lane`（レーン間接続線）。
    - `direction !== 'undirected'` の場合、`edge.source` を矢印始点（`is_cross_lane_source: true`）と判定。
    - `direction === 'bidirectional'` の場合、両端（`source`, `target`）とも矢印始点と判定。
  - **レーン最上端ノード判定**:
    - 各レーン内で時間ランク（`rankMap`）が最大、かつ同ランク内はシーケンス順・出現順が最も遅いノードを特定し、`is_lane_terminal: true` を付与。

### 3. 表示判定ロジックの改訂 (`nodeGeometry.ts`)
```typescript
export function shouldDisplayAsObjectJunction(
  data?: {
    entity_role?: 'subject' | 'object';
    object_display_style?: 'dot' | 'card';
    type?: VTANodeType;
    is_cross_lane_source?: boolean;
    is_lane_terminal?: boolean;
  },
  defaultObjectDisplayStyle?: 'dot' | 'card'
): boolean {
  if (!data || data.entity_role !== 'object') return false;
  // 1. ユーザーの明示的な個別指定（カード or ドット）を最優先
  if (data.object_display_style === 'card') return false;
  if (data.object_display_style === 'dot') return true;

  // 2. 帰結ノード（ADR-0002）は通常カード維持
  if (data.type === 'outcome') return false;

  // 3. 他レーンへの矢印（クロスレーン接続線）の始点となっているノードはカード表示を維持 (新ルール①)
  if (data.is_cross_lane_source) return false;

  // 4. 各レーンで最も上（時系列で最後）のノードはカード表示を維持 (新ルール②)
  if (data.is_lane_terminal) return false;

  return defaultObjectDisplayStyle !== 'card';
}
```

### 4. レイアウト・投影・アニメーション層への完全統合
- `calculateVTALayout`（`layout.ts`）において、ランク計算直後に `annotateNodeTopologyRules` を適用し、動的高さ計算（`heightOf`）および `rawNodes` のデータ属性へ反映。
- `projectAnalysis`（`eventAnalysis.ts`）および `animationSequencer.ts` においても同等の表示判定を適用。

---

## 5. 結果と影響 (Consequences)

### メリット
- **因果の透明性向上**: 他レーンへリソースや影響を及ぼしている発信元がカードとして明確になり、矢印の根拠がひと目で理解可能となった。
- **レーン結末の明示化**: すべてのスイムレーンが最後の状態を示すカードで完結し、アクターごとの終局状態が把握しやすくなった。
- **不自然なドット間接続の解消**: ユーザーから報告された「両端がドットのレーン間接続線」が自動的に解消され、双方の内容がカードとして明示されるようになった。
- **事実性と柔軟性の両立**: データモデルを破壊せず、ユーザーの明示的指定（個別ドット化）も阻害しない。

### 影響ファイル
- `src/tools/vta/types/vta.ts`
- `src/tools/vta/features/vta/utils/nodeGeometry.ts`
- `src/tools/vta/features/vta/utils/nodeTopologyRules.ts` (新規)
- `src/tools/vta/features/vta/utils/layout.ts`
- `src/tools/vta/features/vta/utils/eventAnalysis.ts`
- `src/tools/vta/features/vta/utils/animationSequencer.ts`
- `tests/vta/subjectObjectNode.test.tsx`
- `docs/adr/0026-card-preservation-for-cross-lane-sources-and-lane-terminals.md`
- `docs/adr/README.md`
