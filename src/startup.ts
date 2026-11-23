// The start of the program, given the site's origin by its entry point. Standard output belongs to the MCP
// protocol: everything a person should read goes to standard error (but for --version and --check, which run
// alone and stop).
import { homedir } from 'node:os';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { DocsCore } from './core/core.ts';
import { SettingsError, defaultCacheDir, readSettings } from './settings.ts';
import { buildServer } from './tools.ts';
import { PROGRAM, VERSION } from './version.ts';

export interface RunOptions {
  origin: string;
  argv: string[];
  env: Record<string, string | undefined>;
  /** Given only by a test entry. Undefined: the user's cache folder, unless TIB_DOCS_CACHE=off. */
  cacheDir?: string | null;
  indexMaxAgeMs?: number;
}

const OPTIONS = ['--version', '--check'];

function log(line: string): void {
  process.stderr.write(`${PROGRAM}: ${line.replace(/\s*\n\s*/g, ' | ')}\n`);
}

async function say(stream: NodeJS.WriteStream, text: string): Promise<void> {
  await new Promise<void>((written) => {
    stream.write(text, () => written());
  });
}

export async function run(options: RunOptions): Promise<void> {
  process.on('uncaughtException', (error) => {
    log(`stopped by an error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  });

  const unknown = options.argv.find((arg) => !OPTIONS.includes(arg));
  if (unknown !== undefined) {
    await say(process.stderr, `${PROGRAM} does not know the option ${JSON.stringify(unknown)}: it takes --version or --check, or nothing.\n`);
    process.exit(1);
  }
  if (options.argv.includes('--version')) {
    await say(process.stdout, `${PROGRAM} ${VERSION}\n`);
    process.exit(0);
  }

  let settings;
  try {
    settings = readSettings(options.env);
  } catch (error) {
    if (error instanceof SettingsError) {
      await say(process.stderr, `${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  const cacheDir = options.cacheDir !== undefined ? options.cacheDir : settings.cache ? defaultCacheDir(options.env, process.platform, homedir()) : null;
  const core = new DocsCore({
    origin: options.origin,
    userAgent: `${PROGRAM}/${VERSION}`,
    installPage: `${options.origin}/llms.txt`,
    cacheDir,
    log,
    defaultLanguage: settings.language,
    ...(options.indexMaxAgeMs === undefined ? {} : { indexMaxAgeMs: options.indexMaxAgeMs }),
  });

  if (options.argv.includes('--check')) {
    const checked = await core.check();
    await say(process.stdout, `${[`${PROGRAM} ${VERSION}`, ...checked.lines].join('\n')}\n`);
    process.exit(checked.ok ? 0 : 1);
  }

  log(`${VERSION} started: ${options.origin}, language ${settings.language === 'eng' ? 'en' : 'fr'}, cache ${cacheDir ?? 'off'}`);
  serveStdio(() => buildServer(core, log), { onerror: (error) => log(`protocol error: ${error.message}`) });
}
