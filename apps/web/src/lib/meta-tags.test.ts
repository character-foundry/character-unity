import { describe, expect, it, vi } from 'vitest';
import { createMetaTagClient } from './meta-tags';
import { createSessionRuntime } from './session';
import { createLibraryClient } from './unity';

const alice = { actor: { id: 'alice', uri: 'urn:unity:user:alice' }, name: 'Alice', expiresAt: 10_000 };
const initial = { version: 1, groups: [{ id: 'fantasy', name: 'Fantasy Guild', members: ['fantasy', 'elves'] }] };
async function fixture() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path) => {
    if (path === '/api/client') return Response.json({ profile: 'hub', capabilities: { browserLLM: false } });
    if (path === '/api/session') return Response.json(alice);
    return Response.json(initial);
  });
  const runtime = createSessionRuntime({ fetch: fetcher }), connection = await runtime.restore();
  return { runtime, connection, fetcher, library: createLibraryClient(connection, 'workspace /?') };
}

describe('native workspace Meta-tag client', () => {
  it('captures account, workspace, transport and submitted catalog instead of consulting a newer selection', async () => {
    const { runtime, connection, fetcher, library } = await fixture();
    const client = createMetaTagClient(library), input = { expectedVersion: 1, groups: structuredClone(initial.groups) };
    let finish!: () => void;
    const delayed = new Promise<void>((resolve) => { finish = resolve; });
    fetcher.mockImplementationOnce(async (path, options) => {
      expect(path).toBe('/api/workspaces/workspace%20%2F%3F/meta-tags');
      expect(options?.method).toBe('PUT');
      expect(new Headers(options?.headers).get('x-unity-actor')).toBe('alice');
      expect(JSON.parse(String(options?.body))).toEqual({ expectedVersion: 1, groups: initial.groups });
      await delayed;
      return Response.json({ ...initial, version: 2 });
    });
    const saving = client.write(input);
    input.groups[0]!.name = 'Later draft'; input.groups[0]!.members.push('not submitted');
    fetcher.mockImplementationOnce(async () => Response.json({ ...alice, actor: { id: 'bob', uri: 'urn:unity:user:bob' }, name: 'Bob' }));
    const bob = await runtime.login('bob-key'), other = createMetaTagClient(createLibraryClient(bob, 'different-workspace'));
    expect(other.scopeKey).not.toBe(client.scopeKey);
    finish(); expect(await saving).toEqual({ ...initial, version: 2 });
    fetcher.mockImplementationOnce(async (path, options) => {
      expect(path).toBe('/api/workspaces/workspace%20%2F%3F/meta-tags');
      expect(new Headers(options?.headers).get('x-unity-actor')).toBe('alice');
      return Response.json(initial);
    });
    expect(await client.read()).toEqual(initial);
    connection.dispose(); bob.dispose();
  });

  it.each(['request', 'connection'] as const)('cancels an outstanding catalog read when its %s ends', async (kind) => {
    const { connection, fetcher, library } = await fixture(), controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    fetcher.mockImplementationOnce(async (_path, options) => {
      expect(new Headers(options?.headers).get('x-unity-actor')).toBe('alice');
      started();
      return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
    });
    const reading = createMetaTagClient(library).read(controller.signal);
    await ready;
    if (kind === 'request') controller.abort(); else connection.dispose();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    connection.dispose();
  });

  it('surfaces storage and stale-save errors without returning a successful or empty catalog', async () => {
    const { connection, fetcher, library } = await fixture(), client = createMetaTagClient(library);
    fetcher.mockResolvedValueOnce(Response.json({ error: { code: 'UNAVAILABLE', message: 'Meta-tag storage is unavailable' } }, { status: 503 }));
    await expect(client.read()).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'Meta-tag storage is unavailable' });
    fetcher.mockResolvedValueOnce(Response.json({ error: { code: 'HEAD_CONFLICT', message: 'Catalog changed; reload before saving' } }, { status: 409 }));
    await expect(client.write({ expectedVersion: 1, groups: initial.groups })).rejects.toMatchObject({ code: 'HEAD_CONFLICT', status: 409 });
    fetcher.mockResolvedValueOnce(Response.json({ version: 1, groups: [{ id: 'broken', name: 'Broken', members: [null] }] }));
    await expect(client.read()).rejects.toThrow('invalid Meta-tag catalog');
    connection.dispose();
  });

  it('normalizes and bounds the submitted catalog before transport, while accepting valid multibyte catalogs larger than a legacy file', async () => {
    const { connection, fetcher, library } = await fixture(), client = createMetaTagClient(library);
    const invalid = { expectedVersion: 0, groups: [{ id: 'empty-group', name: 'Empty', members: [] }] };
    const before = fetcher.mock.calls.length;
    await expect(client.write(invalid)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetcher).toHaveBeenCalledTimes(before);
    const groups = Array.from({ length: 10 }, (_, group) => ({ id: `group-${group}`, name: `  Group ${group}  `,
      members: Array.from({ length: 100 }, (_, member) => `  ${String(group * 100 + member).padStart(4, '0')}${'界'.repeat(124)}  `),
    }));
    fetcher.mockImplementationOnce(async (_path, options) => {
      const text = String(options?.body), submitted = JSON.parse(text) as { expectedVersion: number; groups: typeof groups };
      expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(256 * 1024);
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(1024 * 1024);
      expect(submitted.groups[0]!.name).toBe('Group 0');
      expect(submitted.groups[0]!.members[0]!.length).toBe(128);
      return Response.json({ version: 1, groups: submitted.groups });
    });
    expect((await client.write({ expectedVersion: 0, groups })).groups).toHaveLength(10);
    connection.dispose();
  });
});
