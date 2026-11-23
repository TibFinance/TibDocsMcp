// The model of the site's /llms/index.json: the doc build, the SDK versions and the pieces (one per page).
//
// Schema. A missing "schema" reads as 1. Additive changes keep 1 (a new field, new pieces, a new kind): they are
// read without a new release of this program. Any other schema is one this version cannot read.
import { isAllowedAddress } from './address.ts';
import { DocsError } from './errors.ts';

export const KNOWN_SCHEMA = 1;

export type Language = 'eng' | 'fr';
export const LANGUAGES: readonly Language[] = ['eng', 'fr'];
/** Samples are one file for both languages. */
export const SHARED = 'shared';

export interface Piece {
  id: string;
  kind: string;
  language: string;
  title: string;
  line: string;
  address: string;
  sha256: string;
  characters: number;
  section: string | null;
  /** Per method: SDK language to sample address. */
  samples: Record<string, string>;
  /** Per method: the SDK languages without a checked sample. */
  samplesLeftOut: string[];
}

export interface DocIndex {
  schema: number;
  docBuild: number;
  docDate: string;
  docCommit: string;
  sdks: { name: string; tag: string }[];
  indexes: Record<string, string>;
  pieces: Piece[];
  /** Pieces left out because a field or an address broke the rules. */
  refused: number;
}

/** The sentence for an index this version cannot use. The install page is named by the caller. */
export function unreadableIndex(installPage: string): DocsError {
  return new DocsError('unreadable-index', `This version of tib-docs-mcp cannot read the site's index; get the latest version from ${installPage}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parsePiece(raw: unknown): Piece | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = text(raw['id']);
  const kind = text(raw['kind']);
  const language = text(raw['language']);
  const title = text(raw['title']);
  const address = text(raw['address']);
  const sha256 = text(raw['sha256']);
  const characters = raw['characters'];
  if (id === null || id === '' || kind === null || kind === '' || language === null || title === null || address === null || sha256 === null) {
    return null;
  }
  if (!isAllowedAddress(address) || !/^[0-9a-f]{64}$/.test(sha256) || typeof characters !== 'number' || !Number.isFinite(characters)) {
    return null;
  }
  const samples: Record<string, string> = {};
  if (isRecord(raw['samples'])) {
    for (const [sdk, sampleAddress] of Object.entries(raw['samples'])) {
      if (typeof sampleAddress === 'string' && isAllowedAddress(sampleAddress)) {
        samples[sdk] = sampleAddress;
      }
    }
  }
  const leftOut = Array.isArray(raw['samples_left_out']) ? raw['samples_left_out'].filter((sdk): sdk is string => typeof sdk === 'string') : [];
  return {
    id,
    kind,
    language,
    title,
    line: text(raw['line']) ?? '',
    address,
    sha256,
    characters,
    section: text(raw['section']),
    samples,
    samplesLeftOut: leftOut,
  };
}

/** Reads index.json. Throws the "cannot read" sentence for anything this version cannot use. */
export function parseIndex(body: string, installPage: string): DocIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw unreadableIndex(installPage);
  }
  if (!isRecord(raw)) {
    throw unreadableIndex(installPage);
  }
  const schema = raw['schema'] === undefined ? KNOWN_SCHEMA : raw['schema'];
  if (schema !== KNOWN_SCHEMA) {
    throw unreadableIndex(installPage);
  }
  const docBuild = raw['doc_build'];
  const docDate = text(raw['doc_date']);
  if (typeof docBuild !== 'number' || !Number.isInteger(docBuild) || docDate === null || !Array.isArray(raw['pieces'])) {
    throw unreadableIndex(installPage);
  }
  const sdks: { name: string; tag: string }[] = [];
  if (isRecord(raw['sdks'])) {
    for (const [name, value] of Object.entries(raw['sdks'])) {
      const tag = isRecord(value) ? text(value['tag']) : null;
      if (tag !== null) {
        sdks.push({ name, tag });
      }
    }
  }
  const indexes: Record<string, string> = {};
  if (isRecord(raw['indexes'])) {
    for (const [language, address] of Object.entries(raw['indexes'])) {
      if (typeof address === 'string' && isAllowedAddress(address)) {
        indexes[language] = address;
      }
    }
  }
  const pieces: Piece[] = [];
  let refused = 0;
  for (const entry of raw['pieces']) {
    const piece = parsePiece(entry);
    if (piece === null) {
      refused += 1;
    } else {
      pieces.push(piece);
    }
  }
  return { schema, docBuild, docDate, docCommit: text(raw['doc_commit']) ?? '', sdks, indexes, pieces, refused };
}

/** The name of a piece: its id after the kind ("method/GetPayment" gives "GetPayment"), without a sample suffix. */
export function nameOf(piece: Piece): string {
  const slash = piece.id.indexOf('/');
  const name = slash < 0 ? piece.id : piece.id.slice(slash + 1);
  const hash = name.indexOf('#');
  return hash < 0 ? name : name.slice(0, hash);
}
