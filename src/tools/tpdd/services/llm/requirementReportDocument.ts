import { RequirementScope } from '../../domain/requirementScope';
import { RequirementReportResponse, ReportSectionId, ReportStatement } from './aiSchemas';
import { REPORT_FORMAT_LABELS, ReportDocumentFormat } from './prompts';

export interface RequirementReportMarkdownOptions {
  format?: ReportDocumentFormat;
  styleInstruction?: string;
  includeAiPromptHeader?: boolean;
}

const SECTION_TITLES_BY_FORMAT: Record<ReportDocumentFormat, Record<ReportSectionId, string>> = {
  proposal: {
    requirement: '1. 背景・目的と解決すべき要求（課題定義）',
    breakdown: '2. 提案する全体構想と構成要素の展開',
    concretization: '3. サブシステム・詳細設計の具体化',
    realization: '4. 実現方式・アーキテクチャ構成案',
  },
  presentation: {
    requirement: '1. 背景・目的・対象要求（導入スライド構成）',
    breakdown: '2. 全体アプローチ・機能展開（本論スライド構成）',
    concretization: '3. 詳細設計・具体化ポイント（詳細スライド構成）',
    realization: '4. 実現構成・アーキテクチャまとめ（実現性スライド構成）',
  },
  design_overview: {
    requirement: '1. 要求定義・上位目標',
    breakdown: '2. 機能・要素分解構造',
    concretization: '3. 詳細図による具体化設計',
    realization: '4. 実現構造・アーキテクチャ定義',
  },
  custom: {
    requirement: '1. 全体要求・目的',
    breakdown: '2. 構成要素への分解・展開',
    concretization: '3. 具体化・詳細設計',
    realization: '4. 分解構造に基づく実現案',
  },
};

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&');
}

function renderStatement(statement: ReportStatement): string {
  const references = [...statement.nodeRefs, ...statement.edgeRefs];
  return `${escapeMarkdown(statement.text)}  \n> 根拠: ${references.map((ref) => `[${ref}]`).join('、')}`;
}

function buildExternalAiInstructionBlock(
  projectTitle: string,
  format: ReportDocumentFormat,
  styleInstruction?: string
): string[] {
  const targetTask =
    format === 'presentation'
      ? 'プレゼンテーション資料（スライド構成案・各スライドのタイトルと箇条書き原稿・発表スピーカーノート）'
      : format === 'design_overview'
        ? 'システム・プログラム設計概要書（要求仕様・アーキテクチャ構成・モジュール分解定義）'
        : format === 'custom' && styleInstruction?.trim()
          ? `指定された文書形式（${styleInstruction.trim()}）のドキュメント`
          : '企画提案書（背景と目的、解決アプローチ、全体構想、具体化設計、実現方式・体制案）';

  const lines = [
    '<!-- Gemini / ChatGPT 連携用プロンプト（このままAIチャットへ貼り付けてご利用いただけます） -->',
    '## AIアシスタント（Gemini / ChatGPT）への作成指示',
    '',
    `以下の内容は、TPDD-Editor（思考展開・設計エディタ）で設計した「${escapeMarkdown(projectTitle)}」の全体設計ドキュメントおよび構造化データです。`,
    `この設計情報をもとに、**${escapeMarkdown(targetTask)}**を作成してください。`,
  ];

  if (styleInstruction?.trim()) {
    lines.push(`- 追加の文書形式・文体・読者指定: ${escapeMarkdown(styleInstruction.trim())}`);
  }
  lines.push(
    '- 記載されているノード（要求・機能・実現手段等）、抽象度レベル、分解関係（decomposition）、詳細図の具体化内容、および採用状態（adopted / candidate / draft）に忠実に構成してください。',
    '- 図に存在しない数値や実装完了実績を断定せず、候補（candidate）の要素は検討案・オプションとして明記してください。',
    '',
    '---',
    ''
  );
  return lines;
}

