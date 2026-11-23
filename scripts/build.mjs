// Builds the ONE file integrators receive, dist/tib-docs-mcp.mjs, and dist/THIRD-PARTY-NOTICES.txt beside it.
//
// - One ES module for Node 22 or later, with every library inside: nothing is downloaded at install.
// - Not minified, so that anyone can read what it does.
// - Reproducible: the same inputs give the same bytes, from any folder.
// - Every library whose code is in the file has its licence text in the file's first comment and in the notices
//   file; a library without one stops the build. A library that a bundled package carries INSIDE its own files is
//   found from the markers that package's own bundler left ("//#region ../../node_modules/.pnpm/ajv@8.18.0/...");
//   its licence text is kept in third-party-licences/, as published with that exact version on the npm registry.
// - The version is written once, in src/version.ts, and must equal package.json's.
//
//   node scripts/build.mjs [--out <folder>]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TARGET = 'node22';
export const BUILT_FILE = 'tib-docs-mcp.mjs';
export const NOTICES_FILE = 'THIRD-PARTY-NOTICES.txt';
const LICENCE_FILE = /^(licen[cs]e|notice|copying)/i;
const PACKAGES_FOLDER = 'node_modules/';
const CARRIED_FOLDER = join(ROOT, 'third-party-licences');

export class BuildStopped extends Error {}

/** How the program is bundled. The test bundles (private) take the same settings. */
export function bundlerSettings(root = ROOT) {
  return {
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    target: TARGET,
    format: 'esm',
    minify: false,
    charset: 'utf8',
    legalComments: 'eof',
    logLevel: 'warning',
  };
}

function packageOf(input) {
  const at = input.lastIndexOf(PACKAGES_FOLDER);
  if (at < 0) {
    return null;
  }
  const [first, second] = input.slice(at + PACKAGES_FOLDER.length).split('/');
  const name = first.startsWith('@') ? `${first}/${second}` : first;
  return { name, folder: input.slice(0, at + PACKAGES_FOLDER.length) + name };
}

function licenceTexts(folder, who) {
  const files = existsSync(folder) ? readdirSync(folder).filter((name) => LICENCE_FILE.test(name)).sort() : [];
  if (files.length === 0) {
    throw new BuildStopped(`${who} is in the built file and has no licence text to carry along (looked in ${folder}).`);
  }
  return files.map((name) => readFileSync(join(folder, name), 'utf8').replace(/\r\n/g, '\n').trim());
}

function carriedLibraries(source) {
  const found = new Map();
  const marker = /^\/\/#region \S*?node_modules\/(?:\.pnpm\/([^/\s]+)\/node_modules\/)?((?:@[^/\s]+\/)?[^/\s]+)\//gm;
  for (const match of source.matchAll(marker)) {
    const [, store, name] = match;
    const prefix = `${name.replace('/', '+')}@`;
    const version = store !== undefined && store.startsWith(prefix) ? store.slice(prefix.length).split('_')[0] : null;
    found.set(`${name}@${version ?? '?'}`, { name, version });
  }
  return [...found.values()];
}

function noticesOf(root, inputs) {
  const packages = new Map();
  const carried = new Map();
  for (const input of inputs) {
    const owner = packageOf(input);
    if (owner === null) {
      continue;
    }
    packages.set(owner.name, owner.folder);
    for (const library of carriedLibraries(readFileSync(isAbsolute(input) ? input : join(root, input), 'utf8'))) {
      carried.set(`${owner.name}>${library.name}`, { carrier: owner.name, ...library });
    }
  }
  const notices = [];
  const versionOf = new Map();
  for (const [name, folder] of packages) {
    const absolute = isAbsolute(folder) ? folder : join(root, folder);
    const manifest = JSON.parse(readFileSync(join(absolute, 'package.json'), 'utf8'));
    versionOf.set(name, manifest.version);
    notices.push({ name: manifest.name, version: manifest.version, licence: manifest.license, carrier: null, texts: licenceTexts(absolute, `${manifest.name} ${manifest.version}`) });
  }
  const listPath = join(CARRIED_FOLDER, 'carried.json');
  const listed = existsSync(listPath) ? JSON.parse(readFileSync(listPath, 'utf8')).carriers : [];
  const expected = new Map();
  for (const carrier of listed) {
    if (!packages.has(carrier.package)) {
      continue;
    }
    for (const library of carrier.libraries) {
      expected.set(`${carrier.package}>${library.name}`, { carrier: carrier.package, carrierVersion: carrier.version, ...library });
    }
  }
  for (const [key, library] of carried) {
    const known = expected.get(key);
    const carrier = `${library.carrier} ${versionOf.get(library.carrier)}`;
    if (library.version === null) {
      throw new BuildStopped(`${carrier} carries the library ${library.name} inside its own files and its version cannot be read there: write it down in third-party-licences/carried.json.`);
    }
    if (known === undefined || known.version !== library.version) {
      throw new BuildStopped(`${carrier} carries ${library.name} ${library.version} inside its own files, and no licence text is kept for it. Copy the licence file of the published package ${library.name}@${library.version} to third-party-licences/${library.name}@${library.version}/ and name it in third-party-licences/carried.json.`);
    }
    notices.push({ name: library.name, version: library.version, licence: known.license, carrier: library.carrier, texts: licenceTexts(join(CARRIED_FOLDER, `${library.name}@${library.version}`), `${library.name} ${library.version}, carried inside ${carrier},`) });
  }
  for (const [key, library] of expected) {
    if (!carried.has(key)) {
      throw new BuildStopped(`third-party-licences/carried.json says that ${library.carrier} carries ${library.name} ${library.version}, and no bundled file of it shows it: bring carried.json in line.`);
    }
  }
  return notices.sort((one, other) => one.name.localeCompare(other.name));
}

