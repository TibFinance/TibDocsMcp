// What the site holds, kept fresh: index.json read again when older than 15 minutes (at the next call, no timer),
// and pages read once per sha256. Offline, the cache answers and says so.
import { INDEX_ADDRESS } from './address.ts';
import { DiskCache } from './cache.ts';
import { DocsError, SiteUnavailable } from './errors.ts';
import { parseIndex, unreadableIndex, type DocIndex, type Piece } from './indexModel.ts';
import { SiteReader, type FetchLike } from './reader.ts';
import { sha256Hex, toLf } from './text.ts';

export const INDEX_MAX_AGE_MS = 15 * 60 * 1000;
/** After a failed refresh, the cache answers without a new attempt for this long, so that a down site costs one try a minute. */
export const RETRY_AFTER_FAILURE_MS = 60 * 1000;
export const INDEX_MAX_BYTES = 1024 * 1024;
export const PAGE_MAX_BYTES = 256 * 1024;

export interface IndexState {
  index: DocIndex;
  /** When the site last gave or confirmed this index. */
  checkedAt: number;
  /** Set when the site could not be reached and the index is the cached one. */
  offline: { reason: string } | null;
}

export interface PageText {
  piece: Piece;
  text: string;
  state: IndexState;
}

export interface DocsOptions {
  origin: string;
  userAgent: string;
  /** The page that tells how to get the latest version of this program. */
  installPage: string;
  fetch?: FetchLike;
  now?: () => number;
  /** Null: memory only. */
  cacheDir?: string | null;
  log?: (line: string) => void;
  indexMaxAgeMs?: number;
  retryAfterFailureMs?: number;
  timeoutMs?: number;
}

interface Held {
  index: DocIndex;
  /** The index as read (LF), stored again with its new date after a 304. */
  text: string;
  checkedAt: number;
  etag: string | null;
  lastModified: string | null;
}

export class Docs {
  readonly origin: string;
  readonly host: string;
  readonly installPage: string;
  readonly cache: DiskCache | null;
  private readonly reader: SiteReader;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly indexMaxAgeMs: number;
  private readonly retryAfterFailureMs: number;
  private held: Held | null = null;
  private diskLooked = false;
  private lastFailure: { at: number; reason: string } | null = null;
  private inflight: Promise<IndexState> | null = null;
  private readonly pages = new Map<string, string>();

