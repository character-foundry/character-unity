import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Architect } from './app.js';
import { api } from './api.js';
import '@character-unity/ui/styles.css';
import '@character-unity/editor/styles.css';
import '@character-unity/archive-browser/styles.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
const host = import.meta.env.VITE_UNITY_STORAGE === 'browser'
  ? (await import('./browser.js')).createBrowserHost() : api;
createRoot(root).render(
  <StrictMode>
    <Architect api={host} />
  </StrictMode>,
);
