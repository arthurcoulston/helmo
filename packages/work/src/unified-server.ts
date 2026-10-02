#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HELMO_VERSION, prepareServer } from '@helmo/core';
import { loaded } from './build.js';
import { installationLine, requestedInstallation, requireInstallation } from './install.js';
import { Store } from './store.js';
import { Actor } from './types.js';
import { buildServer as registerWorkTools } from './tools.js';
import { loaded as roadmapLoaded } from '../../roadmap/dist/build.js';
import {
  installationLine as roadmapInstallationLine,
  requestedInstallation as requestedRoadmapInstallation,
  requireInstallation as requireRoadmapInstallation,
} from '../../roadmap/dist/install.js';
import { Store as RoadmapStore } from '../../roadmap/dist/store.js';
import { Actor as RoadmapActor } from '../../roadmap/dist/types.js';
import { buildServer as registerRoadmapTools } from '../../roadmap/dist/tools.js';

const argv = process.argv.slice(2);
const workInstall = requireInstallation(process.env, undefined, requestedInstallation(argv));
const roadmapInstall = requireRoadmapInstallation(process.env, undefined, requestedRoadmapInstallation(argv));
loaded();
roadmapLoaded();

const workActor: Actor | null = process.env['HELMO_ACTOR'] ? JSON.parse(process.env['HELMO_ACTOR']) as Actor : null;
const roadmapJson = process.env['ROADMAP_ACTOR'] ?? process.env['HELMO_ACTOR'];
const roadmapActor: RoadmapActor | null = roadmapJson ? JSON.parse(roadmapJson) as RoadmapActor : null;
const workStore = prepareServer(workInstall, () => new Store(workInstall.db, workInstall, workActor));
const roadmapStore = prepareServer(roadmapInstall, () => new RoadmapStore(roadmapInstall.db, roadmapInstall));

console.error(`Helmo MCP (stdio) — ${installationLine(workInstall, workStore.installationIdentity())}`);
console.error(`Roadmap — ${roadmapInstallationLine(roadmapInstall, roadmapStore.installationIdentity())}`);

const server = new McpServer({ name: 'helmo', version: HELMO_VERSION });
registerWorkTools(workStore, workActor, server);
registerRoadmapTools(roadmapStore, roadmapActor, roadmapInstall, server);
await server.connect(new StdioServerTransport());