  constructor(options: DocsOptions) {
    this.origin = options.origin;
    this.host = new URL(options.origin).host;
    this.installPage = options.installPage;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.indexMaxAgeMs = options.indexMaxAgeMs ?? INDEX_MAX_AGE_MS;
    this.retryAfterFailureMs = options.retryAfterFailureMs ?? RETRY_AFTER_FAILURE_MS;
    this.reader = new SiteReader({
      origin: options.origin,
      userAgent: options.userAgent,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    this.cache = options.cacheDir === null || options.cacheDir === undefined ? null : new DiskCache(options.cacheDir, options.origin, this.log);
  }

  /** The sentence for a site that cannot be reached and nothing to serve instead. */
  private offlineError(reason: string): DocsError {
    return new DocsError('offline', `${this.host} could not be reached (${reason}), and no copy of the documentation is kept on this computer yet. Try again in a few minutes; the same pages are public at ${this.origin}/llms.txt.`);
  }

  /** The current index. `force`: read it from the site now, whatever its age (after a page did not match it). */
  currentIndex(force = false): Promise<IndexState> {
    if (this.inflight !== null) {
      return this.inflight;
    }
    this.inflight = this.refresh(force).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private stateOf(held: Held, offline: { reason: string } | null): IndexState {
    return { index: held.index, checkedAt: held.checkedAt, offline };
  }

  private fromDisk(): void {
    if (this.diskLooked || this.cache === null) {
      return;
    }
    this.diskLooked = true;
    const stored = this.cache.readIndex();
    if (stored === null) {
      return;
    }
    try {
      this.held = { index: parseIndex(stored.text, this.installPage), text: stored.text, checkedAt: stored.checkedAt, etag: stored.etag, lastModified: stored.lastModified };
    } catch {
      // A cached index this version cannot read is not served: the site is asked.
    }
  }

  private async refresh(force: boolean): Promise<IndexState> {
    const now = this.now();
    if (this.held === null) {
      this.fromDisk();
    }
    const held = this.held;
    if (held !== null && !force) {
      if (now - held.checkedAt < this.indexMaxAgeMs) {
        return this.stateOf(held, null);
      }
      if (this.lastFailure !== null && now - this.lastFailure.at < this.retryAfterFailureMs) {
        return this.stateOf(held, { reason: this.lastFailure.reason });
      }
    }
    let read;
    try {
      read = await this.reader.read(INDEX_ADDRESS, { maxBytes: INDEX_MAX_BYTES, etag: held?.etag ?? null, lastModified: held?.lastModified ?? null });
    } catch (error) {
      if (!(error instanceof SiteUnavailable)) {
        throw error;
      }
      this.lastFailure = { at: now, reason: error.reason };
      this.log(`the index could not be read: ${error.reason}`);
      if (held !== null) {
        return this.stateOf(held, { reason: error.reason });
      }
      throw this.offlineError(error.reason);
    }
    this.lastFailure = null;
    if (read.kind === 'not-modified' && held !== null) {
      held.checkedAt = now;
      this.cache?.writeIndex({ text: held.text, checkedAt: now, etag: held.etag, lastModified: held.lastModified });
      return this.stateOf(held, null);
    }
    if (read.kind !== 'ok') {
      throw unreadableIndex(this.installPage);
    }
    const body = toLf(read.text);
    const index = parseIndex(body, this.installPage);
    this.held = { index, text: body, checkedAt: now, etag: read.etag, lastModified: read.lastModified };
    if (this.cache !== null) {
      this.cache.writeIndex({ text: body, checkedAt: now, etag: read.etag, lastModified: read.lastModified });
      const removed = this.cache.prune(new Set(index.pieces.map((piece) => piece.sha256)));
      if (removed > 0) {
        this.log(`the cache let go of ${removed} pages the index no longer names`);
      }
    }
    return this.stateOf(this.held, null);
  }


  /** A piece of the given index with the same id and language, if any. */
  private static sameIn(index: DocIndex, piece: Piece): Piece | null {
    return index.pieces.find((one) => one.id === piece.id && one.language === piece.language) ?? null;
  }

  private keep(piece: Piece, text: string): void {
    this.pages.set(piece.sha256, text);
    this.cache?.writePage(piece.sha256, text);
  }

  private cached(piece: Piece): string | null {
    const inMemory = this.pages.get(piece.sha256);
    if (inMemory !== undefined) {
      return inMemory;
    }
    const onDisk = this.cache?.readPage(piece.sha256) ?? null;
    if (onDisk !== null) {
      this.pages.set(piece.sha256, onDisk);
    }
    return onDisk;
  }

  /** The text of one piece, LF, checked against its sha256. */
  async pageText(piece: Piece, state: IndexState): Promise<PageText> {
    const cached = this.cached(piece);
    if (cached !== null) {
      return { piece, text: cached, state };
    }
    if (state.offline !== null) {
      throw new DocsError('offline', `${this.host} could not be reached (${state.offline.reason}), and this page is not in the cache yet: ${this.origin}${piece.address}. Try again in a few minutes.`);
    }
    return this.fetchPage(piece, state, true);
  }

  private async fetchPage(piece: Piece, state: IndexState, mayRetry: boolean): Promise<PageText> {
    let read;
    try {
      read = await this.reader.read(piece.address, { maxBytes: PAGE_MAX_BYTES });
    } catch (error) {
      if (!(error instanceof SiteUnavailable)) {
        throw error;
      }
      this.log(`${piece.address} could not be read: ${error.reason}`);
      throw new DocsError('offline', `${this.host} could not be reached (${error.reason}), and this page is not in the cache yet: ${this.origin}${piece.address}. Try again in a few minutes.`);
    }
    if (read.kind === 'ok') {
      const text = toLf(read.text);
      const got = sha256Hex(text);
      if (got === piece.sha256) {
        this.keep(piece, text);
        return { piece, text, state };
      }
      // The page does not match the index: the index is read once more, it is probably older than the page.
      if (mayRetry) {
        const newer = await this.currentIndex(true);
        const again = Docs.sameIn(newer.index, piece);
        if (again !== null && again.sha256 === got) {
          this.keep(again, text);
          return { piece: again, text, state: newer };
        }
      }
      this.log(`${piece.address} does not match the index`);
      throw new DocsError('updating', 'The site is being updated; try again in a few minutes.');
    }
    // A page the index names is missing: the index is read once more (it is probably newer).
    if (mayRetry) {
      const newer = await this.currentIndex(true);
      const again = Docs.sameIn(newer.index, piece);
      if (again !== null && again.sha256 !== piece.sha256) {
        return this.fetchPage(again, newer, false);
      }
      throw new NotInBuild(piece, newer);
    }
    throw new NotInBuild(piece, state);
  }

  /** Several pieces, 4 at a time. The ones that cannot be read are counted, not thrown. */
  async manyTexts(pieces: Piece[], state: IndexState, concurrency = 4): Promise<{ texts: Map<Piece, string>; failed: number }> {
    const texts = new Map<Piece, string>();
    let failed = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < pieces.length) {
        const piece = pieces[next];
        next += 1;
        if (piece === undefined) {
          continue;
        }
        try {
          const got = await this.pageText(piece, state);
          texts.set(piece, got.text);
        } catch (error) {
          if (!(error instanceof DocsError)) {
            throw error;
          }
          failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pieces.length) }, () => worker()));
    return { texts, failed };
  }
}

/** A page the index named and the site does not have, even after the index was read again. */
export class NotInBuild extends Error {
  constructor(
    readonly piece: Piece,
    readonly state: IndexState,
  ) {
    super(`no such page in doc build ${state.index.docBuild}: ${piece.address}`);
  }
}
