import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkspaceStatistics } from '@character-unity/store/statistics';
import { StatisticsReport } from './view';

const statistics: WorkspaceStatistics = {
  membership: { total: 5, owned: 3, archiveReferences: 2, forks: 2, favorites: 2, inChat: 2 },
  content: { ownedRevisions: 4, greetings: { total: 8, cards: 3, knownCards: 4 }, lorebookEntries: { total: 7, cards: 2, knownCards: 4 }, tokens: { total: 0, knownCards: 0 } },
  storage: { localAssets: 1, localBytes: 17, inheritedAssets: 1, inheritedBytes: 40, stagedAssets: 1, stagedBytes: 3 },
  chat: { copies: 3, matched: 2, edited: 1 }, tags: [{ label: '<script>alert(1)</script>', count: 2 }],
  creators: [], formats: [{ label: 'charx', count: 2 }], sources: [{ label: 'chub', count: 2 }],
};
describe('native statistics presentation', () => {
  it('distinguishes membership, coverage and local storage from inherited Archive bytes', () => {
    const html = renderToStaticMarkup(createElement(StatisticsReport, { statistics }));
    const text = html.replace(/<[^>]*>/g, ' ');
    expect(text).toContain('Archive references');
    expect(text).toContain('4 of 5 library items');
    expect(text).toContain('Not measured');
    expect(text).toContain('17 B');
    expect(text).toContain('40 B');
    expect(text).toContain('remain in Archive');
    expect(text).toContain('3');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('shows a real empty-library state without presenting missing measurements as zero', () => {
    const empty: WorkspaceStatistics = {
      membership: { total: 0, owned: 0, archiveReferences: 0, forks: 0, favorites: 0, inChat: 0 },
      content: { ownedRevisions: 0, greetings: { total: 0, cards: 0, knownCards: 0 }, lorebookEntries: { total: 0, cards: 0, knownCards: 0 }, tokens: { total: 0, knownCards: 0 } },
      storage: { localAssets: 0, localBytes: 0, inheritedAssets: 0, inheritedBytes: 0, stagedAssets: 0, stagedBytes: 0 },
      chat: { copies: 0, matched: 0, edited: 0 }, tags: [], creators: [], formats: [], sources: [],
    };
    const html = renderToStaticMarkup(createElement(StatisticsReport, { statistics: empty }));
    expect(html).toContain('Your library is empty');
    expect(html).not.toContain('Not measured');
  });
});
