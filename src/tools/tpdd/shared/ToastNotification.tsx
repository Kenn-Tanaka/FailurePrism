import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { useApp } from '../app/AppContext';

export const ToastNotification: React.FC = () => {
  const { state, dispatch } = useApp();
  const notification = state.ui.notification;

  useEffect(() => {
    if (!notification) return;

    // 4秒後に自動消去
    const timer = setTimeout(() => {
      dispatch({ type: 'CLEAR_NOTIFICATION' });
    }, 4000);

    return () => clearTimeout(timer);
  }, [notification?.id, dispatch]);

  if (!notification) return null;

  const handleDismiss = () => {
    dispatch({ type: 'CLEAR_NOTIFICATION' });
  };

  const config = {
    error: {
      bg: 'bg-red-50 border-red-300 text-red-900',
      icon: <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />,
    },
    warning: {
      bg: 'bg-amber-50 border-amber-300 text-amber-900',
      icon: <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />,
    },
    success: {
      bg: 'bg-emerald-50 border-emerald-300 text-emerald-900',
      icon: <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />,
    },
    info: {
      bg: 'bg-blue-50 border-blue-300 text-blue-900',
      icon: <Info className="w-5 h-5 text-blue-600 flex-shrink-0" />,
    },
  }[notification.type] || {
    bg: 'bg-slate-50 border-slate-300 text-slate-900',
    icon: <Info className="w-5 h-5 text-slate-600 flex-shrink-0" />,
  };

  return createPortal(
    <div
      role="alert"
      className={`fixed top-14 right-5 z-50 flex items-start gap-3 p-3.5 rounded-lg border shadow-lg max-w-sm w-full transition-all animate-in fade-in slide-in-from-top-2 duration-200 select-none ${config.bg}`}
    >
      {config.icon}
      <div className="flex-1 text-xs leading-relaxed break-words font-medium">
        {notification.message}
      </div>
      <button
        onClick={handleDismiss}
        className="text-slate-400 hover:text-slate-700 p-0.5 rounded transition-colors -mr-1 -mt-1"
        title="閉じる"
      >
        <X className="w-4 h-4" />
      </button>
    </div>,
    document.body
  );
};
