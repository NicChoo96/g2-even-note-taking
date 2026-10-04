// Generic REST tool — the schema the model is offered, and the request body it
// actually sends, built from ONE description of the tool.
//
// WHY THIS IS A MODULE:
//   These two halves used to live on opposite sides of the relay and disagreed.
//   `toolSchemaFor` told the model to wrap everything in `{ body: { ... } }`,
//   while the executor sent `args` itself — so a model that followed the schema
//   faithfully produced a request body of `{"body":{...}}`, one level too deep
//   for any endpoint that wanted the properties at the top. A schema and an
//   executor that cannot disagree is the whole point of this file, and splitting
//   it out of local-sse.mjs (which starts a server on import) is what lets a
//   harness assert the behaviour instead of grepping for it.
//
// THE TEMPLATE IS THE CONTRACT:
//   A REST tool with no configuration can only tell the model "send me some
//   JSON", which it then has to guess. The user-authored `bodyTemplate` fixes
//   that: its keys ARE the tool's parameters. Empty/null values are marked
//   required (the model must fill them); filled values are defaults the model
//   may omit or override. Values in the template survive into every request, so
//   a tool can pin constants the model should never be trusted with.

/** A parsed body template — always an object, never null. */
export function parseBodyTemplate(tool) {
  const raw = typeof tool?.bodyTemplate === 'string' ? tool.bodyTemplate.trim() : '';
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    // Arrays and scalars are not a request body. Treating them as "no template"
    // is better than throwing them at the provider as one anonymous property.
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    // The panel validates this live, so an unparseable template means a hand-
    // edited or older state blob. Degrade to the generic `body` parameter
    // rather than failing the whole run over a typo in a tool definition.
    return {};
  }
}

/**
 * The extra headers a tool's author wrote, parsed — always an object, never
 * null.
 *
 * Total by the same rule as `parseBodyTemplate`, and for the same reason: this
 * runs on the request path of a live run, so a typo in a tool definition must
 * degrade to "no extra headers" rather than take the run down. It is stricter
 * about VALUES, though, and only because a header is not a JSON value: the HTTP
 * layer would coerce a number or an object into something the endpoint never
 * asked for (`[object Object]`), which is a silently WRONG request rather than a
 * missing header. Non-string values are therefore dropped, and the panel says so
 * while the template is being typed.
 *
 * `Accept` and `Authorization` are deliberately NOT defaulted here: the relay
 * owns those, and this module's job is to answer exactly one question — what did
 * the author write?
 */
export function parseHeaderTemplate(tool) {
  const raw = typeof tool?.headers === 'string' ? tool.headers.trim() : '';
  if (!raw) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [name, v] of Object.entries(value)) {
    if (!name.trim()) continue;
    if (typeof v !== 'string') continue;
    out[name] = v;
  }
  return out;
}

/**
 * The wire head of a REST tool's request: the method, and the headers the
 * author wrote merged under the two the relay owns.
 *
 * BOTH relay executors call this — the agent path (`runToolOnce`) and the
 * `/api/tool` proxy. A field the panel can set but that only one executor
 * honours is worse than a field the panel does not offer at all: it would be
 * telling the truth on one path and lying on the other, and the lie fails as a
 * 401 or a 404 from an endpoint that was never asked the right question. That is
 * exactly the drift this module exists to prevent for the body (see the header),
 * so the method and the headers are settled here too.
 *
 * `Accept` and `Authorization` are the relay's to set, so an authored header of
 * either name is REPLACED rather than merged. The token is the credential stored
 * against the tool, and letting a template shadow it would mean a tool that
 * authenticates on one device and 401s on another.
 *
 * An unknown method degrades to POST, which is what the executors did before PUT
 * existed: the failure is then a wrong verb, not a run that never starts.
 */
export function httpRequestHead(tool, { token = '' } = {}) {
  const raw = String(tool?.method || '').toUpperCase();
  const method = raw === 'GET' || raw === 'PUT' ? raw : 'POST';
  const headers = { Accept: 'application/json' };
  for (const [name, value] of Object.entries(parseHeaderTemplate(tool))) {
    if (name.toLowerCase() === 'accept' || name.toLowerCase() === 'authorization') continue;
    headers[name] = value;
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  return { method, headers };
}

/** The JSON Schema type name for a template default. */
function jsonTypeName(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object') return 'object';
  return 'string';
}

/**
 * The provider-facing schema for a REST tool.
 *
 * With a template, each key becomes its own parameter — which is what stops the
 * model inventing names the endpoint does not have. Without one, the historical
 * free-form `body` object is kept, and `httpRequestArgs` unwraps it so that
 * older schema and the executor still agree.
 */
export function httpToolSchema(tool) {
  const template = parseBodyTemplate(tool);
  const keys = Object.keys(template);
  const properties = keys.length
    ? Object.fromEntries(
        keys.map((key) => [
          key,
          {
            type: jsonTypeName(template[key]),
            description:
              template[key] === '' || template[key] === null
                ? `You must supply "${key}".`
                : `"${key}" — omit to use the configured default, or supply your own.`,
          },
        ]),
      )
    : { body: { type: 'object', description: 'JSON request body / query parameters.' } };
  return {
    type: 'function',
    function: {
      name: tool?.name || 'http_tool',
      description: tool?.description || 'Call an external HTTP API.',
      parameters: {
        type: 'object',
        properties,
        // An empty or null template value means "the model has to decide this",
        // so it is required. `required` is already used this way by the web
        // tool, so a provider that accepts that accepts this.
        required: keys.filter((key) => template[key] === '' || template[key] === null),
      },
    },
  };
}

/**
 * The object to send: the template's defaults, with the model's arguments
 * layered over them.
 *
 * A pre-template client (or a model that read the generic schema) may wrap
 * everything in `body`; that wrapper is accepted and unwrapped, because the
 * schema advertised it for long enough to be in real transcripts. Both shapes
 * therefore reach the endpoint as the same flat object.
 */
export function httpRequestArgs(tool, args) {
  const raw = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const wrapped = raw.body && typeof raw.body === 'object' && !Array.isArray(raw.body);
  const inner = wrapped ? raw.body : raw;
  return { ...parseBodyTemplate(tool), ...inner };
}
