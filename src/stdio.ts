#!/usr/bin/env node
// The shipped entry. The site is one constant: no setting, no argument and no environment variable changes it.
import { run } from './startup.ts';

const SITE = 'https://doc.tib.finance';

await run({ origin: SITE, argv: process.argv.slice(2), env: process.env });
