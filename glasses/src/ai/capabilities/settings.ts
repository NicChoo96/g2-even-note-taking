// Settings page capabilities — layer 2.
//
// DELIBERATELY READ-ONLY. Settings owns provider API keys, and those are either
// supplied by the server environment or written by the owner from an
// authenticated browser session. A voice command that could rewrite an API key
// — or a model string that silently redirects agent traffic — is a boundary the
// assistant must not cross. It can open Settings and REPORT on it; the human
// makes the change. Adding a write capability later is one object in this array.
import { fetchAgentStatus } from '../../web/agents-client';
import { getAppBridge } from '../bridge';
import type { Capability } from '../types';

export const settingsCapabilities: Capability[] = [
  {
    name: 'settings.open',
    page: 'settings',
    title: 'Open settings',
    description: 'Open the Settings tab so the user can change keys, model or tools themselves.',
    params: [],
    run: () => {
      getAppBridge().openPage('settings');
      return { ok: true, summary: 'Opened Settings' };
    },
  },
  {
    name: 'settings.read',
    page: 'settings',
    title: 'Check configuration',
    description:
      'Report which LLM provider/model is active and whether the LLM and search keys are configured. ' +
      'Use when the user asks why something is not working, or what model is being used.',
    params: [],
    run: async () => {
      const st = await fetchAgentStatus();
      if (!st) return { ok: false, summary: 'Could not reach the settings service' };
      const missing = [!st.llm && 'LLM key', !st.tavily && 'search key'].filter(Boolean);
      return {
        ok: true,
        summary: st.llm ? `${st.provider} / ${st.model}` : 'No LLM key configured',
        data: {
          provider: st.provider,
          model: st.model,
          llm: st.llm,
          tavily: st.tavily,
          missing,
          source: st.source,
        },
        hint: missing.length ? `missing: ${missing.join(', ')}` : undefined,
      };
    },
  },
];
