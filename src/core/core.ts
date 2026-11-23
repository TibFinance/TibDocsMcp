// The five answers, made from the site's text door. No MCP code here: tools.ts turns each Reply into a tool result.
// The core is given the site's ORIGIN by its entry point; it holds no address of its own.
import { INDEX_ADDRESS, ROOT_LIST_ADDRESS, checkedOrigin, isAllowedAddress } from './address.ts';
import { Docs, NotInBuild, type DocsOptions, type IndexState } from './docs.ts';
import { DocsError } from './errors.ts';
import { SHARED, nameOf, type DocIndex, type Language, type Piece } from './indexModel.ts';
import { capped, fitTo, firstCell, headerLine, partsOf, sectionsOf, tablesOf, type Reply, type ReplyData } from './replies.ts';
import { SearchIndex } from './search.ts';
import { absoluteLinks, count, cut, fold } from './text.ts';

export const OVERVIEW_PAGE_SIZE = 100;
export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 20;
export const SEARCH_CAP = 10_000;
export const ERROR_CODE_CAP = 6_000;
const SUMMARY_LENGTH = 160;
const LINE_LENGTH = 240;

export const SDKS = ['csharp', 'java', 'python', 'php', 'javascript', 'nodejs'] as const;
export type Sdk = (typeof SDKS)[number];
const SDK_NAMES: Record<string, Sdk> = {
  csharp: 'csharp', 'c#': 'csharp', cs: 'csharp', '.net': 'csharp', dotnet: 'csharp', net: 'csharp',
  java: 'java',
  python: 'python', py: 'python',
  php: 'php',
  javascript: 'javascript', js: 'javascript', browser: 'javascript',
  nodejs: 'nodejs', node: 'nodejs', 'node.js': 'nodejs',
};
/** How a method page names each SDK language in its "Request example" list. */
const SDK_LABELS: Record<Sdk, string> = { csharp: 'C#', java: 'Java', python: 'Python', php: 'PHP', javascript: 'JavaScript', nodejs: 'Node.js' };

const KIND_LABELS: Record<string, string> = { guide: 'Guides', method: 'Methods', values: 'Lists of values', sample: 'Samples' };
const KIND_ORDER = ['start-here', 'guide', 'howto', 'method', 'values'];
const KIND_NAMES: Record<string, string> = { methods: 'method', guides: 'guide', value: 'values', enum: 'values', enums: 'values', samples: 'sample' };

export interface CoreOptions extends Omit<DocsOptions, 'origin'> {
  origin: string;
  defaultLanguage: Language;
}

function isRecordKey<T extends string>(table: Record<string, T>, key: string): key is keyof typeof table & string {
  return Object.hasOwn(table, key);
}

export function languageOf(input: string | undefined, fallback: Language): Language | null {
  if (input === undefined || input.trim() === '') {
    return fallback;
  }
  const value = fold(input.trim());
  if (['en', 'eng', 'english', 'anglais'].includes(value)) {
    return 'eng';
  }
  if (['fr', 'fra', 'fre', 'french', 'francais'].includes(value)) {
    return 'fr';
  }
  return null;
}

export function sdkOf(input: string): Sdk | null {
  const value = input.trim().toLowerCase().replace(/\s+/g, '');
  return isRecordKey(SDK_NAMES, value) ? (SDK_NAMES[value] ?? null) : null;
}

function kindOrder(kind: string): number {
  const at = KIND_ORDER.indexOf(kind);
  return at < 0 ? KIND_ORDER.length : at;
}

