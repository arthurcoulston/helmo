import { mkdirSync } from 'node:fs';
import { Installation } from './install.js';
export function prepareServer<T>(i: Installation, open: () => T): T { mkdirSync(i.home, { recursive: true }); return open(); }
