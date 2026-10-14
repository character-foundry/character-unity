import { afterEach, expect, it, vi } from 'vitest';
import { runComfyWorkflow } from './comfy';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
const workflow = JSON.stringify({ '1': { class_type: 'SaveImage', inputs: { images: ['2', 0] } } });
afterEach(() => vi.unstubAllGlobals());

it('queues only the configured workflow, reads only its selected image and verifies actual raster bytes', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close() {} })));
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url.endsWith('/prompt')) return Response.json({ prompt_id: 'owned-job' });
    if (url.includes('/history/')) return Response.json({ 'owned-job': { status: { completed: true, status_str: 'success' },
      outputs: { '1': { images: [{ filename: 'owned.png', subfolder: '', type: 'output' }] } } } });
    return new Response(png, { headers: { 'content-type': 'text/html' } });
  };
  const result = await runComfyWorkflow({ baseUrl: 'http://127.0.0.1:8188', workflow, fetch: fetcher });
  expect(calls).toHaveLength(2);
  expect(calls[0]!.init).toMatchObject({ credentials: 'omit', redirect: 'error', method: 'POST' });
  expect(JSON.parse(String(calls[0]!.init?.body)).prompt).toEqual(JSON.parse(workflow));
  const file = await result.readImage(0);
  expect(calls.at(-1)!.url).toBe('http://127.0.0.1:8188/view?filename=owned.png&subfolder=&type=output');
  expect(file.type).toBe('image/png');
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(png);
});

it('cancels a stalled image body without interrupting or clearing any other server job', async () => {
  const owner = new AbortController(); let canceled = false;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/prompt')) return Response.json({ prompt_id: 'owned-job' });
    if (url.includes('/history/')) return Response.json({ 'owned-job': { status: { completed: true },
      outputs: { '1': { images: [{ filename: 'owned.png', subfolder: '', type: 'output' }] } } } });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(png); }, cancel() { canceled = true; } }));
  };
  const result = await runComfyWorkflow({ baseUrl: 'http://127.0.0.1:8188', workflow, fetch: fetcher }, owner.signal);
  const reading = result.readImage(0); await Promise.resolve(); owner.abort();
  await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  expect(canceled).toBe(true);
  expect(calls.some((url) => /interrupt|queue/.test(url))).toBe(false);
}, 1000);

it('refuses nonlocal origins and visual-editor workflows before any network request', async () => {
  const fetcher = vi.fn<typeof fetch>();
  for (const baseUrl of ['https://remote.invalid', 'http://127.0.0.1:8188/path', 'http://user:secret@localhost:8188']) {
    await expect(runComfyWorkflow({ baseUrl, workflow, fetch: fetcher })).rejects.toThrow('loopback');
  }
  await expect(runComfyWorkflow({ baseUrl: 'http://localhost:8188', workflow: '{"nodes":[]}', fetch: fetcher })).rejects.toThrow('Export (API)');
  expect(fetcher).not.toHaveBeenCalled();
});

it('stops polling its owned job on cancellation without global queue or interrupt operations', async () => {
  const controller = new AbortController(); const paths: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input); paths.push(url);
    if (url.endsWith('/prompt')) return Response.json({ prompt_id: 'owned-job' });
    controller.abort(); return Response.json({});
  };
  await expect(runComfyWorkflow({ baseUrl: 'http://localhost:8188', workflow, fetch: fetcher }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(paths).toEqual(['http://localhost:8188/prompt', 'http://localhost:8188/history/owned-job']);
});

it('rejects output traversal locators without fetching arbitrary local files', async () => {
  const paths: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input); paths.push(url);
    if (url.endsWith('/prompt')) return Response.json({ prompt_id: 'owned-job' });
    return Response.json({ 'owned-job': { status: { completed: true }, outputs: { '1': { images: [{ filename: '../secrets.png', subfolder: '', type: 'output' }] } } } });
  };
  await expect(runComfyWorkflow({ baseUrl: 'http://localhost:8188', workflow, fetch: fetcher })).rejects.toThrow('unsafe');
  expect(paths).toHaveLength(2);
});

it('reports local connection and CORS configuration failures without exposing an implicit proxy fallback', async () => {
  await expect(runComfyWorkflow({ baseUrl: 'http://localhost:8188', workflow, fetch: async () => { throw new TypeError('Failed to fetch'); } }))
    .rejects.toThrow('Check its loopback origin and CORS settings');
});
