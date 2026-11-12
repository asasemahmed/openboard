// Before anything else: take an invite token out of the address bar.
import './joinToken.js';
import '@xyflow/react/dist/base.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/shell.css';
import './styles/canvas.css';
import './styles/nodes.css';
import './styles/panels.css';
import './styles/trust.css';
import './styles/live.css';
import './styles/code.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { registerTrust } from './trust.js';

registerTrust();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
