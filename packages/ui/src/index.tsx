import type { ReactNode } from 'react';

export function AppShell({ app, title, description, children }: {
  app: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="unity-shell">
      <header><span className="unity-mark" aria-hidden="true">u.</span><strong>Character Unity</strong><span className="unity-app">{app}</span></header>
      <main>
        <p className="unity-eyebrow">{app}</p>
        <h1>{title}</h1>
        <p className="unity-description">{description}</p>
        {children}
      </main>
      <footer>Character Unity · A home for characters and their stories.</footer>
    </div>
  );
}

export { ExportControls } from './export-controls.js';
