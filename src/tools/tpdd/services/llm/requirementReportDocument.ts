import { RequirementScope } from '../../domain/requirementScope';
import { RequirementReportResponse, ReportStatement } from './aiSchemas';

const SECTION_TITLES: Record<string, string> = {
  requirement: '起点ノードの説明',
  breakdown: '機能要素への分解',
  concretization: '具体化',
  realization: '分解構造に基づく実現案',
};

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&');
}

function renderStatement(statement: ReportStatement): string {
  const references = [...statement.nodeRefs, ...statement.edgeRefs];
  return `${escapeMarkdown(statement.text)}  \n> 根拠: ${references.map((ref) => `[${ref}]`).join('、')}`;
}

/** Assemble the final report structure and evidence appendix deterministically. */
export function buildRequirementReportMarkdown(
  projectTitle: string,
  scope: RequirementScope,
  report: RequirementReportResponse,
  generatedAt: string,
  generationWarnings: string[] = []
): string {
  const nodesByRef = new Map(scope.nodes.map((node) => [node.ref, node]));
  const kindsByRef = new Map(scope.nodeKinds.map((kind) => [kind.ref, kind]));
  const levelsByRef = new Map(scope.levels.map((level) => [level.ref, level]));
  const diagramsByRef = new Map(scope.diagrams.map((diagram) => [diagram.ref, diagram]));
  const rootNode = nodesByRef.get(scope.rootNodeRef);

  const output = [
    `# ${escapeMarkdown(projectTitle)} — ${escapeMarkdown(rootNode?.label || '設計説明')}`,
    '',
    `- 生成日時: ${escapeMarkdown(generatedAt)}`,
    `- 起点ノード: [${scope.rootNodeRef}] ${escapeMarkdown(rootNode?.label || '')}`,
    `- 対象範囲: ${scope.diagrams.map((diagram) => `${diagram.ref}「${escapeMarkdown(diagram.title)}」`).join('、')}`,
    '',
    '> 実験的なAI生成草稿です。図に記録された設計内容を説明するものであり、設計の妥当性、実装完了、試験結果を保証しません。根拠参照と原図を確認してからご利用ください。',
    '',
    '## 要約',
    '',
    `本書は、選択された起点ノード「${escapeMarkdown(rootNode?.label || '')}」から、明示された分解エッジをたどり、関連ノードに紐づく詳細図の記載内容を整理したものです。対象範囲にはノード${scope.nodes.length}件、分解エッジ${scope.edges.filter((edge) => edge.kind === 'decomposition').length}件、図${scope.diagrams.length}件が含まれます。`,
    '',
  ];

  for (const sectionId of ['requirement', 'breakdown', 'concretization', 'realization'] as const) {
    const section = report.sections.find((item) => item.id === sectionId);
    if (!section?.statements.length) continue;
    output.push(`## ${SECTION_TITLES[sectionId]}`, '');
    for (const statement of section.statements) output.push(renderStatement(statement), '');
  }

  const decompositionEdges = scope.edges.filter((edge) => edge.kind === 'decomposition');
  output.push('## 図に明示された分解経路', '');
  if (decompositionEdges.length === 0) {
    output.push('対象範囲に分解エッジは記録されていません。', '');
  } else {
    for (const edge of decompositionEdges) {
      const source = nodesByRef.get(edge.sourceNodeRef);
      const target = nodesByRef.get(edge.targetNodeRef);
      output.push(
        `- [${edge.ref}] [${edge.sourceNodeRef}] ${escapeMarkdown(source?.label || '')} → [${edge.targetNodeRef}] ${escapeMarkdown(target?.label || '')}${edge.label ? `（${escapeMarkdown(edge.label)}）` : ''}`
      );
    }
    output.push('');
  }

  const detailDiagrams = scope.diagrams.filter((diagram) => diagram.ownerNodeRef);
  if (detailDiagrams.length > 0) {
    output.push('## 起点・展開ノードに紐づく詳細図', '');
    for (const diagram of detailDiagrams) {
      const owner = nodesByRef.get(diagram.ownerNodeRef!);
      output.push(
        `- ${diagram.ownerNodeRef}「${escapeMarkdown(owner?.label || '')}」に紐づく図: ${diagram.ref}「${escapeMarkdown(diagram.title)}」`
      );
    }
    output.push('');
  }

  output.push('## 根拠一覧', '');
  for (const node of scope.nodes) {
    const kind = kindsByRef.get(node.kindRef);
    const level = levelsByRef.get(node.levelRef);
    const diagram = diagramsByRef.get(node.diagramRef);
    const description = node.description ? ` — ${escapeMarkdown(node.description)}` : '';
    const tags = node.tags.length ? `。タグ: ${node.tags.map(escapeMarkdown).join('、')}` : '';
    output.push(
      `- [${node.ref}] ${escapeMarkdown(node.label)}（種別: ${escapeMarkdown(kind?.label || '不明')}、列: ${escapeMarkdown(level?.label || '不明')}、状態: ${escapeMarkdown(node.status)}、図: ${node.diagramRef}「${escapeMarkdown(diagram?.title || '')}」）${description}${tags}`
    );
  }
  for (const edge of scope.edges) {
    const source = nodesByRef.get(edge.sourceNodeRef);
    const target = nodesByRef.get(edge.targetNodeRef);
    const label = edge.label ? `、ラベル: ${escapeMarkdown(edge.label)}` : '';
    output.push(
      `- [${edge.ref}] ${edge.sourceNodeRef}「${escapeMarkdown(source?.label || '')}」→ ${edge.targetNodeRef}「${escapeMarkdown(target?.label || '')}」（関係: ${escapeMarkdown(edge.kind)}${label}、図: ${edge.diagramRef}）`
    );
  }
  if (generationWarnings.length > 0) {
    output.push('', '## 生成時の検証警告', '');
    for (const warning of generationWarnings) output.push(`- ${escapeMarkdown(warning)}`);
  }
  output.push(
    '',
    '## 利用上の注意',
    '',
    'この説明は上記のノード・エッジ・詳細図リンクを根拠に生成されています。根拠参照が示されていても、文章が根拠を正しく解釈していることを自動保証するものではありません。図に記録されていない実装状況・性能・試験結果は、この説明から判断できません。',
    ''
  );

  return output.join('\n');
}
