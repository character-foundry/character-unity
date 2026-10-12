import { expect, it, vi } from 'vitest';
import { api } from './api.js';

it('sends only the Archive snapshot token and IDs when reviewing/importing a large page', async () => {
  const send = vi.fn(async () => Response.json({}));
  vi.stubGlobal('fetch', send);
  try {
    const page = { version: 'unity.archive-read.v1' as const, archiveId: 'fixture', snapshot: 'a'.repeat(64),
      cards: Array.from({ length: 100 }, (_, i) => ({ id: `card-${i}`, metadata: 'large opaque metadata'.repeat(1000) })) };
    const ids = page.cards.map((card) => card.id);
    await api.archive.select('workspace', page, ids);
    await api.archive.import('workspace', page, ids);
    for (const call of send.mock.calls) {
      const body = (call as unknown as [string, RequestInit])[1].body as string;
      expect(JSON.parse(body)).toEqual({ snapshot: { version: page.version, archiveId: page.archiveId, snapshot: page.snapshot }, ids });
      expect(body.length).toBeLessThan(20_000);
    }
  } finally { vi.unstubAllGlobals(); }
});
