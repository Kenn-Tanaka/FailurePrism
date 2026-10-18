import React from 'react';
import ReactDOM from 'react-dom/client';
import { FailurePrismApp } from './shell/FailurePrismApp';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FailurePrismApp />
  </React.StrictMode>
);
