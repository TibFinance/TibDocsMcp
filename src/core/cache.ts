// The disk cache: index.json and the pages, stored by sha256 in one folder. It is only ever a copy of what the
// site served: a page is checked against its sha256 again when it is read back, and the folder is pruned to the
// pages of the current index at each refresh. A failure to write is logged and changes nothing else.
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from './text.ts';

const INDEX_FILE = 'index.json';
const META_FILE = 'index-meta.json';
const PAGES_FOLDER = 'pages';
const PAGE_FILE = /^([0-9a-f]{64})\.md$/;

export interface StoredIndex {
  text: string;
  /** When the site last gave or confirmed this index (milliseconds since 1970). */
  checkedAt: number;
  etag: string | null;
  lastModified: string | null;
}

export class DiskCache {
  constructor(
    readonly dir: string,
    private readonly origin: string,
    private readonly log: (line: string) => void,
  ) {}

  readIndex(): StoredIndex | null {
    try {
      const meta = JSON.parse(readFileSync(join(this.dir, META_FILE), 'utf8')) as Record<string, unknown>;
      // A copy taken from another origin is never served for this one.
      if (meta['origin'] !== this.origin || typeof meta['checkedAt'] !== 'number') {
        return null;
      }
      const text = readFileSync(join(this.dir, INDEX_FILE), 'utf8');
      if (sha256Hex(text) !== meta['sha256']) {
        return null;
      }
      return {
        text,
        checkedAt: meta['checkedAt'],
        etag: typeof meta['etag'] === 'string' ? meta['etag'] : null,
        lastModified: typeof meta['lastModified'] === 'string' ? meta['lastModified'] : null,
      };
    } catch {
      return null;
    }
  }

  writeIndex(stored: StoredIndex): void {
    const meta = { origin: this.origin, checkedAt: stored.checkedAt, etag: stored.etag, lastModified: stored.lastModified, sha256: sha256Hex(stored.text) };
    this.attempt('the index', () => {
      mkdirSync(this.dir, { recursive: true });
      this.writeAtomically(join(this.dir, INDEX_FILE), stored.text);
      this.writeAtomically(join(this.dir, META_FILE), `${JSON.stringify(meta)}\n`);
    });
  }

  readPage(sha256: string): string | null {
    try {
      const text = readFileSync(join(this.dir, PAGES_FOLDER, `${sha256}.md`), 'utf8');
      return sha256Hex(text) === sha256 ? text : null;
    } catch {
      return null;
    }
  }

  writePage(sha256: string, text: string): void {
    this.attempt('a page', () => {
      const folder = join(this.dir, PAGES_FOLDER);
      mkdirSync(folder, { recursive: true });
      this.writeAtomically(join(folder, `${sha256}.md`), text);
    });
  }

  /** Removes the stored pages that the current index no longer names. Only files named "<sha256>.md" are touched. */
  prune(keep: ReadonlySet<string>): number {
    let removed = 0;
    this.attempt('the old pages', () => {
      const folder = join(this.dir, PAGES_FOLDER);
      let names: string[];
      try {
        names = readdirSync(folder);
      } catch {
        return;
      }
      for (const name of names) {
        const match = PAGE_FILE.exec(name);
        if (match !== null && match[1] !== undefined && !keep.has(match[1])) {
          unlinkSync(join(folder, name));
          removed += 1;
        }
      }
    });
    return removed;
  }

  /** For --check: whether a file can be written in the folder. */
  writable(): { ok: true } | { ok: false; reason: string } {
    try {
      mkdirSync(this.dir, { recursive: true });
      const probe = join(this.dir, `write-check.${process.pid}.tmp`);
      writeFileSync(probe, 'tib-docs-mcp\n');
      unlinkSync(probe);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error && 'code' in error ? String(error.code) : 'unknown reason' };
    }
  }

  private writeAtomically(file: string, text: string): void {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, text, 'utf8');
    renameSync(temporary, file);
  }

  private attempt(what: string, write: () => void): void {
    try {
      write();
    } catch (error) {
      this.log(`the cache could not keep ${what} in ${this.dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
