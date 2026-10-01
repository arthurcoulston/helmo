#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { prepareServer } from '@helmo/core';
import { loaded } from './build.js';
import { installationLine, requestedInstallation, requireInstallation } from './install.js';
import { Store } from './store.js';
import { Actor } from './types.js';
import { buildServer } from './tools.js';

// Started by a service definition, so the assertion arrives on argv (H-2474),
// and the target is named on STDERR: stdout is the MCP protocol channel.
const install = requireInstallation(process.env, undefined, requestedInstallation(process.argv.slice(2)));
// The reading of what this process loaded is taken here, before it serves:
// a long-lived server asked later would report whatever replaced its code
// (H-2490).
loaded();
const envActor: Actor | null = process.env['HELMO_ACTOR'] ? (JSON.parse(process.env['HELMO_ACTOR']) as Actor) : null;
const store = prepareServer(install, () => new Store(install.db, install, envActor));
console.error(`Helmo MCP (stdio) — ${installationLine(install, store.installationIdentity())}`);

const server = buildServer(store, envActor);
const transport = new StdioServerTransport();
await server.connect(transport);
