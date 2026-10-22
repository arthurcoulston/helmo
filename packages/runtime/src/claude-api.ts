import type { RunChoice } from './types.js';

export interface ClaudeApiConfig {
  api_key_helper: string;
  max_budget_usd: number;
  max_turns: number;
  timeout_seconds: number;
  stop_at?: string;
  allocation_file?: string;
}

/** Opt-in: legacy metered declarations never selected credentials. */
export function usesClaudeApi(choice: Pick<RunChoice, 'runtime' | 'config'>): boolean {
  return choice.runtime === 'claude' && choice.config?.['api_key_helper'] !== undefined;
}

export function claudeApiConfig(choice: Pick<RunChoice, 'runtime' | 'billing' | 'config'>): ClaudeApiConfig | undefined {
  if (choice.runtime !== 'claude' || !choice.config) return undefined;
  const c = choice.config;
  const keys = ['api_key_helper', 'max_budget_usd', 'max_turns', 'timeout_seconds', 'stop_at', 'allocation_file'];
  if (Object.keys(c).some(k => !keys.includes(k))) throw new Error('Unknown Claude provider config key');
  if (!Object.keys(c).length) return undefined;
  if (choice.billing !== 'metered') throw new Error('Claude API credentials require billing = "metered"');
  if (typeof c['api_key_helper'] !== 'string' || !c['api_key_helper'].trim() || /[\r\n\0]/.test(c['api_key_helper'])) {
    throw new Error('Claude API needs a nonempty, single-line api_key_helper command');
  }
  for (const key of ['max_budget_usd', 'max_turns', 'timeout_seconds']) {
    const n = c[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new Error(`Claude API ${key} must be a positive number`);
  }
  if (!Number.isSafeInteger(c['max_turns'])) throw new Error('Claude API max_turns must be an integer');
  if ((c['timeout_seconds'] as number) > 2_147_483) throw new Error('Claude API timeout_seconds exceeds the timer limit');
  if (c['stop_at'] !== undefined && (typeof c['stop_at'] !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(c['stop_at']) || !Number.isFinite(Date.parse(c['stop_at'])))) {
    throw new Error('Claude API stop_at must be an ISO timestamp with a timezone');
  }
  if (c['allocation_file'] !== undefined && (typeof c['allocation_file'] !== 'string' || !c['allocation_file'].startsWith('/') || /[\r\n\0]/.test(c['allocation_file']) || !c['stop_at'])) {
    throw new Error('Claude API allocation_file requires an absolute path and stop_at');
  }
  return c as unknown as ClaudeApiConfig;
}

/** Explicit command settings beat file settings, while retaining hooks and tools.
 * Managed policy still wins. Empty competing credentials cannot select OAuth or
 * a gateway; apiKeyHelper takes precedence over a stored subscription login. */
export function claudeApiSettings(c: ClaudeApiConfig): Record<string, unknown> {
  return {
    apiKeyHelper: c.api_key_helper,
    env: {
      ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    },
  };
}
