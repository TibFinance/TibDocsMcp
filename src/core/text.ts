// Small text helpers shared by the core: line endings, sha256, folding for search, and cutting.
import { createHash } from 'node:crypto';

/** The builder writes and hashes LF; a deploy may serve CRLF. Every page is turned into LF before its sha256. */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Lower case, without accents. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** At most `max` characters, cut at a word when one is near, with an ellipsis when something was cut. */
export function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) {
    return flat;
  }
  const room = flat.slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  return `${space > max * 0.6 ? room.slice(0, space) : room}…`;
}

/** Links of a page that start at the site's root ("](/llms/...)") are made absolute on the one origin. */
export function absoluteLinks(markdown: string, origin: string): string {
  return markdown.replace(/\]\(\//g, `](${origin}/`);
}

/** A number with a thousands separator, for sentences. */
export function count(value: number): string {
  return value.toLocaleString('en-US');
}
