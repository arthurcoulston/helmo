import 'tsx/esm';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.env.REV_TEST_HELMO ?? join(import.meta.dirname, '..', '..', 'helmo'));
await import(pathToFileURL(join(root, 'src', 'server.ts')).href);
