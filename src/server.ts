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

// Falls back to HELMO_ACTOR so an estate that already provisions per-agent
// identity for Helmo loops needs no second variable.
const envJson = process.env['ROADMAP_ACTOR'] ?? process.env['HELMO_ACTOR'];
const envActor: Actor | null = envJson ? (JSON.parse(envJson) as Actor) : null;

const server = buildServer(store, envActor);
const transport = new StdioServerTransport();
await server.connect(transport);
