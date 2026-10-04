// Tools panel (companion web UI).
//
// The tool CATALOGUE — every tool this install holds, whichever agent uses it —
// and the one editor that can change what a tool IS: its name, its kind, its
// description and, per kind, the settings that kind needs.
//
// WHY THE CATALOGUE LEFT THE AGENT PAGE:
//   The agent page used to carry a "Tools" column holding the whole catalogue
//   next to the agent's own chips — two ways to reach the same rows, in a page
//   about ONE agent, for a catalogue that is global. A catalogue is a global
//   setting, so it lives with the other global settings (SettingsPanel) and the
//   agent page keeps only what belongs to the agent: which tools it attaches.
//
// WHY THE REST PARAMETERS WENT THE OTHER WAY:
//   A REST tool's URL, method, headers and body describe a JOB — "file this into
//   my tracker", "ask my home server to do X" — and the job belongs to the agent
//   that was built for it. Authored in the global catalogue, the second agent to
//   reference the same tool inherited the first agent's endpoint. So they are
//   rendered under the chips of the agent holding the tool (`RestToolConfig`),
//   where the wearer is thinking about the tool at the moment they attach it.
//
// ONE EDITOR, NOT TWO: `ToolEditor` is shared by Settings and was the only
// catalogue editor before this move. A second copy would drift — and the
// harnesses that pin its copy (http-tool, hub-tools, jev-spec) read it HERE now.
import { useState, useSyncExternalStore } from 'react';
import {
  createTool,
  getAgents,
  removeTool,
  saveTool,
  subscribeAgents,
  toolBody,
} from '../agents-store';
import {
  docsTool,
  filesTool,
  jevTool,
  notesTool,
  todoTool,
  webSearchTool,
  type AgentsState,
  type ToolDef,
} from '../types';
import { saveSettings } from './agents-client';

function useAgents(): AgentsState {
  return useSyncExternalStore(subscribeAgents, getAgents);
}

/**
 * Read an authored JSON-object field the way the relay does (see
 * `web/server/http-tool.mjs`), so what the field promises and what a run sends
 * cannot disagree.
 *
 * Total, exactly like the relay's readers: a typo degrades to "nothing
 * authored" rather than throwing, because `parseBodyTemplate` and
 * `parseHeaderTemplate` degrade too. The difference is that the error is
 * surfaced HERE, where it can be fixed, instead of being discovered by a model
 * that was offered the wrong parameters or by an endpoint that 401s over a
 * header the wearer believes they set.
 */
function readJsonObject(raw: string): {
  keys: string[];
  value: Record<string, unknown>;
  error: string | null;
} {
  const text = raw.trim();
  if (!text) return { keys: [], value: {}, error: null };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { keys: [], value: {}, error: 'must be a JSON object, e.g. {"query": ""}' };
    }
    const value = parsed as Record<string, unknown>;
    return { keys: Object.keys(value), value, error: null };
  } catch {
    return { keys: [], value: {}, error: 'is not valid JSON' };
  }
}

