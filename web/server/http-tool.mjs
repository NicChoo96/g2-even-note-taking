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
