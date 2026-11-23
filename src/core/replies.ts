// Reply shaping: the header line every reply starts with, the hard cap, the parts of a very long page, and the
// tables and sections of a page.
import type { IndexState } from './docs.ts';

/** Under Claude Code's 50,000-character line, above which a result goes to a file. Header included. */
export const REPLY_CAP = 49_000;
/** A page longer than this is served in parts, cut at its "## " headings. */
export const PART_LIMIT = 45_000;

export interface ReplyData {
  id: string | null;
  doc_build: number | null;
  address: string | null;
  language: string | null;
  part?: number;
  parts?: number;
}

export interface Reply {
  text: string;
  data: ReplyData;
  isError: boolean;
}

export function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** "TIB Finance documentation · doc build 16 (2026-11-23) · eng · <origin>/llms/eng/methods/GetPayment.md" */
export function headerLine(state: IndexState, host: string, language: string, url: string): string {
  const build = `doc build ${state.index.docBuild} (${state.index.docDate})`;
  const from = state.offline === null ? build : `${build} from the cache of ${stamp(state.checkedAt)}; ${host} could not be reached`;
  return `TIB Finance documentation · ${from} · ${language} · ${url}`;
}

/** The text cut to `max` characters at a line, with a note saying where the rest is. */
export function fitTo(text: string, max: number, note: string): string {
  if (text.length <= max) {
    return text;
  }
  const room = max - note.length - 2;
  const cutAt = text.lastIndexOf('\n', room);
  return `${text.slice(0, cutAt > room / 2 ? cutAt : room)}\n\n${note}`;
}

export function capped(text: string): string {
  return fitTo(text, REPLY_CAP, '[This reply was cut at 49,000 characters.]');
}

/**
 * A page cut into parts of at most `limit` characters, at its "## " headings. A section longer than the limit is
 * cut at its lines, and a line longer than the limit at the limit. The parts put end to end are the page.
 */
export function partsOf(text: string, limit = PART_LIMIT): string[] {
  if (text.length <= limit) {
    return [text];
  }
  // Pieces that, put end to end, are the text: whole sections, or the lines (with their "\n") of a long one.
  const pieces: string[] = [];
  for (const section of text.split(/(?=^## )/m)) {
    if (section.length <= limit) {
      pieces.push(section);
      continue;
    }
    for (const line of section.split(/(?<=\n)/)) {
      for (let start = 0; start < line.length; start += limit) {
        pieces.push(line.slice(start, start + limit));
      }
    }
  }
  const parts: string[] = [];
  let part = '';
  for (const piece of pieces) {
    if (part !== '' && part.length + piece.length > limit) {
      parts.push(part);
      part = '';
    }
    part += piece;
  }
  if (part !== '') {
    parts.push(part);
  }
  return parts;
}

export interface Section {
  heading: string;
  body: string;
}

/** The "## " sections of a page, each with its heading and its text (without the heading line). */
export function sectionsOf(text: string): Section[] {
  const sections: Section[] = [];
  let heading: string | null = null;
  let body: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      if (heading !== null) {
        sections.push({ heading, body: body.join('\n').trim() });
      }
      heading = line.slice(3).trim();
      body = [];
    } else if (heading !== null) {
      body.push(line);
    }
  }
  if (heading !== null) {
    sections.push({ heading, body: body.join('\n').trim() });
  }
  return sections;
}

export interface Table {
  section: string;
  header: string;
  separator: string;
  rows: string[];
  /** The paragraph just above the table, or null. */
  before: string | null;
}

const SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;

/** The Markdown tables of a page, with the section each is in. */
export function tablesOf(text: string): Table[] {
  const lines = text.split('\n');
  const tables: Table[] = [];
  let section = '';
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    if (line.startsWith('## ')) {
      section = line.slice(3).trim();
      continue;
    }
    const next = lines[at + 1] ?? '';
    if (!line.startsWith('|') || !SEPARATOR.test(next)) {
      continue;
    }
    const rows: string[] = [];
    let row = at + 2;
    while (row < lines.length && (lines[row] ?? '').startsWith('|')) {
      rows.push(lines[row] ?? '');
      row += 1;
    }
    let end = at - 1;
    while (end >= 0 && (lines[end] ?? '').trim() === '') {
      end -= 1;
    }
    let start = end;
    while (start > 0 && (lines[start - 1] ?? '').trim() !== '' && !(lines[start - 1] ?? '').startsWith('#')) {
      start -= 1;
    }
    const paragraph = end >= 0 && !(lines[end] ?? '').startsWith('#') ? lines.slice(start, end + 1).join('\n') : null;
    tables.push({ section, header: line, separator: next, rows, before: paragraph });
    at = row - 1;
  }
  return tables;
}

/** The first cell of a table row, without spaces and backticks. */
export function firstCell(row: string): string {
  return (row.split('|')[1] ?? '').trim().replace(/`/g, '');
}
