#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import { Actor } from './types.js';
import { buildServer } from './tools.js';

const dbPath = process.env['HELMO_DB'] ?? join(homedir(), '.helmo', 'helmo.db');
mkdirSync(join(dbPath, '..'), { recursive: true });
const store = new Store(dbPath);

const envActor: Actor | null = process.env['HELMO_ACTOR'] ? (JSON.parse(process.env['HELMO_ACTOR']) as Actor) : null;

const server = buildServer(store, envActor);
const transport = new StdioServerTransport();
await server.connect(transport);
