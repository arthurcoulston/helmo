import { describe, expect, it } from 'vitest';
import { apiDocument, apiJson, JSON_HEADERS } from '../src/api.js';

describe('application JSON contract', () => {
  it('gives every area one versioned envelope', () => {
    expect(apiDocument('work', { tickets: [] })).toEqual({ api: 'helmo/v1', area: 'work', data: { tickets: [] } });
    expect(JSON.parse(apiJson('runtime', { loops: [] }))).toEqual({ api: 'helmo/v1', area: 'runtime', data: { loops: [] } });
  });

  it('is explicitly JSON and never cacheable', () => {
    expect(JSON_HEADERS).toEqual({ 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' });
  });
});
