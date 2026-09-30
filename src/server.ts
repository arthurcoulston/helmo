#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mkdirSync } from 'node:fs';
import { requireInstallation } from './install.js';
import { Store } from './store.js';
import { Actor } from './types.js';
import { buildServer } from './tools.js';

const install = requireInstallation();
mkdirSync(install.home, { recursive: true });
const store = new Store(install.db);

const envActor: Actor | null = process.env['HELMO_ACTOR'] ? (JSON.parse(process.env['HELMO_ACTOR']) as Actor) : null;

const server = buildServer(store, envActor);
const transport = new StdioServerTransport();
await server.connect(transport);
