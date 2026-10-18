import React from 'react';

/**
 * ツールが稼働中に統合シェル（タブバー・ランチャーメニュー）へ通知するリアルタイム状態
 */
export interface ToolRuntimeStatus {
  /** タブバーのバッジに表示する主要カウント（例: ノード数） */
  badgeCount?: number;
  /** タブバーのバッジツールチップ説明 */
  badgeTooltip?: string;
  /** ランチャーメニューのカードに表示するステータスメトリクス一覧 */
  metrics?: Array<{ label: string; value: string | number; highlight?: 'amber' | 'emerald' }>;
  /** 未保存の変更があるか */
  isDirty?: boolean;
  /** AI生成やバックグラウンド処理を実行中か */
  isBusy?: boolean;
  /** 実行中ラベル（例: '生成中'） */
  busyLabel?: string;
}

/**
 * 統合シェルから各ツールのルートコンポーネントへ渡される共通 Props
 */
export interface ToolComponentProps {
  /** 現在このツールタブがアクティブ（表示中）かどうか */
  isActive: boolean;
  /** シェル全体で共有されるインメモリ Gateway Token */
  gatewayToken: string;
  /** ツール内で Gateway Token が変更・削除された際にシェルへ通知するコールバック */
  onGatewayTokenChange: (token: string) => void;
  /** ツールのバッジ情報・未保存状態・Busy状態が変化した際にシェルへ通知するコールバック */
  onStatusChange?: (status: ToolRuntimeStatus) => void;
}

/**
 * ツールカードおよびタブバーのアクセントカラーテーマ
 */
export type ToolThemeColor = 'blue' | 'indigo' | 'emerald' | 'amber' | 'rose' | 'purple';

export interface ToolAccentTheme {
  color: ToolThemeColor;
}

/**
 * 各ツールディレクトリ (src/tools/<tool-id>/manifest.tsx) がエクスポートするプラグインマニフェスト規約
 */
export interface ToolManifest {
  /**
   * URLハッシュ (#<id>) に使われる一意な識別子
   * - 英小文字・数字・ハイフン・アンダースコアのみ (/^[a-z0-9][a-z0-9-_]*$/)
   * - 'menu' および 'home' は予約語のため使用不可
   */
  id: string;
  /** ツール正式名称（メニューカード見出し・ブラウザタイトル用） */
  title: string;
  /** 英語サブタイトルやカテゴリ表記 */
  subtitle?: string;
  /** トップタブバーやカードバッジに表示する短い名称 */
  shortTitle: string;
  /** ランチャーメニュー画面に表示する説明文 */
  description: string;
  /** ランチャーメニュー画面に表示する主な機能箇条書き（最大4〜5項目推奨） */
  features?: string[];
  /** アイコンコンポーネント (lucide-react 等) */
  icon: React.ComponentType<{ className?: string }>;
  /** カラーテーマ (省略時は 'blue') */
  theme?: ToolAccentTheme;
  /** メニュー・タブバーでの表示順 (小さいほど先頭、省略時は 99) */
  order?: number;
  /** ツールのルートReactコンポーネント */
  component: React.ComponentType<ToolComponentProps>;
}
