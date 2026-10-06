import { uiRequest } from '../core/dist/index.js';

export const APP_AREAS = ['overview', 'team', 'work', 'roadmap', 'runtime'];
const config = { areas: APP_AREAS, defaultArea: 'work' };
export function shellRequest(request, response) {
  return (request.url ?? '').startsWith('/assets/') && uiRequest(request, response, config);
}
export function appRequest(request, response) {
  return uiRequest(request, response, config);
}
