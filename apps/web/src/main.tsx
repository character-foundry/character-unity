import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { SettingsProvider } from '@/lib/settings';
import LibraryPage from '@/app/library';
import CardDetailPage from '@/app/card/[slug]/page';
import EditPage from '@/app/edit';
import NewCardPage from '@/app/new';
import ArchivePage from '@/app/archive';
import SettingsPage from '@/app/settings';
import '@character-unity/editor/styles.css';
import './styles.css';

/** The search page merged into the library; old links keep their query. */
function SearchRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/${search}`} replace />;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(
  <StrictMode>
    <SettingsProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/explore" element={<LibraryPage />} />
          <Route path="/archive" element={<ArchivePage />} />
          <Route path="/card/:id" element={<CardDetailPage />} />
          <Route path="/card/:id/edit" element={<EditPage />} />
          <Route path="/new" element={<NewCardPage />} />
          <Route path="/card/:id/fork" element={<NewCardPage key="fork" />} />
          <Route path="/search" element={<SearchRedirect />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/chat-apps" element={<Navigate to="/settings#chat-apps" replace />} />
          <Route path="*" element={<LibraryPage />} />
        </Routes>
      </BrowserRouter>
    </SettingsProvider>
  </StrictMode>,
);
