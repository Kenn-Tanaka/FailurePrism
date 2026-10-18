import React from 'react';
import { useVTAStore } from '../features/vta/store/vtaStore';
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from 'lucide-react';

export const ToastContainer: React.FC = () => {
  const toasts = useVTAStore((state) => state.toasts);
  const dismissToast = useVTAStore((state) => state.dismissToast);

  if (!toasts || toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed bottom-5 right-5 z-[10000] flex flex-col gap-2 max-w-sm w-full pointer-events-none select-none"
    >
      {toasts.map((toast) => {
        const isSuccess = toast.type === 'success';
        const isError = toast.type === 'error';
        const isWarn = toast.type === 'warn';

        return (
          <div
            key={toast.id}
            role="alert"
            className={`pointer-events-auto flex items-start gap-2.5 p-3.5 rounded-xl border shadow-xl backdrop-blur-md transition-all duration-300 animate-in slide-in-from-bottom-2 fade-in ${
              isSuccess
                ? 'bg-slate-900/95 border-emerald-500/70 text-emerald-200 shadow-emerald-950/40'
                : isError
                ? 'bg-slate-900/95 border-rose-500/70 text-rose-200 shadow-rose-950/40'
                : isWarn
                ? 'bg-slate-900/95 border-amber-500/70 text-amber-200 shadow-amber-950/40'
                : 'bg-slate-900/95 border-cyan-500/70 text-cyan-200 shadow-cyan-950/40'
            }`}
          >
            <div className="shrink-0 mt-0.5">
              {isSuccess && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
              {isError && <AlertCircle className="w-4 h-4 text-rose-400" />}
              {isWarn && <AlertTriangle className="w-4 h-4 text-amber-400" />}
              {!isSuccess && !isError && !isWarn && <Info className="w-4 h-4 text-cyan-400" />}
            </div>

            <div className="flex-1 text-xs leading-relaxed font-medium break-words text-slate-100">
              {toast.message}
            </div>

            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              className="shrink-0 p-1 rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/10 transition-colors"
              aria-label="閉じる"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
