import { FileOutput } from 'lucide-react';
import type { ToolManifest } from '../../shell/types';
import { HaiaApp } from './App';

export const manifest: ToolManifest = {
  id: 'haia',
  title: 'HAIA',
  subtitle: 'Hybrid AI Assistant',
  shortTitle: 'HAIA',
  description: 'タスクや XML ワークフローを使って文書処理を実行します。',
  features: ['LLM-Gateway によるテキスト生成', '既存の HAIA ワークフローとプロンプト', '文書変換と YouTube 字幕の取り込み'],
  icon: FileOutput,
  theme: { color: 'indigo' },
  order: 40,
  component: HaiaApp,
};
