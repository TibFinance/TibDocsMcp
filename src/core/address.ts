// The address rule: the only paths this program ever asks the site for. Every address, whether it comes from the
// index, from a tool's input or from a link in a page, passes here before a request is made.
//
// Allowed: "/llms.txt", or "/llms/" followed by path parts made of A-Z a-z 0-9 . _ - and ending in .md, .txt or
// .json. Never "..", "//", "%", "?" or "#": anything else is refused.

const PART = /^[A-Za-z0-9._-]+$/;
const ENDING = /\.(?:md|txt|json)$/;

export const INDEX_ADDRESS = '/llms/index.json';
export const ROOT_LIST_ADDRESS = '/llms.txt';

export function isAllowedAddress(address: string): boolean {
  if (address === ROOT_LIST_ADDRESS) {
    return true;
  }
  if (!address.startsWith('/llms/')) {
    return false;
  }
  if (address.includes('..') || address.includes('//') || /[%?#]/.test(address)) {
    return false;
  }
  const parts = address.slice('/llms/'.length).split('/');
  if (parts.some((part) => !PART.test(part))) {
    return false;
  }
  return ENDING.test(address);
}

export class AddressRefused extends Error {
  constructor(readonly address: string) {
    super(`The address ${JSON.stringify(address)} is not one of the documentation's.`);
  }
}

/** The full URL of an allowed address on the site's one origin. Anything else throws. */
export function siteUrl(origin: string, address: string): string {
  if (!isAllowedAddress(address)) {
    throw new AddressRefused(address);
  }
  const url = new URL(address, origin);
  if (url.origin !== origin || url.pathname !== address || url.search !== '' || url.hash !== '') {
    throw new AddressRefused(address);
  }
  return url.href;
}

/** The origin given to the core: a scheme and a host (and a port), nothing after it. */
export function checkedOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`The site origin ${JSON.stringify(origin)} is not a URL.`);
  }
  if (url.origin !== origin) {
    throw new Error(`The site origin ${JSON.stringify(origin)} must be a scheme and a host only, without a path or a trailing slash.`);
  }
  return origin;
}
