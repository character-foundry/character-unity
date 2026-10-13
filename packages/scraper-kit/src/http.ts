export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class ScrapeHttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ScrapeHttpError';
  }
}

export interface HttpOptions {
  fetch?: Fetch;
  /** Minimum time between request starts for this source. */
  minIntervalMs: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Waits before each retry of a transient failure (408, 425, 429, 5xx, network errors). */
  retryDelaysMs?: readonly number[];
  maxBytes?: number;
  /** Injected for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface HttpResponse { status: number; bytes: Uint8Array; type: string; url: string }
/** A request's own options: `timeoutMs` and `maxBytes` override the client's limits (e.g. for large downloads). */
export type RequestOptions = RequestInit & { timeoutMs?: number; maxBytes?: number };

const transient = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * One polite client per source and run: requests go out one at a time with a minimum spacing, transient
 * failures are retried with backoff (honouring a short Retry-After), and 4xx answers fail at once.
 */
export function createHttp(options: HttpOptions) {
  const fetcher = options.fetch ?? fetch;
  const wait = options.sleep ?? sleep;
  const delays = options.retryDelaysMs ?? [1_000, 3_000, 7_000];
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  let queue: Promise<unknown> = Promise.resolve();
  let lastStart = -Infinity;

  async function once(url: string, { timeoutMs, maxBytes: requestMax, ...init }: RequestOptions, requestSignal: AbortSignal): Promise<{ response: HttpResponse; retryAfter: string | null }> {
    const limit = requestMax ?? maxBytes;
    const gap = lastStart + options.minIntervalMs - Date.now();
    if (gap > 0) await wait(gap, requestSignal);
    requestSignal.throwIfAborted();
    lastStart = Date.now();
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs ?? options.timeoutMs ?? 30_000), requestSignal]);
    const headers = new Headers(options.headers);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const response = await fetcher(url, { redirect: 'follow', ...init, headers, signal });
    const tooLarge = () => new ScrapeHttpError(response.status, url, `Response from ${new URL(url).host} is larger than ${limit} bytes`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > limit) { void response.body?.cancel().catch(() => undefined); throw tooLarge(); }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      // Cancelling also settles an outstanding read when a source stalls between chunks.
      const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        signal.throwIfAborted();
        while (true) {
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw tooLarge();
          if (value.byteLength) chunks.push(value);
        }
      } catch (error) {
        // Do not wait for a misbehaving producer's cancellation to finish before rejecting.
        void reader.cancel(error).catch(() => undefined);
        throw error;
      } finally {
        signal.removeEventListener('abort', cancel);
        reader.releaseLock();
      }
    } else signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { response: { status: response.status, bytes, type: response.headers.get('content-type') ?? '', url: response.url || url }, retryAfter: response.headers.get('retry-after') };
  }

  async function request(url: string, init: RequestOptions = {}): Promise<HttpResponse> {
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), ...(init.signal ? [init.signal] : [])]);
    for (let attempt = 0; ; attempt++) {
      let result: Awaited<ReturnType<typeof once>> | undefined, failure: unknown;
      try { result = await once(url, init, signal); } catch (error) {
        if (signal.aborted || error instanceof ScrapeHttpError) throw error;
        failure = error;
      }
      const status = result?.response.status;
      if (result && status! < 400) return result.response;
      if (!(status === undefined || transient.has(status)) || attempt >= delays.length) {
        if (status !== undefined) throw new ScrapeHttpError(status, url, `${new URL(url).host} answered HTTP ${status}`);
        throw new ScrapeHttpError(0, url, `${new URL(url).host} did not answer`, { cause: failure });
      }
      const after = Number(result?.retryAfter);
      await wait(Number.isFinite(after) && after > 0 && after <= 60 ? after * 1000 : delays[attempt]!, signal);
    }
  }

  /** Serialised so concurrent callers still respect the spacing. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    request: (url: string, init?: RequestOptions) => serial(() => request(url, init)),
    async json<T = unknown>(url: string, init?: RequestOptions): Promise<T> {
      const response = await serial(() => request(url, init));
      try { return JSON.parse(new TextDecoder().decode(response.bytes)) as T; }
      catch (error) { throw new ScrapeHttpError(response.status, url, `${new URL(url).host} did not return JSON`, { cause: error }); }
    },
    async text(url: string, init?: RequestOptions) {
      return new TextDecoder().decode((await serial(() => request(url, init))).bytes);
    },
  };
}
export type Http = ReturnType<typeof createHttp>;
