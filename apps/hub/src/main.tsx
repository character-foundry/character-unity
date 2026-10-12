import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Hub } from './app.js';
import '@character-unity/ui/styles.css';
import '@character-unity/editor/styles.css';
import '@character-unity/archive-browser/styles.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(
  <StrictMode>
    <Hub />
  </StrictMode>,
);
