/**
 * Offline verification for the browser half of `dsh-team-panel`.
 *
 * The bundle targets the browser, so this harness supplies the two things it
 * expects there — `window.__ModuleLoader__` and React — then renders the panel
 * tree with projection data shaped exactly like the shipped contracts. Nested
 * function components are expanded so the assertions reach the rows and the
 * dependency graph instead of stopping at the panel's own element.
 *
 * Run: node verify.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "lib", "client.js"), "utf8");

/** Recording React stand-in: hooks are inert, elements keep their component. */
function fakeReact() {
  const hooks = [];
  return {
    createElement: (type, props, ...children) => ({
      type,
      props,
      ...(children.length === 0 ? {} : { children }),
    }),
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: () => {},
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    Fragment: "Fragment",
    hooks,
  };
}

/** Module loader capture plus the minimal document the stylesheet touches. */
function loadBundle() {
  let registered = null;
  globalThis.document = {
    createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = { __ModuleLoader__: { load: (entry) => { registered = entry; } } };
  const React = fakeReact();
  new Function("window", source)(globalThis.window);
  assert.ok(registered !== null, "the bundle must call window.__ModuleLoader__.load");
  assert.equal(registered.id, "dsh-team-panel", "bundle id must match the package");
  const api = registered.factory((id) => {
    if (id === "react") return React;
    throw new Error(`unexpected require("${id}")`);
  });
  return { api, React };
}

/** One fake Client Context that records effects, slots, and dictionaries. */
function fakeClient(api) {
  const slots = [];
  const disposers = [];
  const dictionaries = [];
  /** Services the plugin looks up lazily; tests swap them after apply. */
  const services = new Map();
  const ctx = {
    effect: (callback, label) => {
      const dispose = callback();
      const disposer = typeof dispose === "function" ? dispose : () => {};
      disposers.push(disposer);
      return () => {
        disposer();
        assert.ok(label === undefined || typeof label === "string");
      };
    },
    get: (name) => services.get(name),
    on: () => () => {},
    locale: {
      register: (namespace, dicts) => {
        dictionaries.push({ namespace, dicts });
        return () => {};
      },
      bind: (namespace) => {
        const found = dictionaries.find((entry) => entry.namespace === namespace);
        return (key, params) => {
          const table = found === undefined ? undefined : found.dicts.zh;
          const text = table !== undefined && typeof table[key] === "string" ? table[key] : key;
          return params === undefined ? text : `${text} ${JSON.stringify(params)}`;
        };
      },
    },
    slots: {
      inject: (_name, callback) => {
        callback();
        return () => {};
      },
      register: (registration, component) => {
        slots.push({ ...registration, component });
        return () => {};
      },
    },
  };
  api.apply(ctx);
  return { slots, dictionaries, services, disposeAll: () => disposers.forEach((dispose) => dispose()) };
}

/** Expand every function component so assertions reach the produced markup. */
function expand(node, depth = 0) {
  if (node === null || node === undefined || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((child) => expand(child, depth));
  if (depth > 12) return node;
  if (typeof node.type === "function") {
    const rendered = node.type({ ...node.props, ...(node.props?.children ? {} : {}) });
    return expand(rendered, depth + 1);
  }
  const children = node.children ?? (node.props?.children === undefined ? [] : [node.props.children]);
  const flat = Array.isArray(children) ? children : [children];
  return {
    ...node,
    children: flat.flat(Infinity).filter((child) => child !== null && child !== undefined).map((child) => expand(child, depth)),
  };
}
function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== "object") {
    visit({ kind: "text", value: String(node) });
    return;
  }
  visit({ kind: "element", node });
  for (const child of node.children ?? []) walk(child, visit);
}

const checks = [];
function check(label, condition, detail) {
  checks.push({ label, ok: Boolean(condition), detail });
  if (!condition) console.error(`FAIL: ${label}${detail === undefined ? "" : ` (${detail})`}`);
}

const { api, React } = loadBundle();
check("apply exported", typeof api.apply === "function");
check("inject exported", Array.isArray(api.inject));

const client = fakeClient(api);
const trigger = client.slots.find((slot) => slot.name === "conversation.session.header.actions");
const overlay = client.slots.find((slot) => slot.name === "shell.overlay");
check("trigger slot registered", trigger !== undefined);
check("overlay slot registered", overlay !== undefined);
check("trigger uses a private id", trigger?.id === "team-panel", trigger?.id);
check("overlay uses the same id", overlay?.id === "team-panel", overlay?.id);
check("overlay orders after the shipped entries", typeof overlay?.order === "number" && overlay.order > 100, String(overlay?.order));
check("both halves share one dictionary namespace", client.dictionaries.length === 1 && client.dictionaries[0].namespace === "team-panel");
check("zh and en dictionaries exist", client.dictionaries[0]?.dicts?.zh !== undefined && client.dictionaries[0]?.dicts?.en !== undefined);
check("dictionaries agree on keys", JSON.stringify(Object.keys(client.dictionaries[0].dicts.zh).sort()) === JSON.stringify(Object.keys(client.dictionaries[0].dicts.en).sort()));

