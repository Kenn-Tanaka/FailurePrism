import { describe, expect, it } from 'vitest';
import { addNodeToDiagram, createNewProject } from '../../../src/tools/tpdd/domain/commands';
import { createHistoryState, pushHistory, undoHistory } from '../../../src/tools/tpdd/domain/history';
import { validateProject } from '../../../src/tools/tpdd/domain/validation';
import {
  extractAndParseAiJson,
  ProposalResponse,
  validateProposalResponse,
  validateReviewResponse,
} from '../../../src/tools/tpdd/services/llm/aiSchemas';
import { adoptProposals } from '../../../src/tools/tpdd/features/ai/proposalAdopter';

describe('AI Output Validation & Adoption Transaction (A01 - A05, S02)', () => {
  it('A01: 単一コードフェンスで囲まれたJSONや純粋JSONを正常にパースできる', () => {
    const rawFenced = `\`\`\`json
{
  "format": "thought-expansion-ai",
  "schemaVersion": 1,
  "task": "expand",
  "summary": "展開案の要約",
  "nodes": [
    {
      "candidateId": "c1",
      "label": "機能1",
      "kind": "function",
      "levelId": "level-function",
      "description": "説明",
      "tags": ["tag"],
      "rationale": "理由",
      "assumptions": [],
      "checks": []
    }
  ],
  "edges": []
}
\`\`\``;

    const parsed = extractAndParseAiJson(rawFenced);
    expect(parsed).toBeTypeOf('object');

    const vResult = validateProposalResponse(parsed, {
      validLevelIds: new Set(['level-function']),
      existingNodeIds: new Set(['node-1']),
    });
    expect(vResult.valid).toBe(true);
  });

  it('A01: 図レビュー応答の検証 (実在ノードID参照の確認)', () => {
    const validReview = {
      format: 'thought-expansion-review',
      schemaVersion: 1,
      task: 'review',
      summary: 'レビュー講評',
      issues: [
        {
          severity: 'warning',
          nodeIds: ['node-1'],
          edgeIds: [],
          category: 'missing',
          message: '安全要件の定義が不足しています',
          recommendation: 'フェイルセーフ機構を追加してください',
        },
      ],
    };

    const result = validateReviewResponse(validReview, {
      validLevelIds: new Set(['level-requirement']),
      existingNodeIds: new Set(['node-1']),
    });
    expect(result.valid).toBe(true);

    // 未知のノードIDを含む場合は拒否
    const invalidReview = {
      ...validReview,
      issues: [{ ...validReview.issues[0], nodeIds: ['ghost-node-999'] }],
    };
    const invalidResult = validateReviewResponse(invalidReview, {
      validLevelIds: new Set(['level-requirement']),
      existingNodeIds: new Set(['node-1']),
    });
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.error).toContain('ghost-node-999');
  });

  it('A01: 存在しないlevelIdや未解決参照を含む不正なAI出力は拒否される', () => {
    const badJson = {
      format: 'thought-expansion-ai',
      schemaVersion: 1,
      task: 'expand',
      summary: 'テスト',
      nodes: [
        {
          candidateId: 'c1',
          label: 'ノード',
          kind: 'function',
          levelId: 'ghost-level', // 存在しない列
          description: '',
          tags: [],
          rationale: '',
          assumptions: [],
          checks: [],
        },
      ],
      edges: [
        {
          sourceRef: 'existing:ghost-node', // 存在しない既存ノード
          targetRef: 'candidate:c1',
          kind: 'decomposition',
          label: '具体化',
        },
      ],
    };

    const vResult = validateProposalResponse(badJson, {
      validLevelIds: new Set(['level-function']),
      existingNodeIds: new Set(['real-node']),
    });

    expect(vResult.valid).toBe(false);
    expect(vResult.error).toContain('ghost-level');
  });

  it('A01: Gemma4-26B等のモデルがプレフィックスを省略（c2 や node-1）した場合も自動正規化して解決できる', () => {
    const jsonFromGemma = {
      format: 'thought-expansion-ai',
      schemaVersion: 1,
      task: 'expand',
      summary: 'Gemmaによる展開案',
      nodes: [
        {
          candidateId: 'c1',
          label: '機能A',
          kind: 'function',
          levelId: 'level-function',
          description: '',
          tags: [],
          rationale: '',
          assumptions: [],
          checks: [],
        },
        {
          candidateId: 'c2',
          label: '機能B',
          kind: 'function',
          levelId: 'level-function',
          description: '',
          tags: [],
          rationale: '',
          assumptions: [],
          checks: [],
        },
      ],
      edges: [
        {
          sourceRef: 'real-node', // "existing:" プレフィックス省略
          targetRef: 'c1',        // "candidate:" プレフィックス省略
          kind: 'decomposition',
          label: '展開1',
        },
        {
          sourceRef: 'candidate: c1', // コロン後空白
          targetRef: 'c2',            // "candidate:" プレフィックス省略 (今回のエラー再現)
          kind: 'dependency',
          label: '連携',
        },
      ],
    };

    const vResult = validateProposalResponse(jsonFromGemma, {
      validLevelIds: new Set(['level-function']),
      existingNodeIds: new Set(['real-node']),
    });

    expect(vResult.valid).toBe(true);
    expect(vResult.data).toBeDefined();
    // 正規化されていること
    expect(vResult.data!.edges[0].sourceRef).toBe('existing:real-node');
    expect(vResult.data!.edges[0].targetRef).toBe('candidate:c1');
    expect(vResult.data!.edges[1].sourceRef).toBe('candidate:c1');
    expect(vResult.data!.edges[1].targetRef).toBe('candidate:c2');
  });

  it('A02: 選択候補だけを追加し、未選択候補に繋がるエッジは自動除外される', () => {
    const project = createNewProject('採用テスト');
    const rootId = project.rootDiagramId;
    const { project: p1, newNode: existingNode } = addNodeToDiagram(project, rootId, {
      label: '既存ノード',
      levelId: 'level-requirement',
      x: 50,
      y: 50,
    });

    const proposal: ProposalResponse = {
      format: 'thought-expansion-ai',
      schemaVersion: 1,
      task: 'expand',
      summary: '2つの候補案',
      nodes: [
        {
          candidateId: 'c1',
          label: '候補1 (採用)',
          kind: 'function',
          levelId: 'level-function',
          description: '説明1',
          tags: [],
          rationale: '',
          assumptions: [],
          checks: [],
        },
        {
          candidateId: 'c2',
          label: '候補2 (不採用)',
          kind: 'function',
          levelId: 'level-function',
          description: '説明2',
          tags: [],
          rationale: '',
          assumptions: [],
          checks: [],
        },
      ],
      edges: [
        {
          sourceRef: `existing:${existingNode.id}`,
          targetRef: 'candidate:c1',
          kind: 'decomposition',
          label: '具体化1',
        },
        {
          sourceRef: `existing:${existingNode.id}`,
          targetRef: 'candidate:c2',
          kind: 'decomposition',
          label: '具体化2',
        },
        {
          sourceRef: 'candidate:c1',
          targetRef: 'candidate:c2',
          kind: 'dependency',
          label: '候補間エッジ',
        },
      ],
    };

    // ユーザーは c1 のみを選択
    const result = adoptProposals(
      p1,
      rootId,
      proposal,
      { selectedCandidateIds: new Set(['c1']) },
      { modelId: 'lmstudio/default' }
    );

    // c1 のみ追加され、c2 は追加されない
    expect(result.addedNodeCount).toBe(1);
    expect(result.addedEdgeCount).toBe(1); // existing -> c1 の1本のみ
    expect(result.omittedEdgeCount).toBe(2); // c2 絡みの2本は自動除外

    const diag = result.project.diagrams[0];
    expect(diag.nodes).toHaveLength(2); // 既存 + c1
    expect(diag.edges).toHaveLength(1);

    // 追加されたノードが candidate 状態かつ provenance を持つこと
    const adoptedNode = diag.nodes.find((n) => n.label === '候補1 (採用)')!;
    expect(adoptedNode.status).toBe('candidate');
    expect(adoptedNode.provenance.origin).toBe('llm');
    expect(adoptedNode.provenance.modelId).toBe('lmstudio/default');

    // 整合性チェック
    expect(validateProject(result.project).valid).toBe(true);
  });

  it('A03: 候補の一括採用を1回のUndoで完全に取り消せる', () => {
    const project = createNewProject('Undoテスト');
    const rootId = project.rootDiagramId;
    let history = createHistoryState(project);

    const proposal: ProposalResponse = {
      format: 'thought-expansion-ai',
      schemaVersion: 1,
      task: 'expand',
      summary: 'テスト',
      nodes: [
        {
          candidateId: 'c1',
          label: '候補A',
          kind: 'function',
          levelId: 'level-function',
          description: '説明A',
          tags: [],
          rationale: '',
          assumptions: [],
          checks: [],
        },
      ],
      edges: [],
    };

    const { project: adoptedProj } = adoptProposals(
      history.present,
      rootId,
      proposal,
      { selectedCandidateIds: new Set(['c1']) },
      { modelId: 'test/m' }
    );

    history = pushHistory(history, adoptedProj);
    expect(history.present.diagrams[0].nodes).toHaveLength(1);

    // 1回のUndoでノード追加前へ戻る
    history = undoHistory(history);
    expect(history.present.diagrams[0].nodes).toHaveLength(0);
    expect(validateProject(history.present).valid).toBe(true);
  });

  it('S02: AI出力に悪意あるスクリプトやHTMLが含まれていても安全にプレーンテキストとして扱われる', () => {
    const xssPayload = {
      format: 'thought-expansion-ai',
      schemaVersion: 1,
      task: 'expand',
      summary: '<script>alert("xss")</script>',
      nodes: [
        {
          candidateId: 'c1',
          label: '<img src=x onerror=alert(1)>',
          kind: 'function',
          levelId: 'level-function',
          description: '<svg onload=alert(2)>',
          tags: ['<script>'],
          rationale: '理由',
          assumptions: [],
          checks: [],
        },
      ],
      edges: [],
    };

    const project = createNewProject('XSSテスト');
    const { project: safeProj } = adoptProposals(
      project,
      project.rootDiagramId,
      xssPayload as unknown as ProposalResponse,
      { selectedCandidateIds: new Set(['c1']) },
      { modelId: 'test/xss' }
    );

    const node = safeProj.diagrams[0].nodes[0];
    // 文字列として安全に保持されていること (evalやDOMへの直接挿入は行われない)
    expect(node.label).toBe('<img src=x onerror=alert(1)>');
    expect(node.meta.description).toContain('<svg onload=alert(2)>');
    expect(validateProject(safeProj).valid).toBe(true);
  });

  it('A05: APPLY_PROJECT_UPDATE によりAI採用が1件のUndo履歴として記録され、サブ図滞在も維持される', () => {
    const project = createNewProject('サブ図Undoテスト');

    // サブ図を作成してプロジェクトに追加
    const subDiagramId = 'sub-diagram-1';
    const projectWithSub = {
      ...project,
      diagrams: [
        ...project.diagrams,
        {
          id: subDiagramId,
          title: 'サブ図1',
          nodes: [],
          edges: [],
        },
      ],
    };

    let history = createHistoryState(projectWithSub);

    // サブ図に対して提案を採用
    const proposal: ProposalResponse = {
      format: 'thought-expansion-ai',
      schemaVersion: 1,
      task: 'expand',
      summary: 'サブ図の展開案',
      nodes: [
        {
          candidateId: 'c1',
          label: 'サブ図ノード1',
          kind: 'function',
          levelId: 'level-function',
          description: '説明',
          tags: [],
          rationale: '',
          assumptions: [],
          checks: [],
        },
      ],
      edges: [],
    };

    const { project: nextProj } = adoptProposals(
      history.present,
      subDiagramId,
      proposal,
      { selectedCandidateIds: new Set(['c1']) },
      { modelId: 'test/model' }
    );

    // APPLY_PROJECT_UPDATE のシミュレーション
    // 1. pushHistory で履歴に1ステップ記録される
    history = pushHistory(history, nextProj);
    expect(history.past).toHaveLength(1);
    expect(history.revision).toBe(2);

    // 2. 更新後のプロジェクトでサブ図が正しく保持されている
    const activeDiag = history.present.diagrams.find((d) => d.id === subDiagramId);
    expect(activeDiag).toBeDefined();
    expect(activeDiag?.nodes).toHaveLength(1);

    // 3. 1回のUndoで採用前のサブ図状態に完全復帰できる
    history = undoHistory(history);
    expect(history.present.diagrams.find((d) => d.id === subDiagramId)?.nodes).toHaveLength(0);
    expect(history.past).toHaveLength(0);
  });
});
