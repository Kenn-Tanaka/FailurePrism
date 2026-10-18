import React from 'react';
import { Sliders, Sparkles } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { DetailPanel } from './DetailPanel';
import { AiPanel } from '../ai/AiPanel';

export const RightSidebar: React.FC = () => {
  const { state, dispatch } = useApp();
  const { activeRightTab } = state.ui;

  return (
    <aside className="w-80 bg-white border-l border-slate-200 flex flex-col h-full select-none shadow-sm z-10">
      {/* タブ切り替えバー */}
      <div className="flex border-b border-slate-200">
        <button
          onClick={() => dispatch({ type: 'SET_RIGHT_TAB', tab: 'detail' })}
          className={`flex-1 py-2 text-xs font-medium flex items-center justify-center gap-1.5 border-b-2 transition-colors ${
            activeRightTab === 'detail'
              ? 'border-blue-600 text-blue-600 bg-blue-50/50'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Sliders className="w-3.5 h-3.5" />
          詳細
        </button>

        <button
          onClick={() => dispatch({ type: 'SET_RIGHT_TAB', tab: 'ai' })}
          className={`flex-1 py-2 text-xs font-medium flex items-center justify-center gap-1.5 border-b-2 transition-colors ${
            activeRightTab === 'ai'
              ? 'border-purple-600 text-purple-600 bg-purple-50/50'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          AI支援
        </button>
      </div>

      {/* タブコンテンツ */}
      <div className="flex-1 overflow-y-auto">
        <div className={activeRightTab === 'detail' ? 'h-full' : 'hidden'}>
          <DetailPanel />
        </div>
        <div className={activeRightTab === 'ai' ? 'h-full' : 'hidden'}>
          <AiPanel />
        </div>
      </div>
    </aside>
  );
};