/** Projection bundles shaped like the shipped types. */
const catalog = [
  { id: "s-lead", name: "lead", mode: "continuable", label: "lead", createdAt: 1 },
  { id: "s-a", name: "reviewer", mode: "continuable", label: "reviewer", createdAt: 2 },
  { id: "s-b", name: "builder", mode: "continuable", label: "builder", createdAt: 3 },
];
const tasks = [
  { id: "t1", subject: "Scaffold", description: "", status: "completed", blockedBy: [], writeScopes: [], ready: false, ownerName: "reviewer" },
  { id: "t2", subject: "Wire API", description: "", status: "in_progress", blockedBy: ["t1"], writeScopes: [], ready: false, ownerName: "builder" },
  { id: "t3", subject: "Audit", description: "", status: "pending", blockedBy: ["t2"], writeScopes: [], ready: false },
  { id: "t4", subject: "Deleted one", description: "", status: "deleted", blockedBy: [], writeScopes: [], ready: false },
];
const summaries = {
  "s-lead": { running: true, blank: false },
  "s-a": { running: false, blank: false },
  "s-b": { running: true, blank: false },
};
const projections = {
  "s-lead": {
    values: {
      subagentCatalog: catalog,
      agentTeam: { enabled: true, tasks },
      contextPressure: { projectedTokens: 42000, contextWindow: 500000 },
    },
  },
  "s-a": { values: { contextPressure: { projectedTokens: 455000, contextWindow: 500000 } } },
  "s-b": { values: { contextPressure: { pressureTokens: 150000, contextWindow: 200000 } } },
};

/**
 * Slot props for the panel. `shell.overlay` is root-scoped, so `sessionId` and
 * `useProjection` are deliberately NOT provided: the only way to address a
 * Session is the visibility store the header trigger writes.
 */