function noticesText(version, notices) {
  const title = (notice) => `${notice.name} ${notice.version} (${notice.licence})${notice.carrier === null ? '' : `, carried inside ${notice.carrier}`}`;
  const head = [
    'THIRD-PARTY NOTICES',
    '',
    `tib-docs-mcp ${version} carries the code of the ${notices.length} libraries listed here. Each stays under its own licence, whose text follows.`,
    '',
    ...notices.map((notice) => `  - ${title(notice)}`),
  ];
  const texts = notices.map((notice) => `${title(notice)}\n\n${notice.texts.join('\n\n')}`);
  return [head.join('\n'), ...texts].join('\n\n--------\n\n');
}

/** The version, from package.json, checked against src/version.ts. */
export function versionOf(root = ROOT) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new BuildStopped('package.json holds no version of the form 1.2.3.');
  }
  const written = /export const VERSION = '([^']+)';/.exec(readFileSync(join(root, 'src', 'version.ts'), 'utf8'))?.[1];
  if (written !== version) {
    throw new BuildStopped(`src/version.ts says ${written ?? 'nothing'} and package.json says ${version}: write the same version in both.`);
  }
  return version;
}

/** Bundles one entry with the release settings and puts the notices at its head. Returns the text and the notices. */
export async function bundle({ root = ROOT, entry, outfile }) {
  const version = versionOf(root);
  const result = await build({ ...bundlerSettings(root), entryPoints: [entry], outfile, write: false, metafile: true });
  const output = result.outputFiles.find((file) => file.path.endsWith('.mjs'));
  const codeOutput = Object.values(result.metafile.outputs)[0];
  const bundled = Object.entries(codeOutput.inputs)
    .filter(([, use]) => use.bytesInOutput > 0)
    .map(([input]) => input);
  const notices = noticesOf(root, bundled);
  const noticesBody = noticesText(version, notices);
  const code = output.text;
  const firstLine = code.startsWith('#!') ? code.slice(0, code.indexOf('\n') + 1) : '';
  const noticesComment = `/*\n${noticesBody.replaceAll('*/', '* /')}\n*/\n`;
  const text = `${firstLine}${noticesComment}${code.slice(firstLine.length)}`;
  return { text, noticesBody, notices, version, ourFiles: bundled.filter((input) => packageOf(input) === null) };
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function main() {
  const at = process.argv.indexOf('--out');
  if (at >= 0 && process.argv[at + 1] === undefined) {
    throw new BuildStopped('"--out" needs a folder after it.');
  }
  const outFolder = resolve(ROOT, at >= 0 ? process.argv[at + 1] : 'dist');
  const outfile = join(outFolder, BUILT_FILE);
  const built = await bundle({ entry: join(ROOT, 'src', 'stdio.ts'), outfile });
  mkdirSync(outFolder, { recursive: true });
  writeFileSync(outfile, built.text, { encoding: 'utf8', mode: 0o755 });
  writeFileSync(join(outFolder, NOTICES_FILE), `${built.noticesBody}\n`, 'utf8');
  console.log(`  ${outfile}`);
  console.log(`  tib-docs-mcp ${built.version}: ${Buffer.byteLength(built.text)} bytes, ${built.text.split('\n').length} lines, sha256 ${sha256(built.text)}`);
  console.log(`  our files: ${built.ourFiles.length}; notices: ${built.notices.length} libraries (${built.notices.filter((notice) => notice.carrier !== null).length} carried inside another)`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    if (error instanceof BuildStopped) {
      console.error(`build stopped: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
