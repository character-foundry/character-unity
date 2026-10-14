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
import SharingPage from '@/features/sharing/page';
import RemotesPage from '@/features/remotes/page';
import StatisticsPage from '@/features/statistics/page';
import ContentPage from '@/features/content/page';
import MetaTagsPage from '@/features/meta-tags/page';
import { SessionProvider } from '@/lib/session-provider';
import { LibraryClientProvider, useLibraryClient } from '@/lib/library-client';
import { createWebSessionRuntime } from '@/lib/runtime';
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
function NativeRoutes() {
  const client = useLibraryClient();
  return <Routes key={client.scopeKey}>
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
          <Route path="/stats" element={<StatisticsPage />} />
          <Route path="/content" element={<ContentPage />} />
          <Route path="/meta-tags" element={<MetaTagsPage />} />
          <Route path="/sharing" element={<SharingPage />} />
          <Route path="/remotes" element={<RemotesPage />} />
          <Route path="/chat-apps" element={<Navigate to="/settings#chat-apps" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>;
}
void createWebSessionRuntime().then((runtime) => {
  createRoot(root).render(<StrictMode><SettingsProvider><BrowserRouter><SessionProvider runtime={runtime}>
    <LibraryClientProvider><NativeRoutes /></LibraryClientProvider>
  </SessionProvider></BrowserRouter></SettingsProvider></StrictMode>);
}).catch((error: unknown) => {
  root.setAttribute('role', 'alert');
  root.textContent = `Unity could not open: ${error instanceof Error ? error.message : 'Unknown startup failure'}. Reload to retry.`;
});