/** Assemble the final report structure and evidence appendix deterministically. */
export function buildRequirementReportMarkdown(
  projectTitle: string,
  scope: RequirementScope,
  report: RequirementReportResponse,
  generatedAt: string,
  generationWarnings: string[] = [],
  options: RequirementReportMarkdownOptions = {}
): string {
  const format: ReportDocumentFormat = options.format || 'proposal';
  const includeAiPromptHeader = options.includeAiPromptHeader ?? false;
  const styleInstruction = options.styleInstruction?.trim() || '';
  const sectionTitles = SECTION_TITLES_BY_FORMAT[format];

  const nodesByRef = new Map(scope.nodes.map((node) => [node.ref, node]));
  const kindsByRef = new Map(scope.nodeKinds.map((kind) => [kind.ref, kind]));
  const levelsByRef = new Map(scope.levels.map((level) => [level.ref, level]));
  const diagramsByRef = new Map(scope.diagrams.map((diagram) => [diagram.ref, diagram]));

  const rootNodeRefs =
    scope.rootNodeRefs && scope.rootNodeRefs.length > 0
      ? scope.rootNodeRefs
      : scope.rootNodeRef
        ? [scope.rootNodeRef]
        : [];
  const rootNodes = rootNodeRefs
    .map((ref) => nodesByRef.get(ref))
    .filter((node): node is NonNullable<typeof node> => Boolean(node));

  const adoptedCount = scope.nodes.filter((n) => n.status === 'adopted').length;
  const candidateCount = scope.nodes.filter((n) => n.status === 'candidate').length;
  const draftCount = scope.nodes.filter((n) => n.status === 'draft').length;
  const decompositionEdges = scope.edges.filter((edge) => edge.kind === 'decomposition');
  const otherEdges = scope.edges.filter((edge) => edge.kind !== 'decomposition');

  const output: string[] = [];

  if (includeAiPromptHeader) {
    output.push(...buildExternalAiInstructionBlock(projectTitle, format, styleInstruction));
  }

  output.push(
    `# ${escapeMarkdown(projectTitle)} — ${escapeMarkdown(REPORT_FORMAT_LABELS[format])}`,
    '',
    `- 生成日時: ${escapeMarkdown(generatedAt)}`,
    `- 文書形式: ${escapeMarkdown(REPORT_FORMAT_LABELS[format])}`,
    ...(styleInstruction ? [`- 文書・文体指定: ${escapeMarkdown(styleInstruction)}`] : []),
    `- 最上位要素（起点）: ${
      rootNodes.length > 0
        ? rootNodes.map((n) => `[${n.ref}] ${escapeMarkdown(n.label)}`).join('、')
        : 'なし'
    }`,
    `- 対象範囲: ${scope.diagrams.map((diagram) => `${diagram.ref}「${escapeMarkdown(diagram.title)}」`).join('、')}`,
    '',
    '> TPDD-Editorの設計データに基づくAI生成ドキュメントです。図に記録された思考展開・設計内容を整理したものであり、実装完了や試験結果を保証しません。根拠参照と原図を確認してからご利用ください。',
    ''
  );

  const projectDescription = (scope.projectDescription || '').trim();
  if (projectDescription) {
    output.push('## プロジェクト背景・全体説明', '', escapeMarkdown(projectDescription), '');
  }

  output.push(
    '## 全体構成サマリ',
    '',
    `本ドキュメントは、プロジェクト「${escapeMarkdown(projectTitle)}」で思考展開（設計）されたシステム・プログラム・プロジェクトの全体像を整理したものです。対象範囲には図${scope.diagrams.length}件、ノード${scope.nodes.length}件（採用: ${adoptedCount}件、候補: ${candidateCount}件、下書き: ${draftCount}件）、分解エッジ${decompositionEdges.length}件${otherEdges.length > 0 ? `、その他の関係エッジ${otherEdges.length}件` : ''}が含まれます。${scope.excludedRejectedCount > 0 ? `却下済みのノード${scope.excludedRejectedCount}件は対象外としています。` : ''}`,
    ''
  );

  for (const sectionId of ['requirement', 'breakdown', 'concretization', 'realization'] as const) {
    const section = report.sections.find((item) => item.id === sectionId);
    if (!section?.statements.length) continue;
    output.push(`## ${sectionTitles[sectionId]}`, '');
    for (const statement of section.statements) output.push(renderStatement(statement), '');
  }

  if (scope.levels.length > 0 && scope.nodes.length > 0) {
    output.push('## 抽象度列（レベル）別の設計要素一覧', '');
    for (const level of scope.levels) {
      const levelNodes = scope.nodes.filter((node) => node.levelRef === level.ref);
      if (levelNodes.length === 0) continue;
      output.push(
        `### [${level.ref}] ${escapeMarkdown(level.label)}${level.description ? ` — ${escapeMarkdown(level.description)}` : ''}`,
        ''
      );
      for (const node of levelNodes) {
        const kind = kindsByRef.get(node.kindRef);
        const desc = node.description ? `: ${escapeMarkdown(node.description)}` : '';
        output.push(
          `- [${node.ref}] **[${escapeMarkdown(kind?.label || '未定義')}] ${escapeMarkdown(node.label)}**（状態: ${escapeMarkdown(node.status)}、図: ${node.diagramRef}）${desc}`
        );
      }
      output.push('');
    }
  }

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

  if (otherEdges.length > 0) {
    output.push('## 依存・制約・参照関係', '');
    for (const edge of otherEdges) {
      const source = nodesByRef.get(edge.sourceNodeRef);
      const target = nodesByRef.get(edge.targetNodeRef);
      output.push(
        `- [${edge.ref}] (${escapeMarkdown(edge.kind)}) [${edge.sourceNodeRef}] ${escapeMarkdown(source?.label || '')} → [${edge.targetNodeRef}] ${escapeMarkdown(target?.label || '')}${edge.label ? `（${escapeMarkdown(edge.label)}）` : ''}`
      );
    }
    output.push('');
  }

  const detailDiagrams = scope.diagrams.filter((diagram) => diagram.ownerNodeRef);
  if (detailDiagrams.length > 0) {
    output.push('## 展開ノードに紐づく詳細図', '');
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