function levenshtein(one: string, other: string): number {
  const previous = Array.from({ length: other.length + 1 }, (_, at) => at);
  for (let i = 1; i <= one.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= other.length; j += 1) {
      const above = previous[j] ?? 0;
      previous[j] = Math.min(above + 1, (previous[j - 1] ?? 0) + 1, diagonal + (one[i - 1] === other[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[other.length] ?? 0;
}

export class DocsCore {
  readonly docs: Docs;
  readonly origin: string;
  readonly defaultLanguage: Language;
  private searchIndexes = new Map<string, { key: string; search: SearchIndex; failed: number; total: number }>();

  constructor(options: CoreOptions) {
    this.origin = checkedOrigin(options.origin);
    this.defaultLanguage = options.defaultLanguage;
    this.docs = new Docs({ ...options, origin: this.origin });
  }

  // ---- shared pieces of a reply ----

  private header(state: IndexState, language: string, address: string): string {
    return headerLine(state, this.docs.host, language, `${this.origin}${address}`);
  }

  private reply(state: IndexState, language: string, address: string, body: string, data: Partial<ReplyData> = {}): Reply {
    const text = capped(`${this.header(state, language, address)}\n\n${absoluteLinks(body, this.origin)}`);
    return { text, data: { id: null, doc_build: state.index.docBuild, address: `${this.origin}${address}`, language, ...data }, isError: false };
  }

  static failure(sentence: string): Reply {
    return { text: sentence, data: { id: null, doc_build: null, address: null, language: null }, isError: true };
  }

  private listAddress(index: DocIndex, language: Language): string {
    return index.indexes[language] ?? ROOT_LIST_ADDRESS;
  }

  private badLanguage(input: string | undefined): Reply {
    return DocsCore.failure(`The language ${JSON.stringify(input)} is not one of the documentation's: use "en" for English or "fr" for French.`);
  }

  /** The 5 names closest to what was asked, among the pages of a language (samples left out). */
  private closest(index: DocIndex, asked: string, language: Language, kinds: string[] | null = null): string[] {
    const wanted = fold(asked).replace(/^.*\//, '').replace(/\.md$/, '').replace(/[^\p{L}\p{N}]+/gu, '');
    const names = new Map<string, number>();
    for (const piece of index.pieces) {
      if (piece.language !== language || piece.kind === 'sample' || (kinds !== null && !kinds.includes(piece.kind))) {
        continue;
      }
      const name = nameOf(piece);
      const folded = fold(name);
      const distance = wanted !== '' && (folded.includes(wanted) || wanted.includes(folded)) ? 0.25 : levenshtein(wanted, folded) / Math.max(wanted.length, folded.length, 1);
      if (!names.has(name) || (names.get(name) ?? 1) > distance) {
        names.set(name, distance);
      }
    }
    return [...names.entries()]
      .sort((one, other) => one[1] - other[1] || one[0].localeCompare(other[0]))
      .slice(0, 5)
      .map(([name]) => name);
  }

  /** Turns a failure of the core into its sentence; anything else is thrown on. */
  private async guarded(work: () => Promise<Reply>): Promise<Reply> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DocsError) {
        return DocsCore.failure(error.sentence);
      }
      if (error instanceof NotInBuild) {
        const language = error.piece.language === SHARED ? this.defaultLanguage : (error.piece.language as Language);
        const names = this.closest(error.state.index, nameOf(error.piece), language);
        return DocsCore.failure(`No such page in doc build ${error.state.index.docBuild}: ${this.origin}${error.piece.address}. Closest names: ${names.join(', ')}.`);
      }
      throw error;
    }
  }

  // ---- tib_docs_overview ----

  overview(input: { language?: string | undefined; kind?: string | undefined; cursor?: string | undefined }): Promise<Reply> {
    return this.guarded(async () => {
      const language = languageOf(input.language, this.defaultLanguage);
      if (language === null) {
        return this.badLanguage(input.language);
      }
      const state = await this.docs.currentIndex();
      if (input.kind === undefined || input.kind.trim() === '') {
        return this.reply(state, language, this.listAddress(state.index, language), this.overviewText(state.index, language));
      }
      return this.overviewOfKind(state, language, input.kind, input.cursor);
    });
  }

  private overviewText(index: DocIndex, language: Language): string {
    const other = language === 'eng' ? 'fr (French)' : 'en (English)';
    const lines = [
      `TIB Finance API documentation, doc build ${index.docBuild} of ${index.docDate}${index.docCommit === '' ? '' : ` (commit ${index.docCommit.slice(0, 7)})`}. These pages: ${language}; also in ${other}.`,
      `SDK versions: ${index.sdks.map((sdk) => `${sdk.name} ${sdk.tag}`).join(', ')}.`,
      '',
      'How to use the tools:',
      '- tib_docs_search: words or a task ("read one payment", "idempotency key", "2003") give the best pages.',
      '- tib_docs_get_page: one page by name (CreatePayment, ErrorCodes, CurrencyEnum), by id (method/CreatePayment) or by a link from another page.',
      '- tib_docs_get_sample: the request example of one method for one SDK (csharp, java, python, php, javascript, nodejs).',
      '- tib_docs_get_error_code: the rows of an ErrorCode in the error guides, and how a response reports an error.',
      '- tib_docs_overview with kind (guide, method or values): each page of that kind with its one-line summary.',
      '- language: en or fr on every tool but tib_docs_get_sample. A page has the same name in both languages.',
    ];
    const pages = index.pieces.filter((piece) => piece.language === language);
    const kinds = [...new Set(pages.map((piece) => piece.kind))].sort((one, other) => kindOrder(one) - kindOrder(other) || one.localeCompare(other));
    for (const kind of kinds) {
      const ofKind = pages.filter((piece) => piece.kind === kind);
      const label = KIND_LABELS[kind] ?? kind;
      lines.push('');
      const withSections = ofKind.some((piece) => piece.section !== null);
      if (withSections) {
        lines.push(`${label} (${ofKind.length}), by section:`);
        const sections = [...new Set(ofKind.map((piece) => piece.section ?? ''))].sort((one, other) => one.localeCompare(other, language));
        for (const section of sections) {
          const names = ofKind.filter((piece) => (piece.section ?? '') === section).map(nameOf).sort();
          lines.push(`- ${section === '' ? 'Other' : section}: ${names.join(', ')}`);
        }
      } else {
        const names = ofKind.map((piece) => (nameOf(piece) === piece.title ? nameOf(piece) : `${nameOf(piece)} (${piece.title})`)).sort();
        lines.push(`${label} (${ofKind.length}): ${names.join(', ')}`);
      }
    }
    const samples = index.pieces.filter((piece) => piece.kind === 'sample').length;
    if (samples > 0) {
      lines.push('', `Samples: ${count(samples)} request examples, one per method and SDK language: use tib_docs_get_sample.`);
    }
    return lines.join('\n');
  }

  private overviewOfKind(state: IndexState, language: Language, askedKind: string, cursor: string | undefined): Reply {
    const index = state.index;
    const wanted = askedKind.trim().toLowerCase();
    const kind = KIND_NAMES[wanted] ?? wanted;
    const known = [...new Set(index.pieces.map((piece) => piece.kind))].sort((one, other) => kindOrder(one) - kindOrder(other) || one.localeCompare(other));
    if (!known.includes(kind)) {
      return DocsCore.failure(`There is no kind ${JSON.stringify(askedKind)} in doc build ${index.docBuild}: the kinds are ${known.join(', ')}.`);
    }
    const pages = index.pieces
      .filter((piece) => piece.kind === kind && (piece.language === language || piece.language === SHARED))
      .sort((one, other) => one.id.localeCompare(other.id));
    const start = cursor === undefined || cursor.trim() === '' ? 0 : Number(cursor);
    if (!Number.isInteger(start) || start < 0 || start >= Math.max(1, pages.length)) {
      return DocsCore.failure(`The cursor ${JSON.stringify(cursor)} is not one this tool gave: call tib_docs_overview with kind ${JSON.stringify(kind)} and no cursor to start again.`);
    }
    const slice = pages.slice(start, start + OVERVIEW_PAGE_SIZE);
    const end = start + slice.length;
    const lines = [`${KIND_LABELS[kind] ?? kind}: ${start + 1} to ${end} of ${pages.length}.`, ''];
    for (const piece of slice) {
      const title = nameOf(piece) === piece.title ? '' : ` (${piece.title})`;
      lines.push(`- ${piece.id}${title}${piece.line === '' ? '' : `: ${cut(piece.line, SUMMARY_LENGTH)}`}`);
    }
    const data: Partial<ReplyData> = {};
    if (end < pages.length) {
      lines.push('', `More: call tib_docs_overview with kind ${JSON.stringify(kind)} and cursor "${end}".`);
    }
    return this.reply(state, kind === 'sample' ? SHARED : language, this.listAddress(index, language), lines.join('\n'), data);
  }

  // ---- tib_docs_search ----

  private async searchIndexFor(state: IndexState, language: Language): Promise<{ search: SearchIndex; failed: number; total: number }> {
    const pieces = state.index.pieces.filter((piece) => piece.language === language && piece.kind !== 'sample');
    const key = pieces.map((piece) => piece.sha256).join(',');
    const held = this.searchIndexes.get(language);
    if (held !== undefined && held.key === key) {
      return held;
    }
    const { texts, failed } = await this.docs.manyTexts(pieces, state);
    const search = new SearchIndex(pieces.filter((piece) => texts.has(piece)).map((piece) => ({ piece, text: texts.get(piece) ?? '' })));
    const built = { key, search, failed, total: pieces.length };
    // A search made while some pages could not be read is built again at the next search.
    if (failed === 0) {
      this.searchIndexes.set(language, built);
    }
    return built;
  }

  search(input: { query: string; language?: string | undefined; kind?: string | undefined; limit?: number | undefined }): Promise<Reply> {
    return this.guarded(async () => {
      const query = input.query.trim();
      if (query.length < 2 || query.length > 200) {
        return DocsCore.failure('The query is 2 to 200 characters: a few words, a method name or an error code.');
      }
      const language = languageOf(input.language, this.defaultLanguage);
      if (language === null) {
        return this.badLanguage(input.language);
      }
      const limit = input.limit ?? SEARCH_DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
        return DocsCore.failure(`limit is a whole number from 1 to ${SEARCH_MAX_LIMIT}.`);
      }
      const state = await this.docs.currentIndex();
      let kind: string | undefined;
      if (input.kind !== undefined && input.kind.trim() !== '') {
        const wanted = input.kind.trim().toLowerCase();
        kind = KIND_NAMES[wanted] ?? wanted;
        if (kind === 'sample') {
          return DocsCore.failure('Samples are not searched: they repeat the field names of their method. Search for the method, then use tib_docs_get_sample.');
        }
        const known = [...new Set(state.index.pieces.filter((piece) => piece.kind !== 'sample').map((piece) => piece.kind))].sort();
        if (!known.includes(kind)) {
          return DocsCore.failure(`There is no kind ${JSON.stringify(input.kind)} to search in doc build ${state.index.docBuild}: the kinds are ${known.join(', ')}.`);
        }
      }
      const { search, failed, total } = await this.searchIndexFor(state, language);
      if (search.size === 0) {
        throw new DocsError('offline', `None of the ${total} pages could be read from ${this.docs.host}, so nothing can be searched. Try again in a few minutes.`);
      }
      const hits = search.search(query, { kind, limit });
      const lines = [`Search: ${JSON.stringify(query)} in ${total} pages (${language})${kind === undefined ? '' : `, kind ${kind}`}.`];
      if (failed > 0) {
        lines.push(`The search is partial: ${failed} of the ${total} pages could not be read.`);
      }
      lines.push('');
      if (hits.length === 0) {
        lines.push(`No page matches ${JSON.stringify(query)}. Try other words, or tib_docs_overview for the list of pages.`);
      }
      const head = `${this.header(state, language, this.listAddress(state.index, language))}\n\n`;
      let used = head.length + lines.join('\n').length + 200;
      let shown = 0;
      for (const [at, hit] of hits.entries()) {
        const title = nameOf(hit.piece) === hit.piece.title ? '' : ` (${hit.piece.title})`;
        const entry = [`${at + 1}. ${hit.piece.id}${title} · ${hit.piece.kind}`];
        if (hit.piece.line !== '') {
          entry.push(`   ${cut(hit.piece.line, SUMMARY_LENGTH)}`);
        }
        if (hit.line !== null) {
          entry.push(`   Matching line: ${cut(hit.line, LINE_LENGTH)}`);
        }
        const block = entry.join('\n');
        if (used + block.length + 1 > SEARCH_CAP - 120) {
          lines.push(`More pages match: narrow the words to see them.`);
          break;
        }
        lines.push(block);
        used += block.length + 1;
        shown += 1;
      }
      if (shown > 0) {
        lines.push('', 'Read a page with tib_docs_get_page and its id.');
      }
      return this.reply(state, language, this.listAddress(state.index, language), lines.join('\n'));
    });
  }

  // ---- tib_docs_get_page ----

  private resolve(index: DocIndex, asked: string, language: Language): { piece: Piece } | { refused: string } | null {
    let ref = asked.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
      let url: URL;
      try {
        url = new URL(ref);
      } catch {
        return { refused: `${JSON.stringify(asked)} is not an address of the documentation.` };
      }
      if (url.origin !== this.origin || url.search !== '' || url.hash !== '') {
        return { refused: `Only the pages of ${this.origin}/llms/ are served; ${JSON.stringify(asked)} is not one.` };
      }
      ref = url.pathname;
    }
    if (ref.startsWith('/')) {
      if (!isAllowedAddress(ref)) {
        return { refused: `${JSON.stringify(asked)} is not an address of the documentation's pages.` };
      }
      if (ref === ROOT_LIST_ADDRESS || ref === INDEX_ADDRESS || Object.values(index.indexes).includes(ref)) {
        return { refused: 'That is the list of all pages: use tib_docs_overview, or tib_docs_search to find a page.' };
      }
      const piece = index.pieces.find((one) => one.address === ref) ?? index.pieces.find((one) => one.address.toLowerCase() === ref.toLowerCase());
      return piece === undefined ? null : { piece };
    }
    const wanted = ref.toLowerCase().replace(/\.md$/, '');
    const inLanguage = (piece: Piece): boolean => piece.language === language || piece.language === SHARED;
    const byId = index.pieces.filter((piece) => piece.id.toLowerCase() === wanted);
    const idMatch = byId.find(inLanguage) ?? byId[0];
    if (idMatch !== undefined) {
      return { piece: idMatch };
    }
    const byName = index.pieces
      .filter((piece) => piece.kind !== 'sample' && nameOf(piece).toLowerCase() === wanted)
      .sort((one, other) => kindOrder(one.kind) - kindOrder(other.kind) || (KIND_ORDER.includes(one.kind) ? 0 : one.kind.localeCompare(other.kind)));
    const nameMatch = byName.find(inLanguage) ?? byName[0];
    return nameMatch === undefined ? null : { piece: nameMatch };
  }

  getPage(input: { page: string; language?: string | undefined; part?: number | undefined }): Promise<Reply> {
    return this.guarded(async () => {
      const language = languageOf(input.language, this.defaultLanguage);
      if (language === null) {
        return this.badLanguage(input.language);
      }
      if (input.page.trim() === '' || input.page.length > 300) {
        return DocsCore.failure('page is a page name (CreatePayment, ErrorCodes, CurrencyEnum), an id (method/CreatePayment) or an address from a link.');
      }
      const state = await this.docs.currentIndex();
      const found = this.resolve(state.index, input.page, language);
      if (found === null) {
        const names = this.closest(state.index, input.page, language);
        return DocsCore.failure(`No page ${JSON.stringify(input.page.trim())} in doc build ${state.index.docBuild}. Closest names: ${names.join(', ')}.`);
      }
      if ('refused' in found) {
        return DocsCore.failure(found.refused);
      }
      const got = await this.docs.pageText(found.piece, state);
      const parts = partsOf(got.text);
      const part = input.part ?? 1;
      if (!Number.isInteger(part) || part < 1 || part > parts.length) {
        return DocsCore.failure(parts.length === 1 ? `${got.piece.id} comes in one part: call again without part.` : `part is a whole number from 1 to ${parts.length} for ${got.piece.id}.`);
      }
      const data: Partial<ReplyData> = { id: got.piece.id };
      let body = parts[part - 1] ?? '';
      if (parts.length > 1) {
        data.part = part;
        data.parts = parts.length;
        const next = part < parts.length ? ` The next: tib_docs_get_page with page ${JSON.stringify(got.piece.id)} and part ${part + 1}.` : '';
        body = `Part ${part} of ${parts.length} of ${got.piece.id}.${next}\n\n${body}`;
      }
      return this.reply(got.state, got.piece.language, got.piece.address, body, data);
    });
  }

  // ---- tib_docs_get_sample ----

  getSample(input: { method: string; sdk: string }): Promise<Reply> {
    return this.guarded(async () => {
      const sdk = sdkOf(input.sdk);
      if (sdk === null) {
        return DocsCore.failure(`The SDK ${JSON.stringify(input.sdk)} is not one of the samples': use csharp, java, python, php, javascript or nodejs.`);
      }
      const state = await this.docs.currentIndex();
      const language = this.defaultLanguage;
      const wanted = input.method.trim().toLowerCase().replace(/^method\//, '').replace(/#.*$/, '');
      const methods = state.index.pieces.filter((piece) => piece.kind === 'method' && nameOf(piece).toLowerCase() === wanted);
      const method = methods.find((piece) => piece.language === language) ?? methods[0];
      if (method === undefined) {
        const names = this.closest(state.index, input.method, language, ['method']);
        return DocsCore.failure(`No method ${JSON.stringify(input.method.trim())} in doc build ${state.index.docBuild}. Closest names: ${names.join(', ')}.`);
      }
      const available = SDKS.filter((one) => method.samples[one] !== undefined);
      const address = method.samples[sdk];
      if (address !== undefined) {
        const sample = state.index.pieces.find((piece) => piece.address === address);
        if (sample !== undefined) {
          const got = await this.docs.pageText(sample, state);
          return this.reply(got.state, got.piece.language, got.piece.address, got.text, { id: got.piece.id });
        }
      }
      const name = nameOf(method);
      const others = available.length === 0 ? 'No SDK language has a sample for this method.' : `Samples exist for: ${available.join(', ')}.`;
      if (method.samplesLeftOut.includes(sdk)) {
        // The method page's own sentence for a language left out of the build.
        const page = await this.docs.pageText(method, state);
        const label = SDK_LABELS[sdk].toLowerCase();
        const sentence = page.text.split('\n').find((line) => {
          const item = line.replace(/^\s*-\s*/, '');
          return line.trimStart().startsWith('-') && !item.startsWith('[') && item.toLowerCase().startsWith(label) && /^\s*:/.test(item.slice(label.length));
        });
        const body = `${name}, ${sentence === undefined ? `${SDK_LABELS[sdk]}: no checked sample exists for this language.` : sentence.replace(/^\s*-\s*/, '')}\n${others}`;
        return this.reply(page.state, page.piece.language, page.piece.address, body, { id: method.id });
      }
      return this.reply(state, method.language, method.address, `${name}: no ${SDK_LABELS[sdk]} sample is listed in doc build ${state.index.docBuild}.\n${others}`, { id: method.id });
    });
  }

  // ---- tib_docs_get_error_code ----

  getErrorCode(input: { code: number | string; language?: string | undefined }): Promise<Reply> {
    return this.guarded(async () => {
      const language = languageOf(input.language, this.defaultLanguage);
      if (language === null) {
        return this.badLanguage(input.language);
      }
      const code = typeof input.code === 'number' ? input.code : Number(String(input.code).trim());
      if (!Number.isInteger(code) || Math.abs(code) > 99_999) {
        return DocsCore.failure('code is the number of an ErrorCode, for example 2003.');
      }
      const state = await this.docs.currentIndex();
      const find = (name: string): Piece | undefined => state.index.pieces.find((piece) => piece.kind === 'guide' && nameOf(piece) === name && piece.language === language);
      const main = find('ErrorCodes');
      if (main === undefined) {
        return DocsCore.failure(`The Error codes guide is not in doc build ${state.index.docBuild}; search the documentation with tib_docs_search.`);
      }
      const guides = [main, find('TransferBatchErrorCodes')].filter((piece): piece is Piece => piece !== undefined);
      const texts = await Promise.all(guides.map((piece) => this.docs.pageText(piece, state)));
      const wanted = String(code);
      const blocks: string[] = [];
      let lastState = state;
      for (const got of texts) {
        lastState = got.state;
        for (const table of tablesOf(got.text)) {
          const rows = table.rows.filter((row) => firstCell(row) === wanted);
          if (rows.length > 0) {
            blocks.push(`## ${got.piece.title} › ${table.section}\n\n${table.header}\n${table.separator}\n${rows.join('\n')}`);
          }
        }
        // The guide's own advice for the code, where it gives one as a list item that starts with the code.
        const bold = new RegExp(`^- \\*\\*${wanted.replace('-', '\\-')}\\*\\*`);
        for (const section of sectionsOf(got.text)) {
          const items = section.body.split('\n').filter((line) => bold.test(line));
          if (items.length > 0) {
            blocks.push(`## ${got.piece.title} › ${section.heading}\n\n${items.join('\n')}`);
          }
        }
      }
      const mainText = texts[0]?.text ?? '';
      const lines = [`ErrorCode ${wanted}`, ''];
      if (blocks.length === 0) {
        // In no table: the guide's own sentence, with the paragraph it ends.
        const first = tablesOf(mainText)[0];
        lines.push(`ErrorCode ${wanted} is in no table of the error guides.`);
        if (first?.before) {
          lines.push('', first.before);
        }
      } else {
        lines.push(blocks.join('\n\n'));
      }
      const envelope = sectionsOf(mainText)[0];
      if (envelope !== undefined) {
        lines.push('', `## ${main.title} › ${envelope.heading}`, '', envelope.body);
      }
      const body = fitTo(lines.join('\n'), ERROR_CODE_CAP - 300, `[More in the guide: ${this.origin}${main.address}]`);
      return this.reply(lastState, language, main.address, body, { id: main.id });
    });
  }

  // ---- --check ----

  async check(): Promise<{ ok: boolean; lines: string[] }> {
    const lines = [`Site: ${this.origin}`];
    let ok = true;
    try {
      const state = await this.docs.currentIndex();
      if (state.offline !== null) {
        ok = false;
        lines.push(`Index: ${this.docs.host} could not be reached (${state.offline.reason}); doc build ${state.index.docBuild} is in the cache.`);
      } else {
        lines.push(`Index: doc build ${state.index.docBuild} (${state.index.docDate}), ${count(state.index.pieces.length)} pages, read from the site.`);
      }
    } catch (error) {
      if (!(error instanceof DocsError)) {
        throw error;
      }
      ok = false;
      lines.push(`Index: ${error.sentence}`);
    }
    const cache = this.docs.cache;
    if (cache === null) {
      lines.push('Cache: off, nothing is written to disk.');
    } else {
      const writable = cache.writable();
      lines.push(`Cache folder: ${cache.dir} (${writable.ok ? 'can be written' : `cannot be written: ${writable.reason}`}).`);
    }
    return { ok, lines };
  }
}
