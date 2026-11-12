import '@xyflow/react/dist/base.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/shell.css';
import './styles/canvas.css';
import './styles/nodes.css';
import './styles/panels.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { registerBuiltinDecorations } from './nodes/builtinDecorations.js';

registerBuiltinDecorations();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
