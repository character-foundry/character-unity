import { isPNG } from '@character-foundry/character-foundry/png';

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const imageLimit = 32 * 1024 * 1024;
function baseUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('ComfyUI needs an explicit loopback HTTP(S) origin without credentials or a path.');
  return url.origin;
}
async function bounded(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`ComfyUI request failed (${response.status}). Check the workflow and local server.`); }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > limit)) { await response.body?.cancel(); throw new Error('ComfyUI response exceeds its size limit.'); }
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader?.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (reader) {
      const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
      size += next.value.byteLength; if (size > limit) throw new Error('ComfyUI response exceeds its size limit.');
      chunks.push(new Uint8Array(next.value));
    }
  } finally { signal.removeEventListener('abort', abort); await reader?.cancel().catch(() => undefined); reader?.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** The official self-hosted /prompt, /history/{id}, /view contract. Polling exists
 * only during this owned job; cancel never interrupts another ComfyUI job.
 * https://docs.comfy.org/development/comfyui-server/comms_routes */
export async function runComfyWorkflow(options: { baseUrl: string; workflow: string; fetch?: typeof fetch }, signal?: AbortSignal) {
  const origin = baseUrl(options.baseUrl), fetcher = options.fetch ?? fetch;
  if (new TextEncoder().encode(options.workflow).byteLength > 1_048_576) throw new Error('The workflow exceeds 1 MiB.');
  let workflow: unknown;
  try { workflow = JSON.parse(options.workflow); } catch { throw new Error('Upload a valid ComfyUI API-format JSON workflow.'); }
  if (!object(workflow) || !Object.keys(workflow).length || Object.keys(workflow).length > 2000
    || !Object.values(workflow).every((node) => object(node) && typeof node.class_type === 'string' && object(node.inputs))) {
    throw new Error('Use ComfyUI’s Export (API) workflow, not its visual editor JSON.');
  }
  const live = AbortSignal.any([AbortSignal.timeout(600_000), ...(signal ? [signal] : [])]);
  async function request(path: string, init: RequestInit = {}, maximum = 1_048_576, active = live) {
    active.throwIfAborted();
    let response: Response;
    try { response = await fetcher(`${origin}${path}`, { ...init, signal: active, credentials: 'omit', redirect: 'error', cache: 'no-store' }); }
    catch (error) { active.throwIfAborted(); throw new Error('Cannot reach local ComfyUI. Check its loopback origin and CORS settings; no proxy fallback is used.', { cause: error }); }
    const bytes = await bounded(response, maximum, active); active.throwIfAborted(); return bytes;
  }
  async function json(path: string, init?: RequestInit): Promise<unknown> {
    const bytes = await request(path, init);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
    catch { throw new Error('ComfyUI returned invalid JSON.'); }
  }
  const queued = await json('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }) });
  if (!object(queued) || typeof queued.prompt_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(queued.prompt_id)) throw new Error('ComfyUI did not acknowledge a workflow ID. Check its queue before retrying.');
  const jobId = queued.prompt_id;
  let images: { filename: string; subfolder: string; type: string }[] = [];
  while (true) {
    const history = await json(`/history/${encodeURIComponent(jobId)}`);
    const entry = object(history) ? history[jobId] : undefined;
    if (object(entry) && object(entry.status)) {
      if (entry.status.status_str === 'error') throw new Error('The owned ComfyUI workflow failed. Check its node errors on the local server.');
      if (entry.status.completed === true) {
        const outputs = object(entry.outputs) ? Object.values(entry.outputs) : [];
        const values = outputs.flatMap((output) => object(output) && Array.isArray(output.images) ? output.images : []);
        for (const value of values) {
          if (!object(value) || typeof value.filename !== 'string' || !value.filename || value.filename.length > 512 || /[\\/\0]/.test(value.filename)
            || ['.', '..'].includes(value.filename) || typeof value.subfolder !== 'string' || value.subfolder.length > 512 || /[\\\0]/.test(value.subfolder)
            || (value.subfolder && value.subfolder.split('/').some((part) => !part || part === '.' || part === '..'))
            || value.type !== 'output') throw new Error('ComfyUI returned an unsafe or unsupported output image locator.');
          images.push({ filename: value.filename, subfolder: value.subfolder, type: value.type });
        }
        if (!images.length || images.length > 16) throw new Error('The completed workflow must provide 1–16 saved output images.');
        break;
      }
    }
    await pause(live);
  }
  images = images.map((image) => Object.freeze({ ...image }));
  return { jobId, origin, images: images.map((image) => ({ ...image })), async readImage(index: number, readSignal?: AbortSignal) {
    const reading = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : []), ...(readSignal ? [readSignal] : [])]); reading.throwIfAborted();
    const image = images[index]; if (!Number.isInteger(index) || !image) throw new Error('Select an image from this owned workflow.');
    const bytes = await request(`/view?${new URLSearchParams(image)}`, {}, imageLimit, reading);
    // Foundry exposes PNG detection, but not its internal JPEG helper. A JPEG
    // signature selects the decoder/MIME; actual decoding below verifies bytes.
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const type = isPNG(bytes) ? 'image/png' : jpeg ? 'image/jpeg' : null;
    if (!type) throw new Error('ComfyUI output is not a PNG or JPEG image. No asset was staged.');
    const file = new File([bytes], `comfy-${jobId}-${index}.${type === 'image/png' ? 'png' : 'jpg'}`, { type });
    const decoded = await createImageBitmap(file).catch(() => { throw new Error('ComfyUI returned an invalid raster image. No asset was staged.'); });
    try { if (!decoded.width || !decoded.height || decoded.width * decoded.height > 40_000_000) throw new Error('ComfyUI image dimensions exceed the preview limit.'); }
    finally { decoded.close(); }
    reading.throwIfAborted(); return file;
  } };
}
