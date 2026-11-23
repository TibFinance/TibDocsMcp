// Search over one language's pages (methods, guides, lists of values, and any kind added later; samples are left
// out, they repeat field names). Weights: the page's name and title, then its section headings, then its summary,
// then the names in its code spans, then the words of its body. Case, accents and CamelCase are folded, so "idempotency key" finds
// "IdempotencyKey". A small table folds the words a person uses for a task onto the API's own verbs and nouns
// ("read one payment" finds GetPayment; "supprimer un paiement" finds DeletePayment).
import { nameOf, type Piece } from './indexModel.ts';
import { fold } from './text.ts';

const STOP_WORDS = new Set(
  [
    // English
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'into', 'is', 'it', 'its', 'me', 'my',
    'of', 'on', 'one', 'or', 'that', 'the', 'their', 'this', 'to', 'use', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your', 'we', 'our',
    'should', 'would', 'will', 'call', 'api', 'tib', 'finance', 'method',
    // French
    'au', 'aux', 'avec', 'ce', 'ces', 'comment', 'dans', 'de', 'des', 'du', 'd', 'elle', 'en', 'est', 'et', 'il', 'je', 'l', 'la', 'le', 'les', 'leur',
    'ma', 'mes', 'mon', 'ne', 'nous', 'on', 'ou', 'par', 'pas', 'pour', 'qu', 'que', 'quel', 'quelle', 'qui', 's', 'sa', 'se', 'ses', 'son', 'sur',
    'un', 'une', 'vos', 'votre', 'vous', 'y', 'appel', 'methode', 'faire',
  ].map(fold),
);

// Words a person uses, folded onto the words the API's names are made of. Keys and values are folded and stemmed.
const SYNONYM_GROUPS: [string[], string][] = [
  [['read', 'fetch', 'retrieve', 'obtain', 'show', 'view', 'lookup', 'lire', 'obtenir', 'recuperer', 'consulter', 'afficher'], 'get'],
  [['make', 'add', 'new', 'creer', 'ajouter', 'nouveau', 'nouvelle'], 'create'],
  [['remove', 'erase', 'supprimer', 'effacer', 'retirer'], 'delete'],
  [['update', 'edit', 'modify', 'modifier', 'enregistrer', 'sauvegarder'], 'save'],
  [['all', 'every', 'lister', 'liste', 'tous', 'toutes'], 'list'],
  [['paiement', 'pay'], 'payment'],
  [['client'], 'customer'],
  [['marchand'], 'merchant'],
  [['facture', 'invoice'], 'bill'],
  [['fournisseur', 'vendor'], 'supplier'],
  [['portefeuille'], 'wallet'],
  [['virement', 'transfert'], 'transfer'],
  [['lot'], 'batch'],
  [['cle'], 'key'],
  [['erreur'], 'error'],
  [['connexion', 'signin'], 'login'],
  [['devise'], 'currency'],
  [['langue'], 'language'],
  [['statut', 'etat'], 'status'],
  [['fuseau'], 'zone'],
  [['facteur'], 'factor'],
  [['deux'], 'two'],
];

/** A plural made singular, the same way for the pages and the query. */
export function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.length > 4 && (word.endsWith('aux') || word.endsWith('eux'))) {
    return word.slice(0, -1);
  }
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) {
    return word.slice(0, -1);
  }
  return word;
}

const SYNONYMS = new Map<string, string>();
for (const [words, target] of SYNONYM_GROUPS) {
  for (const word of words) {
    SYNONYMS.set(stem(fold(word)), stem(fold(target)));
  }
}

const CAMEL = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u;

/** The raw words of a text: runs of letters and digits. */
function rawWords(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
}

/** The terms of a text: each word folded and stemmed, and for a CamelCase word its parts as well. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const word of rawWords(text)) {
    out.push(stem(fold(word)));
    const parts = word.split(CAMEL);
    if (parts.length > 1) {
      for (const part of parts) {
        out.push(stem(fold(part)));
      }
    }
  }
  return out;
}

function counts(list: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const term of list) {
    map.set(term, (map.get(term) ?? 0) + 1);
  }
  return map;
}

interface Entry {
  piece: Piece;
  name: string;
  foldedName: string;
  title: Set<string>;
  /** The parts of the page's name (GetPayment: get, payment): how much of it the query covers. */
  nameParts: string[];
  summary: Set<string>;
  headings: Set<string>;
  names: Map<string, number>;
  body: Map<string, number>;
  bodyLength: number;
  lines: string[];
}

export interface Hit {
  piece: Piece;
  score: number;
  /** The body line that matches the most words of the query, or null. */
  line: string | null;
}

/** One group of the query: a word and what it stands for. A group counts once, by its best member. */
type Group = string[];

const HEADER_LINE = /^TIB Finance API documentation · /;

function bodyLines(text: string): string[] {
  const lines = text.split('\n');
  // The first heading is the title, and the line under it is the page's own header: both are in other fields.
  return lines.filter((line, at) => !(at === 0 && line.startsWith('# ')) && !HEADER_LINE.test(line));
}

function codeSpanNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    if (match[1] !== undefined) {
      names.push(match[1]);
    }
  }
  return names;
}