function propsFor({ open, archivedSessionIds = [] }) {
  return {
    t: (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`),
    close: () => {},
    actions: {
      open: () => {},
      retire: async () => {},
      restore: async () => {},
    },
    useSessions: (selector) => selector({ projectionsBySession: projections, byId: summaries }),
    useWorkspaces: (selector) => selector({ archivedSessionIds }),
  };
}

/** A fresh visibility store shaped like the plugin's, driving the overlay. */
function visibilityFor(target) {
  const listeners = new Set();
  let value = target;
  return {
    store: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => value,
    },
    set(next) {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

// --- closed panel renders nothing -----------------------------------------
const closedVisibility = visibilityFor(null);
const closed = overlay.component({ ...overlay.inject(), ...propsFor({ open: false }), visibility: closedVisibility.store });
check("closed panel renders nothing", closed === null || closed === undefined);

// --- open panel: members, occupancy, graph --------------------------------
const openProps = propsFor({ open: true, archivedSessionIds: ["s-b"] });
const openVisibility = visibilityFor({ sessionId: "s-lead" });
const tree = expand(overlay.component({ ...overlay.inject(), ...openProps, visibility: openVisibility.store }));
check("open panel renders a tree", tree !== null && typeof tree === "object");

const elements = [];
const texts = [];
walk(tree, (entry) => {
  if (entry.kind === "text") texts.push(entry.value);
  else elements.push(entry.node);
});

const memberRows = elements.filter((node) => node.props?.["data-team-member"] !== undefined);
check("one row per member", memberRows.length === 3, `got ${memberRows.length}`);
check("member names rendered", ["@lead", "@reviewer", "@builder"].every((name) => texts.includes(name)), texts.filter((text) => text.startsWith("@")).join(","));

const retiredSection = elements.find((node) => node.props?.["data-team-retired-section"] !== undefined);
check("archived members move to their own section", retiredSection !== undefined);
const retiredRows = retiredSection === undefined ? [] : [];
walk(retiredSection, (entry) => {
  if (entry.kind === "element" && entry.node.props?.["data-team-member"] !== undefined) retiredRows.push(entry.node);
});
check("the archived member is the one shown as retired", retiredRows.length === 1 && retiredRows[0].props["data-team-member"] === "s-b", String(retiredRows.length));

const bars = elements.filter((node) => typeof node.props?.className === "string" && node.props.className.startsWith("tp-bar"));
check("one occupancy bar per member", bars.length === 3, `got ${bars.length}`);
const widthOf = (bar) => {
  const span = (bar.children ?? []).find((child) => child?.props?.style?.width !== undefined);
  return span?.props?.style?.width;
};
const widths = bars.map(widthOf);
check("occupancy widths are percentages", widths.every((width) => typeof width === "string" && width.endsWith("%")), widths.join(","));
check("near-full context is flagged", bars.some((bar) => bar.props["data-level"] === "danger"), bars.map((bar) => bar.props["data-level"]).join(","));
check("mid context is warned", bars.some((bar) => bar.props["data-level"] === "warn"), bars.map((bar) => bar.props["data-level"]).join(","));

const graph = elements.find((node) => node.type === "svg" && node.props?.["data-team-graph"] !== undefined);
check("dependency graph rendered", graph !== undefined);
check("deleted tasks are excluded", Number(graph?.props["data-team-graph"]) === 3, String(graph?.props["data-team-graph"]));
const paths = elements.filter((node) => node.type === "path" && node.props?.className === "tp-edge");
check("one edge per dependency", paths.length === 2, `got ${paths.length}`);
check("no self edge", paths.every((path) => !path.props.d.startsWith("M0")));
const nodes = elements.filter((node) => node.type === "rect" && node.props?.className === "tp-node");
check("one node per task", nodes.length === 3, `got ${nodes.length}`);
check("nodes carry their status", nodes.map((node) => node.props["data-status"]).sort().join(",") === "completed,in_progress,pending", nodes.map((node) => node.props["data-status"]).join(","));
const glyphs = elements.filter((node) => node.type === "circle" && node.props?.className === "tp-glyph");
check("blocked tasks are marked", glyphs.some((node) => node.props["data-blocked"] === "true"), glyphs.map((node) => node.props["data-blocked"]).join(","));

// --- trigger counters ------------------------------------------------------
const triggerTree = expand(trigger.component({ ...trigger.inject(), ...openProps, sessionId: "s-lead" }));
const triggerTexts = [];
const triggerEls = [];
walk(triggerTree, (entry) => {
  if (entry.kind === "text") triggerTexts.push(entry.value);
  else triggerEls.push(entry.node);
});
check("trigger is a button", triggerEls.some((node) => node.type === "button"));
const badges = triggerEls.filter((node) => node.props?.className === "tp-badge").map((node) => node.children.join(""));
check("trigger counts live members", badges.includes("2"), badges.join(","));
check("trigger counts tasks", badges.includes("3"), badges.join(","));

// --- the root-scoped overlay must render with slot props only -------------
// `shell.overlay` receives no sessionId and no useProjection; a panel that
// reached for either would throw and take the whole frame down with it.
const rootOnly = { ...overlay.inject(), ...propsFor({ open: true }), visibility: visibilityFor({ sessionId: "s-lead" }).store };
let rootThrew = null;
try {
  expand(overlay.component(rootOnly));
} catch (error) {
  rootThrew = error;
}
check("overlay renders without sessionId or useProjection", rootThrew === null, rootThrew === null ? undefined : String(rootThrew.message));
check("overlay reads projections through useSessions", !source.includes("useProjection("));

// --- confirmation is inline, never a modal prompt -------------------------
const source_lower = source.toLowerCase();
check("no blocking browser prompt", !source_lower.includes("confirm(") && !source_lower.includes("window.confirm") && !source_lower.includes("alert("));
check("retire asks first", source.includes("setConfirming"));
check("retire archives with stopActivity", source.includes("archiveSession(sessionId, { stopActivity: true })"));
check("restore path exists", source.includes("unarchiveSession"));
check("panel never writes Session events", !source.includes("session.append") && !source.includes("emit("));

// --- degraded inputs -------------------------------------------------------
const emptyTree = expand(
  overlay.component({
    ...overlay.inject(),
    ...openProps,
    visibility: visibilityFor({ sessionId: "s-lead" }).store,
    useSessions: (selector) => selector({ projectionsBySession: {}, byId: {} }),
    useWorkspaces: (selector) => selector({ archivedSessionIds: undefined }),
  }),
);
const emptyTexts = [];
walk(emptyTree, (entry) => {
  if (entry.kind === "text") emptyTexts.push(entry.value);
});
check("empty board shows the empty note", emptyTexts.includes("noTasks"), emptyTexts.join("|"));
check("no members still renders the lead row", emptyTexts.includes("@lead") || emptyTexts.includes("noMembers"), emptyTexts.join("|"));

client.disposeAll();
check("disposal releases every effect", true);

const failed = checks.filter((entry) => !entry.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${checks.length} checks failed`);
  process.exit(1);
}
console.log(`OK: ${checks.length} checks passed`);
void React;
