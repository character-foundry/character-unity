import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { SettingsProvider } from '@/lib/settings';
import LibraryPage from '@/app/library';
import CardDetailPage from '@/app/card/[slug]/page';
import EditPage from '@/app/edit';
import SettingsPage from '@/app/settings';
import SearchPage from '@/app/search';
import '@character-unity/editor/styles.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(
  <StrictMode>
    <SettingsProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/explore" element={<LibraryPage />} />
          <Route path="/card/:id" element={<CardDetailPage />} />
          <Route path="/card/:id/edit" element={<EditPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/chat-apps" element={<Navigate to="/settings#chat-apps" replace />} />
          <Route path="*" element={<LibraryPage />} />
        </Routes>
      </BrowserRouter>
    </SettingsProvider>
  </StrictMode>,
);
