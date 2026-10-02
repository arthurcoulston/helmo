export const JSON_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
});

export interface ApiDocument<T> {
  api: 'helmo/v1';
  area: 'overview' | 'work' | 'roadmap' | 'team' | 'runtime';
  data: T;
}

export function apiDocument<T>(area: ApiDocument<T>['area'], data: T): ApiDocument<T> {
  return { api: 'helmo/v1', area, data };
}

export function apiJson<T>(area: ApiDocument<T>['area'], data: T): string {
  return JSON.stringify(apiDocument(area, data));
}