export function ToolEditor({
  tool,
  jevReady,
  filesReady,
  searchProvider,
  searchConfigured,
}: {
  tool: ToolDef;
  jevReady: boolean;
  /** True when the relay holds a credential for the Jarvis document store. */
  filesReady: boolean;
  /** Which backend serves web-search tools, as chosen on the relay. */
  searchProvider?: string;
  searchConfigured?: boolean;
}) {
  const [token, setToken] = useState('');
  const searchProviderLabel = searchConfigured
    ? searchProvider === 'brave'
      ? 'Brave Search'
      : 'Tavily'
    : null;
  /**
   * Paint now, PATCH once the typing stops.
   *
   * `hasToken` rides along locally only — it means "the RELAY holds a
   * credential" in this app, which is a different mechanism from the hub's own
   * tool-token store, and the hub has no column for `bodyTemplate` or `headers`
   * at all. Both are preserved across an adoption instead. See `agents-store`.
   */
  const patch = (p: Partial<ToolDef>) => saveTool(tool.id, p);

  const method = tool.method ?? 'POST';
  /** GET puts the template in the query string; POST and PUT in the body. */
  const payloadLabel = method === 'GET' ? 'Query parameters (JSON)' : 'Request body (JSON)';

  const saveToken = async () => {
    if (!token.trim()) return;
    await saveSettings({ toolTokens: { [tool.id]: token.trim() } });
    patch({ hasToken: true });
    setToken('');
  };

  return (
    <div className="tool-row">
      <div className="tool-head">
        <input
          className="tool-name"
          value={tool.name}
          onChange={(e) => patch({ name: e.target.value.replace(/\s+/g, '_') })}
          placeholder="tool_name"
        />
        <select value={tool.kind} onChange={(e) => patch({ kind: e.target.value as ToolDef['kind'] })}>
          <option value="web">Web search</option>
          <option value="jev">Jev decision</option>
          <option value="http">REST API</option>
          <option value="files">Stored documents</option>
          {/* The hub's own stores. Changing a tool's kind to one of these is
              legitimate — it is how a wearer turns a REST tool they built into
              "actually, just my notes" — and every one of them is server-held,
              so there is nothing further to configure. */}
          <option value="todo">To-do list</option>
          <option value="docs">Docs (my documents)</option>
          <option value="notes">Notes</option>
          {/* The one kind whose data is not the relay's. It takes no config
              either — the position is read on the DEVICE and travels with the
              run — but it only works if the wearer has granted location, so the
              note below says where that happens. */}
          <option value="location">Location</option>
        </select>
        <button
          className="icon-btn danger"
          aria-label="Remove tool"
          onClick={() => removeTool(tool.id)}
        >
          ✕
        </button>
      </div>

      <input
        value={tool.description}
        onChange={(e) => patch({ description: e.target.value })}
        placeholder="What this tool does (the model reads this to decide when to call it)"
      />

      {tool.kind === 'web' && (
        <label className="inline-field">
          Search depth
          <select
            value={tool.searchDepth ?? 'basic'}
            onChange={(e) => patch({ searchDepth: e.target.value as ToolDef['searchDepth'] })}
          >
            <option value="basic">basic (fast, cheap)</option>
            <option value="advanced">advanced (deeper)</option>
          </select>
        </label>
      )}

      {tool.kind === 'web' && (
        <p className="hint-line">
          Served by <strong>{searchProviderLabel}</strong>
          {searchProviderLabel === null
            ? ' — set a search key in Settings.'
            : ' (change the provider in Settings; this tool does not change).'}
        </p>
      )}

      {tool.kind === 'jev' && (
        <p className="empty">
          {jevReady
            ? 'Ready — uses the OpenRouter key held server-side, so there is nothing to configure here.'
            : 'No OpenRouter key on the server yet. Add one in Settings; until then this tool reports that it was skipped rather than guessing.'}
        </p>
      )}

      {tool.kind === 'files' && (
        <p className="empty">
          {filesReady
            ? 'Ready — publishes HTML pages the wearer reads on the Files tab. The document body is never returned to the model, so agents publish and stop.'
            : 'No document-store credential on the server yet. Set JARVIS_FILE_USER and JARVIS_FILE_PWD (or JARVIS_FILE_API_KEY) in the relay environment.'}
        </p>
      )}

      {tool.kind === 'location' && (
        <p className="empty">
          Reports where the wearer is. The position is captured on the device when the run starts and
          travels with it — a run cannot take a new reading while it is in flight — so this tool answers
          with where the wearer was as the run began, and states the age. In the glasses app the Even Hub
          app supplies it (grant location when it asks); in a browser the browser asks. If it is refused
          or unavailable the tool says so instead of guessing.
        </p>
      )}

      {tool.kind === 'http' && (
        <p className="hint-line">
          Its <strong>URL, method, headers and {payloadLabel.toLowerCase()}</strong> sit with the agent
          that uses it — open the agent and pick it in Tools. A REST endpoint is specific to the job the
          agent was built for, so its parameters are not a catalogue setting; a tool no agent has
          attached yet has nothing to point at.
        </p>
      )}

      {/*
        The bearer token is the exception, and it stays here on purpose: it is a
        CREDENTIAL, not a parameter. A credential belongs to the tool — one per
        install, held server-side against this tool's id — and the relay reads it
        by id on every path, so putting it here means an agent that adopts the
        tool inherits the working credential instead of a blank field.
      */}
      {tool.kind === 'http' && (
        <div className="token-row">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={tool.hasToken ? '••••••• (saved — type to replace)' : 'Bearer token (stored server-side)'}
          />
          <button className="primary" onClick={() => void saveToken()} disabled={!token.trim()}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The REST parameters of ONE tool, rendered under the agent's tool chips.
 *
 * The fields are the ones the catalogue editor used to carry — URL, method,
 * headers, body and the parameter hint — because they were never really
 * catalogue settings. What changed is where they are shown: attached to the
 * agent whose job they describe, so two agents can point the same tool kind at
 * two different endpoints without fighting over one shared row.
 *
 * The method list has PUT because a REST endpoint that UPDATES a record is the
 * common case; with only GET and POST every one of those created a second record
 * instead of changing the one the wearer meant. The relay sends exactly the verb
 * shown here (see `httpRequestHead` in `web/server/http-tool.mjs`).
 */
export function RestToolConfig({ tool }: { tool: ToolDef }) {
  const [token, setToken] = useState('');
  const patch = (p: Partial<ToolDef>) => saveTool(tool.id, p);
  const method = tool.method ?? 'POST';
  const payloadLabel = method === 'GET' ? 'Query parameters (JSON)' : 'Request body (JSON)';
  const template = readJsonObject(tool.bodyTemplate ?? '');
  const headerTemplate = readJsonObject(tool.headers ?? '');
  /** A header value can only be a string — see `parseHeaderTemplate`. */
  const nonStringHeaders = Object.entries(headerTemplate.value)
    .filter(([, v]) => typeof v !== 'string')
    .map(([k]) => k);

  const saveToken = async () => {
    if (!token.trim()) return;
    await saveSettings({ toolTokens: { [tool.id]: token.trim() } });
    patch({ hasToken: true });
    setToken('');
  };

  return (
    <div className="rest-config">
      <label className="field-label">
        REST · {tool.name} — {method}
      </label>
      <input
        value={tool.url ?? ''}
        onChange={(e) => patch({ url: e.target.value })}
        placeholder="https://api.example.com/v1/endpoint"
      />
      <label className="inline-field">
        Method
        <select
          value={method}
          onChange={(e) => patch({ method: e.target.value as 'GET' | 'POST' | 'PUT' })}
        >
          <option value="POST">POST (JSON body)</option>
          <option value="PUT">PUT (JSON body)</option>
          <option value="GET">GET (query params)</option>
        </select>
      </label>
      <label className="field-label">Headers (JSON)</label>
      <textarea
        className="doc-textarea"
        rows={2}
        value={tool.headers ?? ''}
        onChange={(e) => patch({ headers: e.target.value })}
        placeholder={'{"X-Api-Key": "", "Accept-Language": "en"}'}
      />
      <p className={headerTemplate.error ? 'warn-line' : 'hint-line'}>
        {headerTemplate.error ? (
          <>
            Headers: {headerTemplate.error}
          </>
        ) : nonStringHeaders.length ? (
          <>
            Headers: <strong>{nonStringHeaders.join(', ')}</strong>{' '}
            {nonStringHeaders.length === 1 ? 'is' : 'are'} not {nonStringHeaders.length === 1 ? 'a string' : 'strings'},
            so {nonStringHeaders.length === 1 ? 'it is' : 'they are'} dropped rather than sent as{' '}
            <code>[object Object]</code>. A header can only be text — quote the value.
          </>
        ) : headerTemplate.keys.length ? (
          <>
            Headers: the run sends <strong>{headerTemplate.keys.join(', ')}</strong>.{' '}
            <code>Accept</code> and <code>Authorization</code> are the relay's own and are replaced here.
          </>
        ) : (
          <>
            Headers is empty. Leave it so unless the endpoint wants an API key of its own or a version
            pin (e.g. <code>{'{"X-Api-Key": "…"}'}</code>); the relay already sends{' '}
            <code>Accept</code> and this tool's bearer token.
          </>
        )}
      </p>
      <label className="field-label">{payloadLabel}</label>
      <textarea
        className="doc-textarea"
        rows={4}
        value={tool.bodyTemplate ?? ''}
        onChange={(e) => patch({ bodyTemplate: e.target.value })}
        placeholder={'{"query": "", "limit": 5}'}
      />
      <p className={template.error ? 'warn-line' : 'hint-line'}>
        {template.error ? (
          <>
            {payloadLabel}: {template.error}
          </>
        ) : template.keys.length ? (
          <>
            {payloadLabel}: the model is offered <strong>{template.keys.join(', ')}</strong>. An
            empty value is <strong>required</strong> of the model; a filled one is the default it
            may omit or override.
          </>
        ) : (
          <>
            {payloadLabel} is empty, so the model sends whatever JSON it decides — which is how a
            REST tool becomes a guessing game. Write an object (e.g.{' '}
            <code>{'{"query": ""}'}</code>) and its keys become the parameters the model is told
            to send.
          </>
        )}
      </p>
      <div className="token-row">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={tool.hasToken ? '••••••• (saved — type to replace)' : 'Bearer token (stored server-side)'}
        />
        <button className="primary" onClick={() => void saveToken()} disabled={!token.trim()}>
          Save
        </button>
      </div>
    </div>
  );
}

/**
 * The global catalogue, as a section of Settings.
 *
 * Two halves, and both are global by nature: the rows (one editor per tool the
 * install holds) and the seeds that create them. A seed is matched on KIND
 * rather than id — a worn-in install that somehow holds the tool under another
 * id must not be given a second, identical one, because two tools with the same
 * name are two functions with the same name and the relay refuses that run
 * outright (`toolSetFault`).
 */
export function ToolsSection({
  jevReady,
  filesReady,
  searchProvider,
  searchConfigured,
}: {
  jevReady: boolean;
  filesReady: boolean;
  searchProvider?: string;
  searchConfigured?: boolean;
}) {
  const state = useAgents();

  const addTool = async () => {
    await createTool({
      name: `tool_${getAgents().tools.length + 1}`,
      kind: 'http',
      description: '',
      url: '',
      method: 'POST',
    });
  };

  const addSeed = async (kind: ToolDef['kind'], make: () => ToolDef) => {
    if (getAgents().tools.some((t) => t.kind === kind)) return;
    await createTool(toolBody(make()));
  };

  const catalogueSeeds: Array<{ kind: ToolDef['kind']; label: string; make: () => ToolDef }> = [
    { kind: 'web', label: 'Web search', make: webSearchTool },
    { kind: 'jev', label: 'Jev decision', make: jevTool },
    { kind: 'files', label: 'Stored docs', make: filesTool },
    // The hub's own stores — the To-Do list, the Docs library and Notes. They
    // are seeded here for the same reason the others are: an agent cannot be
    // given a tool the catalogue does not hold, and the wearer should not have
    // to visit the to-do page first to make one exist.
    { kind: 'todo', label: 'To-do list', make: todoTool },
    { kind: 'docs', label: 'Docs', make: docsTool },
    { kind: 'notes', label: 'Notes', make: notesTool },
  ];

  return (
    <>
      <div className="panel-label spaced">Tools · catalogue</div>
      <p className="hint-line">
        Every tool this install holds. An agent attaches what it needs on the agent's own page, where a
        REST tool's URL, method, headers and body are set — one endpoint per agent, not one per
        catalogue.
      </p>
      {state.tools.length === 0 && <p className="empty">No tools yet — add one below.</p>}
      {state.tools.map((t) => (
        <ToolEditor
          key={t.id}
          tool={t}
          jevReady={jevReady}
          filesReady={filesReady}
          searchProvider={searchProvider}
          searchConfigured={searchConfigured}
        />
      ))}
      <div className="tool-seeds">
        <button onClick={addTool}>+ Custom REST tool</button>
        {catalogueSeeds.map((s) => (
          <button key={s.kind} onClick={() => void addSeed(s.kind, s.make)}>
            + {s.label}
          </button>
        ))}
      </div>
    </>
  );
}