export class SearchIndex {
  private readonly entries: Entry[];
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(pages: { piece: Piece; text: string }[]) {
    this.entries = pages.map(({ piece, text }) => {
      const lines = bodyLines(text);
      const name = nameOf(piece);
      const body = terms(lines.join('\n'));
      const nameParts = name.split(CAMEL).map((part) => stem(fold(part)));
      return {
        piece,
        name,
        foldedName: fold(name),
        title: new Set([...terms(piece.title), ...terms(name)]),
        nameParts,
        summary: new Set(terms(piece.line)),
        headings: new Set(lines.filter((line) => line.startsWith('#')).flatMap((line) => terms(line))),
        names: counts(codeSpanNames(lines.join('\n')).flatMap((span) => terms(span))),
        body: counts(body),
        bodyLength: body.length,
        lines: lines.filter((line) => line.trim().length > 0),
      };
    });
    for (const entry of this.entries) {
      const all = new Set([...entry.title, ...entry.summary, ...entry.names.keys(), ...entry.body.keys()]);
      for (const term of all) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
    }
    this.averageLength = this.entries.reduce((sum, entry) => sum + entry.bodyLength, 0) / Math.max(1, this.entries.length);
  }

  get size(): number {
    return this.entries.length;
  }

  private idf(term: string): number {
    const n = this.entries.length;
    const df = this.documentFrequency.get(term) ?? 0;
    return Math.log((n + 1) / (df + 0.5));
  }

  /** The query as groups of terms. Stop words are dropped unless nothing else is left. */
  static groupsOf(query: string): Group[] {
    const groups: Group[] = [];
    const words = rawWords(query);
    const content = words.filter((word) => !STOP_WORDS.has(fold(word)));
    for (const word of content.length > 0 ? content : words) {
      const whole = stem(fold(word));
      const group = new Set([whole]);
      const synonym = SYNONYMS.get(whole);
      if (synonym !== undefined) {
        group.add(synonym);
      }
      groups.push([...group]);
      const parts = word.split(CAMEL);
      if (parts.length > 1) {
        for (const part of parts) {
          groups.push([stem(fold(part))]);
        }
      }
    }
    return groups;
  }

  private bm25(tf: number, length: number): number {
    if (tf === 0) {
      return 0;
    }
    const k = 1.2;
    const b = 0.75;
    return (tf * (k + 1)) / (tf + k * (1 - b + (b * length) / Math.max(1, this.averageLength)));
  }

  search(query: string, options: { kind?: string | undefined; limit: number }): Hit[] {
    const groups = SearchIndex.groupsOf(query);
    if (groups.length === 0) {
      return [];
    }
    const foldedQuery = fold(query).replace(/[^\p{L}\p{N}]+/gu, '');
    const scored: Hit[] = [];
    for (const entry of this.entries) {
      if (options.kind !== undefined && entry.piece.kind !== options.kind) {
        continue;
      }
      let score = 0;
      let matched = 0;
      let inTitle = 0;
      const covered = new Set<string>();
      for (const group of groups) {
        let best = 0;
        if (group.some((term) => entry.title.has(term))) {
          inTitle += 1;
        }
        for (const term of group) {
          const weight =
            (entry.title.has(term) ? 8 : 0) +
            (entry.headings.has(term) ? 3 : 0) +
            (entry.summary.has(term) ? 3 : 0) +
            2 * this.bm25(entry.names.get(term) ?? 0, entry.bodyLength) +
            this.bm25(entry.body.get(term) ?? 0, entry.bodyLength);
          best = Math.max(best, weight * this.idf(term));
          if (entry.nameParts.includes(term)) {
            covered.add(term);
          }
        }
        if (best > 0) {
          matched += 1;
          score += best;
        }
      }
      if (score <= 0) {
        continue;
      }
      // Every word of the query found counts; so do the words found in the title, and how much of the page's name
      // the query covers (GetPayment before GetPaymentMethod for "read one payment").
      score *= 0.5 + (0.5 * matched) / groups.length;
      score *= 1 + (0.5 * inTitle) / groups.length;
      score += 4 * (covered.size / Math.max(1, entry.nameParts.length));
      if (foldedQuery === entry.foldedName || foldedQuery === fold(entry.piece.id).replace(/[^\p{L}\p{N}]+/gu, '')) {
        score += 100;
      }
      scored.push({ piece: entry.piece, score, line: SearchIndex.bestLine(entry, groups) });
    }
    scored.sort((one, other) => other.score - one.score || one.piece.id.localeCompare(other.piece.id));
    return scored.slice(0, options.limit);
  }

  /** The body line that matches the most groups; the summary line is shown already, so it is not repeated. */
  private static bestLine(entry: Entry, groups: Group[]): string | null {
    let best: string | null = null;
    let bestCount = 0;
    const summary = entry.piece.line.trim();
    for (const line of entry.lines) {
      if (line.trim() === summary) {
        continue;
      }
      const lineTerms = new Set(terms(line));
      const found = groups.filter((group) => group.some((term) => lineTerms.has(term))).length;
      if (found > bestCount) {
        best = line;
        bestCount = found;
      }
    }
    return best;
  }
}
