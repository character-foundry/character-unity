import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { SettingsProvider } from '@/lib/settings';
import { AppShell } from '@/components/layout';
import LibraryPage from '@/app/library';
import CardDetailPage from '@/features/viewer/page';
import EditPage from '@/app/edit';
import NewCardPage from '@/app/new';
import EditorSessionLayout from '@/app/editor-session';
import ArchivePage from '@/app/archive';
import SettingsPage from '@/app/settings';
import './styles.css';

/** The search page merged into the library; old links keep their query. */
function SearchRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/${search}`} replace />;
}

function NotFoundPage() {
  return (
    <AppShell>
      <div className="py-24 text-center">
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-starlight/60">This page does not exist in Character Unity.</p>
        <Link to="/" className="mt-4 inline-block text-sm hover:underline">Back to library</Link>
      </div>
    </AppShell>
  );
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
          <Route element={<EditorSessionLayout />}>
            <Route path="/card/:id/edit" element={<EditPage />} />
            <Route path="/new" element={<NewCardPage />} />
            <Route path="/card/:id/fork" element={<NewCardPage key="fork" />} />
          </Route>
          <Route path="/search" element={<SearchRedirect />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/chat-apps" element={<Navigate to="/settings#chat-apps" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
    </SettingsProvider>
  </StrictMode>,
);
