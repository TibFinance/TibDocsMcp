// Reads one address of the site. One origin (given by the entry point), the address rule, no redirect followed,
// a timeout, a size limit. Tests replace the network function, never the origin.
import { siteUrl } from './address.ts';
import { SiteUnavailable } from './errors.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type ReadResult =
  | { kind: 'ok'; text: string; etag: string | null; lastModified: string | null }
  | { kind: 'not-modified' }
  | { kind: 'missing'; why: 'not found' | 'an HTML page' };

export interface ReadOptions {
  maxBytes: number;
  etag?: string | null;
  lastModified?: string | null;
}

export interface ReaderOptions {
  origin: string;
  userAgent: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

export class SiteReader {
  readonly origin: string;
  private readonly userAgent: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ReaderOptions) {
    this.origin = options.origin;
    this.userAgent = options.userAgent;
    // Looked up at each call, not kept: the stand-in of the tests can be put in place after the core is made.
    this.fetchFn = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async read(address: string, options: ReadOptions): Promise<ReadResult> {
    const url = siteUrl(this.origin, address);
    // Accept is "*/*": the site's IIS answers 406 to a list of types that does not hold its configured type exactly,
    // with its charset ("text/markdown" does not match "text/markdown; charset=utf-8").
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      accept: '*/*',
    };
    if (options.etag) {
      headers['if-none-match'] = options.etag;
    }
    if (options.lastModified) {
      headers['if-modified-since'] = options.lastModified;
    }
    // The timeout is a timer of its own, which keeps the program alive until it fires (AbortSignal.timeout's does
    // not), and covers the whole read: the answer and its body.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), this.timeoutMs);
    try {
      return await this.readWithin(url, headers, options, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readWithin(url: string, headers: Record<string, string>, options: ReadOptions, signal: AbortSignal): Promise<ReadResult> {
    let response: Response;
    try {
      response = await this.fetchFn(url, { method: 'GET', headers, redirect: 'manual', signal });
    } catch (error) {
      throw new SiteUnavailable(failureReason(error, this.timeoutMs));
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400 && response.status !== 304)) {
      await discard(response);
      throw new SiteUnavailable('it answered with a redirect, which this program does not follow');
    }
    if (response.status === 304) {
      await discard(response);
      return { kind: 'not-modified' };
    }
    if (response.status === 404) {
      await discard(response);
      return { kind: 'missing', why: 'not found' };
    }
    if (response.status !== 200) {
      await discard(response);
      throw new SiteUnavailable(`it answered with the HTTP status ${response.status}`);
    }
    // The site answers its application page for an address it does not have: that is a missing page.
    if ((response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
      await discard(response);
      return { kind: 'missing', why: 'an HTML page' };
    }
    let bytes: Uint8Array;
    try {
      bytes = await readLimited(response, options.maxBytes);
    } catch (error) {
      if (error instanceof SiteUnavailable) {
        throw error;
      }
      throw new SiteUnavailable(failureReason(error, this.timeoutMs));
    }
    return {
      kind: 'ok',
      text: new TextDecoder('utf-8').decode(bytes),
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    };
  }
}

function failureReason(error: unknown, timeoutMs: number): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `no answer within ${timeoutMs / 1000} seconds`;
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
  const code = cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : null;
  return code === null ? 'no answer' : `no answer (${code})`;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to do: the answer is not used.
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = (): SiteUnavailable => new SiteUnavailable(`its answer was larger than ${Math.round(maxBytes / 1024)} KB`);
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(response);
    throw tooLarge();
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
