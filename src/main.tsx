import React from 'react';
import ReactDOM from 'react-dom/client';
import { preloadLLMModelSeed } from './shared/llm/modelRegistry';
import './index.css';

async function bootstrap(): Promise<void> {
  await preloadLLMModelSeed({ timeoutMs: 500 });
  const { FailurePrismApp } = await import('./shell/FailurePrismApp');

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <FailurePrismApp />
    </React.StrictMode>
  );
}

void bootstrap();
