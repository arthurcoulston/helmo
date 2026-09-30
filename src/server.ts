#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mkdirSync } from 'node:fs';
import { installationLine, requestedInstallation, requireInstallation } from './install.js';
import { Store } from './store.js';
import { Actor } from './types.js';
import { buildServer } from './tools.js';

// Started by a service definition, so the assertion arrives on argv (H-2474),
// and the target is named on STDERR: stdout is the MCP protocol channel.
const install = requireInstallation(process.env, undefined, requestedInstallation(process.argv.slice(2)));
mkdirSync(install.home, { recursive: true });
const store = new Store(install.db, install);
console.error(`Roadmap MCP (stdio) — ${installationLine(install, store.installationIdentity())}`);

// Falls back to HELMO_ACTOR so an estate that already provisions per-agent
// identity for Helmo loops needs no second variable.
const envJson = process.env['ROADMAP_ACTOR'] ?? process.env['HELMO_ACTOR'];
const envActor: Actor | null = envJson ? (JSON.parse(envJson) as Actor) : null;

const server = buildServer(store, envActor);
const transport = new StdioServerTransport();
await server.connect(transport);
