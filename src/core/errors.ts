// The failures a tool can answer with. Each carries ONE plain sentence for the caller (public text: it says what
// happened and what to do, in the caller's terms). A tool turns it into a result with isError, never a crash.

export type DocsErrorKind =
  | 'offline' // the site could not be reached and nothing usable is in the cache
  | 'unreadable-index' // index.json is missing, malformed, or of a schema this version does not know
  | 'updating' // a page does not match the index twice in a row
  | 'not-found' // no such page, method, sample or code
  | 'refused' // an address or a value this program does not accept
  | 'bad-input'; // a tool input it cannot use

export class DocsError extends Error {
  constructor(
    readonly kind: DocsErrorKind,
    readonly sentence: string,
  ) {
    super(sentence);
  }
}

/** The site could not be read: no answer, a timeout, a redirect, a status other than 200, 304 or 404, too large. */
export class SiteUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
