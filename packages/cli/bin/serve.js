#!/usr/bin/env node
import { appConfig, startAppServer } from '../app-server.mjs';

const running = await startAppServer(appConfig(), (_request, response) => {
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('No Helmo app routes are installed yet.\n');
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await running.close();
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
console.log(`Helmo app: ${running.origin}`);
