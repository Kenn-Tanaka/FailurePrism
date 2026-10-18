import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertOctagon, RefreshCw, Download, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error('ErrorBoundary caught an unhandled error:', error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleDownloadEmergencyBackup = () => {
    try {
      // Emergency dump from localStorage or current window state
      const backupData = {
        timestamp: new Date().toISOString(),
        error: this.state.error?.message,
        stack: this.state.error?.stack,
        componentStack: this.state.errorInfo?.componentStack,
      };
      const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vta-emergency-error-log-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('エラーログの出力に失敗しました。');
    }
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-xl w-full bg-slate-900 border border-rose-800/80 rounded-2xl p-6 shadow-2xl space-y-5">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-rose-950/80 border border-rose-700 rounded-xl text-rose-400">
                <AlertOctagon className="w-8 h-8" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-100">
                  {this.props.fallbackTitle || '描画処理中に予期せぬエラーが発生しました'}
                </h2>
                <p className="text-xs text-rose-300">
                  画面のクラッシュを安全に捕捉しました。作業内容を失わないよう復旧をお試しください。
                </p>
              </div>
            </div>

            <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 font-mono text-[11px] text-rose-300 overflow-x-auto max-h-48">
              <p className="font-bold">{this.state.error?.name}: {this.state.error?.message}</p>
              {this.state.error?.stack && (
                <pre className="mt-2 text-[10px] text-slate-500 whitespace-pre-wrap">{this.state.error.stack}</pre>
              )}
            </div>

            <div className="flex flex-wrap gap-2.5 pt-2">
              <button
                type="button"
                onClick={this.handleReload}
                className="flex-1 min-w-[140px] px-4 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer shadow-lg shadow-cyan-950/40"
              >
                <RefreshCw className="w-4 h-4" />
                <span>画面を再読み込み</span>
              </button>

              <button
                type="button"
                onClick={this.handleDownloadEmergencyBackup}
                className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer"
                title="診断用エラーログをダウンロード"
              >
                <Download className="w-4 h-4 text-cyan-400" />
                <span>エラーログ保存</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
