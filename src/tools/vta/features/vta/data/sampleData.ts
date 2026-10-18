import { VTASchema } from '../../../types/vta';

export interface SampleScenario {
  id: string;
  title: string;
  scenarioText: string;
  vtaData: VTASchema;
}

export const SAMPLE_SCENARIOS: SampleScenario[] = [
  {
    id: 'satellite-design-change',
    title: '【事例1】衛星サブシステム設計変更・手順書改訂漏れ',
    scenarioText: `プロジェクトにおいて、CDR（基本設計審査）完了後、サブシステム部門がコスト削減を目的に機器の設計変更を実施した。
しかし、サブシステム部門はその設計変更内容をシステム部門へ連絡することを失念した。
また、サブシステム部門内部でも設計変更に伴う作業手順書の改訂を行わなかった。
その後、システム部門は旧仕様の設計書のまま総合試験手順書を作成した。
試験当日、サブシステム部門の作業員は改訂されていない旧作業手順書に従って結線作業を実施した。
システム部門による試験前確認でも、インターフェース不整合に気付かず確認を完了した。
その結果、通電試験時に過電圧が印加され、搭載機器の破損事故が発生した。`,
    vtaData: {
      lanes: ['システム部門', 'サブシステム部門', '試験実施班'],
      supplementary_summary: '【背景要因総括】CDR完了後の仕様変更管理プロセスの形骸化、部署間連絡における公式ワークフローの欠如、および試験前確認作業のダブルチェック機能不全が重なった複合的ヒューマンエラー事例。',
      nodes: [
        {
          id: 'node_1',
          lane: 'サブシステム部門',
          time: 'CDR後（2ヶ月）',
          type: 'variation',
          title: 'コスト削減の設計変更を実施',
          description: 'コスト削減のため機器インターフェースの仕様を変更した。',
          supplementary_note: '【背景・組織要因】プロジェクト予算の圧縮圧力があり、設計変更の迅速化が優先された。',
          measure_type: null,
        },
        {
          id: 'node_2',
          lane: 'サブシステム部門',
          time: 'CDR後（2.5ヶ月）',
          type: 'variation',
          title: 'システム部門への連絡失念',
          description: '設計変更の通知プロセスを怠り、他部署へ共有しなかった。',
          supplementary_note: '【ヒューマンファクタ】「後でまとめて連絡すればよい」という先延ばし心理と、部署間通知システムの未自動化。',
          measure_type: 'elimination',
        },
        {
          id: 'node_3',
          lane: 'サブシステム部門',
          time: 'CDR後（3ヶ月）',
          type: 'variation',
          title: '作業手順書の改訂漏れ',
          description: '設計変更後の結線手順の更新が行われなかった。',
          supplementary_note: '【管理要因】手順書改訂のトリガーが設計変更承認プロセスに組み込まれていなかった。',
          measure_type: 'elimination',
        },
        {
          id: 'node_4',
          lane: 'システム部門',
          time: '試験1ヶ月前',
          type: 'normal',
          title: '旧仕様での総合試験手順書作成',
          description: '設計変更が伝達されていないため、旧仕様で手順書を作成した。',
          supplementary_note: '【定常業務】最新の設計リポジトリを参照していたが、リポジトリ自体の更新が漏れていたため旧版を参照。',
          measure_type: null,
        },
        {
          id: 'node_5',
          lane: '試験実施班',
          time: '試験当日 朝',
          type: 'variation',
          title: '旧手順書による結線作業',
          description: '未改訂の手順書に従って結線を実施した。',
          supplementary_note: '【環境・作業要因】作業員は配布された正規手順書に従っていたため、現場レベルでの誤り検知は極めて困難であった。',
          measure_type: null,
        },
        {
          id: 'node_6',
          lane: 'システム部門',
          time: '試験直前',
          type: 'variation',
          title: '試験前確認での見逃し',
          description: 'ピン配置の整合性チェックが形骸化しており、不整合を検知できず。',
          supplementary_note: '【ヒューマンファクタ】「いつも通りの構成である」という強い思い込み（確証バイアス）とチェックリストの形式的承認。',
          measure_type: null,
        },
        {
          id: 'node_7',
          lane: 'システム部門',
          time: '試験開始',
          type: 'variation',
          title: '【不具合発生】通電による搭載機器破損',
          description: '過電圧印加によりメイン基板が焼損した。',
          supplementary_note: '【結果】保護回路の閾値を超える過電圧が印加され、重要コンポーネントが物理的に破損。',
          measure_type: null,
        },
      ],
      edges: [
        {
          source: 'node_1',
          target: 'node_2',
          direction: 'sequential',
          is_break: false,
        },
        {
          source: 'node_1',
          target: 'node_3',
          direction: 'sequential',
          is_break: false,
        },
        {
          source: 'node_2',
          target: 'node_4',
          direction: 'unidirectional',
          is_break: true,
        },
        {
          source: 'node_3',
          target: 'node_5',
          direction: 'unidirectional',
          is_break: true,
        },
        {
          source: 'node_4',
          target: 'node_6',
          direction: 'sequential',
          is_break: false,
        },
        {
          source: 'node_5',
          target: 'node_6',
          direction: 'unidirectional',
          is_break: false,
        },
        {
          source: 'node_6',
          target: 'node_7',
          direction: 'sequential',
          is_break: false,
        },
      ],
    },
  },
  {
    id: 'software-release-incident',
    title: '【IT/Web事例】本番デプロイ時のDBマイグレーション障害',
    scenarioText: `開発チームが新機能リリースにあたり、DBスキーマのマイグレーションスクリプトを作成した。
開発担当者はローカル環境で動作確認したが、ステージング環境での本番相当データを使った検証手順を省略した。
さらに、リリース手順書にマイグレーション実行の依存関係が正しく記載されていなかった。
運用チームは手順書に従い、アプリのデプロイ前にマイグレーションを実行した。
しかし大量データによるロック競合が発生し、APIサーバーが接続タイムアウトで全停止した。`,
    vtaData: {
      lanes: ['開発チーム', '運用チーム', 'エンドユーザー'],
      nodes: [
        {
          id: 'it_1',
          lane: '開発チーム',
          time: 'リリース3日前',
          type: 'normal',
          title: 'DBマイグレーションスクリプト作成',
          description: 'カラム追加とインデックス再構築を含むスクリプトを実装。',
          measure_type: null,
        },
        {
          id: 'it_2',
          lane: '開発チーム',
          time: 'リリース2日前',
          type: 'variation',
          title: 'ステージング負荷検証の省略',
          description: '本番同等データでの実行時間・ロック影響のテストをスキップした。',
          measure_type: 'elimination',
        },
        {
          id: 'it_3',
          lane: '開発チーム',
          time: 'リリース前日',
          type: 'variation',
          title: '手順書の依存関係記載不備',
          description: '無停止メンテ手順の注意書きが欠落していた。',
          measure_type: 'elimination',
        },
        {
          id: 'it_4',
          lane: '運用チーム',
          time: 'リリース当日 22:00',
          type: 'normal',
          title: '手順書通りにスクリプト先行実行',
          description: '記載手順に従ってマイグレーションコマンドを実行した。',
          measure_type: null,
        },
        {
          id: 'it_5',
          lane: '運用チーム',
          time: '22:05',
          type: 'variation',
          title: 'DBテーブルロック発生・タイムアウト',
          description: '全テーブルロックによりトランザクションが待機状態に陥った。',
          measure_type: null,
        },
        {
          id: 'it_6',
          lane: 'エンドユーザー',
          time: '22:08',
          type: 'variation',
          title: '【障害】サービス全停止（504エラー）',
          description: '全ユーザーがサービスにアクセス不能となった。',
          measure_type: null,
        },
      ],
      edges: [
        { source: 'it_1', target: 'it_2', is_break: false },
        { source: 'it_1', target: 'it_3', is_break: false },
        { source: 'it_2', target: 'it_5', is_break: true },
        { source: 'it_3', target: 'it_4', is_break: true },
        { source: 'it_4', target: 'it_5', is_break: false },
        { source: 'it_5', target: 'it_6', is_break: false },
      ],
    },
  },
];
