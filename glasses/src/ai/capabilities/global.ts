// Global capabilities — layer 1 (routing) and cross-page actions.
//
// These are callable no matter which page is focused, which is what lets the
// model actually CHANGE focus instead of merely being told to. Page membership
// (layer 2) is enforced by the registry, so this module deliberately owns no page.
//
// NOTE: nothing here captures the page list at module-init time. Descriptions
// are static and the live catalog is produced at RUN time (system prompt +
// nav.list_pages), so importing this module can never race page registration
// and a page registered later shows up automatically.
import { getAppBridge } from '../bridge';
import { appSnapshotText } from '../context';
import { capabilitiesForPage, listPages, toWireName } from '../registry';
import { getAiFocus, setAiFocus } from '../store';
import { hasUndo, undoLastAiBatch } from '../undo';
import { GLOBAL_PAGE, type Capability, type PageId } from '../types';
import { short } from './shared';
const PAGE_ARG = 'Page id. Use one of the ids listed in the system prompt or returned by nav.list_pages.';

function pageView() {
  const focused = getAiFocus();
  return {
    focused,
    pages: listPages().map((p) => ({
      id: p.id,
      title: p.title,
      synonyms: p.synonyms,
      summary: p.summary,
      // Wire names: this view is fed to the model via nav.list_pages, so it must
      // only ever show names the model is allowed to call.
      actions: capabilitiesForPage(p.id).map((c) => toWireName(c.name)),
    })),
  };
}

/** Forgiving page lookup: id, title, synonym, or partial title. */
function findPage(raw: unknown): { id: PageId; title: string } | null {
  const want = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!want) return null;
  const exact = listPages().find((p) => p.id === want || p.title.toLowerCase() === want);
  if (exact) return { id: exact.id, title: exact.title };
  const loose = listPages().find(
    (p) => p.synonyms.some((s) => s.toLowerCase() === want) || p.title.toLowerCase().includes(want),
  );
  return loose ? { id: loose.id, title: loose.title } : null;
}

function badPage(raw: unknown) {
  return {
    ok: false,
    summary: `No page "${short(String(raw ?? ''), 20)}"`,
    hint: `valid pages: ${listPages()
      .map((p) => p.id)
      .join(', ')}`,
  };
}

export const globalCapabilities: Capability[] = [
  {
    name: 'nav.list_pages',
    page: GLOBAL_PAGE,
    title: 'List pages',
    description:
      'List every page in the app, each page\'s actions, and which page is currently focused. ' +
      'Call this FIRST when you are unsure which page the request refers to.',
    params: [],
    run: () => {
      const view = pageView();
      return {
        ok: true,
        summary: `Pages: ${view.pages.map((p) => p.title).join(', ')}`,
        data: {
          ...view,
          listing: view.pages.map((p) => `${p.id} (${p.title}): ${p.actions.join(', ')}`),
        },
        hint: `currently focused: ${view.focused}`,
      };
    },
  },
  {
    name: 'nav.list_actions',
    page: GLOBAL_PAGE,
    title: 'List page actions',
    description:
      'List the actions available on ONE page without navigating there. Use it to check whether a page ' +
      'supports what the user asked for.',
    params: [{ name: 'page', type: 'string', description: PAGE_ARG, required: true }],
    run: (args) => {
      const found = findPage(args.page);
      if (!found) return badPage(args.page);
      const actions = capabilitiesForPage(found.id).map((c) => ({
        name: toWireName(c.name),
        title: c.title,
        description: c.description,
        confirm: Boolean(c.confirm),
      }));
      return {
        ok: true,
        summary: `${found.title}: ${actions.length} action(s)`,
        data: { page: found.id, title: found.title, actions },
      };
    },
  },
  {
    name: 'nav.open_page',
    page: GLOBAL_PAGE,
    title: 'Open page',
    description:
      'Switch the app to a page. REQUIRED before calling that page\'s actions, because actions only run ' +
      'on the focused page.',
    params: [{ name: 'page', type: 'string', description: PAGE_ARG, required: true }],
    run: (args) => {
      const found = findPage(args.page);
      if (!found) return badPage(args.page);
      setAiFocus(found.id);
      getAppBridge().openPage(found.id);
      return {
        ok: true,
        summary: `Opened ${found.title}`,
        data: { page: found.id, actions: capabilitiesForPage(found.id).map((c) => c.name) },
      };
    },
  },
  {
    name: 'nav.back',
    page: GLOBAL_PAGE,
    title: 'Go back',
    description: 'Leave the current sub-view (close the doc picker or the agent detail pane).',
    params: [],
    run: () => {
      getAppBridge().goBack();
      return { ok: true, summary: 'Went back' };
    },
  },
  {
    name: 'app.status',
    page: GLOBAL_PAGE,
    title: 'App status',
    description:
      'Read the live app state: focused page, to-do items, document titles, notes length and agents. ' +
      'Use this to ANSWER questions about the app instead of guessing.',
    params: [],
    run: () => {
      const snapshot = appSnapshotText();
      return {
        ok: true,
        summary: snapshot.split('\n').slice(0, 2).join(' · '),
        data: { snapshot },
      };
    },
  },
  {
    name: 'say.reply',
    page: GLOBAL_PAGE,
    title: 'Answer',
    description:
      'Answer the user in words with no app change. Use it for a question, for ordinary conversation, or ' +
      'when no action fits. One short sentence normally; two or three when they are clearly just talking ' +
      'with you.',
    params: [
      {
        name: 'text',
        type: 'string',
        // The long form is for the conversational lane (see ../converse). This is
        // a BACKSTOP, not a budget: it has to sit well clear of the loop's own
        // cap (MAX_CHAT_CHARS) or a long chat reply arrives pre-clipped and never
        // even reaches `clean`, which is the only place a cut is decided and
        // marked with an ellipsis.
        description:
          'The reply: one or two sentences (~200 characters), or up to ~450 in a conversation. Never more than 700.',
        required: true,
      },
    ],
    run: (args) => {
      const text = String(args.text ?? '').trim();
      return { ok: true, summary: text.slice(0, 1200), data: { replied: true } };
    },
  },
  {
    name: 'undo.last',
    page: GLOBAL_PAGE,
    title: 'Undo AI action',
    description: 'Revert the previous batch of changes this assistant made. Use when the user says "undo".',
    params: [],
    available: () => hasUndo(),
    run: () => {
      const label = undoLastAiBatch();
      return label ? { ok: true, summary: `Undid: ${short(label, 30)}` } : { ok: false, summary: 'Nothing to undo' };
    },
  },
];

// Page labels + the prompt catalog are derived from the registry and live there
// (see ai/registry.ts: pageTitle / pageCatalogText) so this module stays a pure
// capability list with no incoming dependency from the context builder.
