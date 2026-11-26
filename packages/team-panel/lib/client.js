/**
 * Browser half of `dsh-team-panel`.
 *
 * A richer Agent-Teams panel than the shipped task board:
 *
 *   - member roster with a context-occupancy bar per member
 *   - retire / restore (Workspace archive) with inline confirmation, and
 *     archived members filtered out of the live roster
 *   - the shared-task dependency graph drawn as layered columns
 *
 * Everything here is shipped API: `useProjection('agentTeam')` for tasks,
 * `useProjection('subagentCatalog')` for members, `useSessions` for each member's
 * own `contextPressure` and running state, `useWorkspaces` for the archive set,
 * and the `uiWorkspace` Client service for archive/unarchive/open. The plugin
 * reads no Session events, registers no tool, and changes no model request.
 */
window.__ModuleLoader__.load({
  id: "dsh-team-panel",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = "team-panel";

    const zh = {
      "open": "团队面板",
      "title": "团队面板",
      "close": "关闭",
      "members": "成员",
      "noMembers": "还没有队友。让 Lead 创建一个 subagent 就会出现。",
      "retired": "已移除",
      "tasks": "任务依赖",
      "noTasks": "共享任务板为空。",
      "context": "上下文",
      "unknown": "未知",
      "running": "运行中",
      "idle": "空闲",
      "openChat": "打开",
      "retire": "移除",
      "restore": "恢复",
      "retireConfirm": "移除该成员？",
      "retireHint": "会话归档、可恢复，历史保留。",
      "confirm": "移除",
      "cancel": "取消",
      "retireFailed": "移除失败",
      "restoreFailed": "恢复失败",
      "ready": "可开始",
      "blocked": "被阻塞",
      "pending": "待办",
      "in_progress": "进行中",
      "completed": "已完成",
      "unowned": "未分配",
      "lead": "Lead",
      "teammate": "队友",
      "archived": "已归档",
      "openFailed": "打开失败",
    };

    const en = {
      "open": "Team panel",
      "title": "Team panel",
      "close": "Close",
      "members": "Members",
      "noMembers": "No teammates yet. Ask the Lead to start a subagent.",
      "retired": "Retired",
      "tasks": "Task dependencies",
      "noTasks": "The shared task board is empty.",
      "context": "Context",
      "unknown": "unknown",
      "running": "running",
      "idle": "idle",
      "openChat": "Open",
      "retire": "Retire",
      "restore": "Restore",
      "retireConfirm": "Retire this member?",
      "retireHint": "The session is archived and restorable; history is kept.",
      "confirm": "Retire",
      "cancel": "Cancel",
      "retireFailed": "Retire failed",
      "restoreFailed": "Restore failed",
      "ready": "ready",
      "blocked": "blocked",
      "pending": "pending",
      "in_progress": "in progress",
      "completed": "completed",
      "unowned": "unowned",
      "lead": "Lead",
      "teammate": "Teammate",
      "archived": "archived",
      "openFailed": "Open failed",
    };

    /** One stylesheet for the panel; removed with the Client run. */
    const CSS = `
.tp-button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;transition:background .12s ease,color .12s ease}
.tp-button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.tp-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;font-variant-numeric:tabular-nums}
.tp-scrim{position:fixed;inset:0;display:flex;justify-content:flex-end;background:rgba(0,0,0,.26);pointer-events:auto;z-index:60;animation:tp-fade .14s ease}
.tp-panel{display:flex;flex-direction:column;width:min(480px,92vw);height:100%;pointer-events:auto;background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l1);box-shadow:-18px 0 48px rgba(0,0,0,.22);animation:tp-slide .18s cubic-bezier(.2,.7,.3,1)}
@keyframes tp-fade{from{opacity:0}to{opacity:1}}
@keyframes tp-slide{from{transform:translateX(18px);opacity:.5}to{transform:none;opacity:1}}
.tp-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.tp-head h2{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);flex:1}
.tp-icon{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.tp-icon:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.tp-body{flex:1;overflow:auto;padding:10px 12px 24px}
.tp-section{margin-top:16px}
.tp-section:first-child{margin-top:2px}
.tp-section-title{display:flex;align-items:center;gap:6px;margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.tp-count{font-weight:400;opacity:.7;font-variant-numeric:tabular-nums}
.tp-member{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);margin-bottom:8px}
.tp-member[data-retired="true"]{opacity:.6}
.tp-row{display:flex;align-items:center;gap:7px;min-width:0}
.tp-name{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tp-muted{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.tp-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.tp-dot[data-state="running"]{background:var(--dsw-alias-state-success-primary)}
.tp-dot[data-state="retired"]{background:var(--dsw-alias-state-warn-primary)}
.tp-spacer{flex:1}
.tp-link{border:0;background:transparent;padding:1px 2px;font:inherit;font-size:11px;color:var(--dsw-alias-brand-primary);cursor:pointer;border-radius:4px}
.tp-link:hover{text-decoration:underline}
.tp-link:disabled{opacity:.5;cursor:default;text-decoration:none}
.tp-link[data-tone="muted"]{color:var(--dsw-alias-label-secondary)}
.tp-bar{position:relative;height:5px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.tp-bar > span{position:absolute;inset:0 auto 0 0;border-radius:3px;background:var(--dsw-alias-brand-primary);transition:width .2s ease}
.tp-bar[data-level="warn"] > span{background:var(--dsw-alias-state-warn-primary)}
.tp-bar[data-level="danger"] > span{background:var(--dsw-alias-state-error-primary)}
.tp-empty{padding:10px 2px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.tp-confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;color:var(--dsw-alias-label-primary)}
.tp-confirm button{height:24px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer}
.tp-confirm button[data-role="danger"]{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#fff}
.tp-confirm button:disabled{opacity:.5;cursor:default}
.tp-error{padding:6px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);font-size:11.5px}
.tp-graph{width:100%;height:auto;display:block;overflow:visible}
.tp-graph .tp-node{fill:var(--dsw-alias-bg-base);stroke:var(--dsw-alias-border-l1);stroke-width:1}
.tp-graph .tp-node[data-status="in_progress"]{stroke:var(--dsw-alias-brand-primary)}
.tp-graph .tp-node[data-status="completed"]{stroke:var(--dsw-alias-state-success-primary)}
.tp-graph .tp-edge{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:1.25}
.tp-graph text{fill:var(--dsw-alias-label-primary);font-size:10.5px}
.tp-graph .tp-sub{fill:var(--dsw-alias-label-secondary);font-size:9px}
.tp-graph .tp-glyph{fill:var(--dsw-alias-state-idle-primary)}
.tp-graph .tp-glyph[data-status="in_progress"]{fill:var(--dsw-alias-brand-primary)}
.tp-graph .tp-glyph[data-status="completed"]{fill:var(--dsw-alias-state-success-primary)}
.tp-graph .tp-glyph[data-blocked="true"]{fill:var(--dsw-alias-state-warn-primary)}
`;

    /** The plugin's one glyph. */
    function TeamIcon(props) {
      const size = props && typeof props.size === "number" ? props.size : 14;
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("circle", { cx: 5, cy: 5.4, r: 2.1, fill: "currentColor" }),
        h("circle", { cx: 11, cy: 5.4, r: 2.1, fill: "currentColor", opacity: 0.5 }),
        h("path", { d: "M1.4 13.3c0-2 1.6-3.3 3.6-3.3s3.6 1.3 3.6 3.3", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }),
        h("path", { d: "M9.6 13.3c0-1.4.8-2.4 2.1-2.8", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", opacity: 0.55 }),
      );
    }

    function CloseIcon() {
      return h(
        "svg",
        { width: 13, height: 13, viewBox: "0 0 16 16", "aria-hidden": "true" },
        h("path", { d: "M4 4l8 8M12 4l-8 8", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" }),
      );
    }

    /** Clamp one 0..1 fraction into a bar level. */
    function barLevel(fraction) {
      if (fraction >= 0.9) return "danger";
      if (fraction >= 0.7) return "warn";
      return "normal";
    }

    /** Format a token count for a narrow row. */
    function tokens(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "?";
      if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
      if (value >= 1000) return `${Math.round(value / 1000)}k`;
      return String(Math.round(value));
    }

    /** Truncate one label to a character budget. */
    function clip(value, maximum) {
      const text = String(value);
      return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
    }

    const CARD_W = 148;
    const CARD_H = 44;
    const GAP_X = 40;
    const GAP_Y = 10;

    /**
     * Layered dependency layout: one column per dependency depth, one row per
     * task inside its column. Deterministic, so no DOM measurement is needed.
     */
    function layoutGraph(tasks) {
      const byId = new Map(tasks.map((task) => [task.id, task]));
      const level = new Map();
      const visiting = new Set();
      const depthOf = (id) => {
        if (level.has(id)) return level.get(id);
        if (visiting.has(id)) return 0;
        visiting.add(id);
        const task = byId.get(id);
        const blockers = task === undefined ? [] : task.blockedBy.filter((blocker) => byId.has(blocker));
        const depth = blockers.length === 0 ? 0 : 1 + Math.max(...blockers.map(depthOf));
        visiting.delete(id);
        level.set(id, depth);
        return depth;
      };
      for (const task of tasks) depthOf(task.id);
      const columns = [];
      for (const task of tasks) {
        const depth = level.get(task.id) ?? 0;
        if (columns[depth] === undefined) columns[depth] = [];
        columns[depth].push(task);
      }
      return { columns, level };
    }

    /** The shared-task dependency graph as layered columns with elbow edges. */
    function TaskGraph(props) {
      const { tasks, t } = props;
      const { columns } = layoutGraph(tasks);
      const positions = new Map();
      let maxRows = 1;
      for (let depth = 0; depth < columns.length; depth += 1) {
        const column = columns[depth] === undefined ? [] : columns[depth];
        if (column.length > maxRows) maxRows = column.length;
        for (let row = 0; row < column.length; row += 1) {
          positions.set(column[row].id, { x: depth * (CARD_W + GAP_X), y: row * (CARD_H + GAP_Y) });
        }
      }
      const width = Math.max(1, columns.length) * (CARD_W + GAP_X) - GAP_X;
      const height = maxRows * (CARD_H + GAP_Y) - GAP_Y;
      const edges = [];
      for (const task of tasks) {
        const to = positions.get(task.id);
        for (const blocker of task.blockedBy) {
          const from = positions.get(blocker);
          if (from === undefined || to === undefined) continue;
          const x1 = from.x + CARD_W;
          const y1 = from.y + CARD_H / 2;
          const x2 = to.x;
          const y2 = to.y + CARD_H / 2;
          const midX = x1 + (x2 - x1) / 2;
          edges.push(
            h("path", {
              key: `${blocker}->${task.id}`,
              className: "tp-edge",
              d: `M${x1} ${y1} H${midX} V${y2} H${x2}`,
            }),
          );
        }
      }
      const nodes = [];
      for (const task of tasks) {
        const at = positions.get(task.id);
        if (at === undefined) continue;
        const blocked = task.status === "pending" && task.ready === false;
        const owner = task.ownerName ?? task.ownerId ?? t("unowned");
        const subtitle = `${clip(owner, 16)} · ${t(task.status)}${blocked ? ` · ${t("blocked")}` : ""}`;
        nodes.push(
          h(
            "g",
            { key: task.id, transform: `translate(${at.x} ${at.y})` },
            h("rect", { className: "tp-node", width: CARD_W, height: CARD_H, rx: 8, "data-status": task.status }),
            h("circle", {
              className: "tp-glyph",
              cx: 12,
              cy: 15,
              r: 3.2,
              "data-status": task.status,
              "data-blocked": blocked ? "true" : "false",
            }),
            h("text", { x: 21, y: 18.5 }, clip(task.subject, 21)),
            h("text", { className: "tp-sub", x: 12, y: 33.5 }, subtitle),
          ),
        );
      }
      return h(
        "svg",
        {
          className: "tp-graph",
          viewBox: `-2 -2 ${width + 4} ${height + 4}`,
          preserveAspectRatio: "xMidYMin meet",
          role: "img",
          "aria-label": t("tasks"),
          "data-team-graph": tasks.length,
        },
        h("g", null, edges),
        h("g", null, nodes),
      );
    }

    /** One member row: identity, live state, occupancy bar, and actions. */
    function MemberRow(props) {
      const { member, t, retired, actions } = props;
      const [confirming, setConfirming] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const pressure = member.pressure;
      const windowSize = pressure !== undefined && typeof pressure.contextWindow === "number" ? pressure.contextWindow : undefined;
      const used =
        pressure === undefined
          ? undefined
          : typeof pressure.projectedTokens === "number"
            ? pressure.projectedTokens
            : typeof pressure.pressureTokens === "number"
              ? pressure.pressureTokens
              : undefined;
      const fraction = windowSize !== undefined && used !== undefined && windowSize > 0 ? Math.min(1, used / windowSize) : undefined;
      const running = member.summary !== undefined && member.summary.running === true;
      const state = retired ? "retired" : running ? "running" : "idle";

      const run = async (task, failureLabel) => {
        setBusy(true);
        setError(null);
        try {
          await task();
          setConfirming(false);
        } catch (cause) {
          setError(`${failureLabel}: ${cause && cause.message ? cause.message : cause}`);
        } finally {
          setBusy(false);
        }
      };

      return h(
        "div",
        { className: "tp-member", "data-retired": retired ? "true" : "false", "data-team-member": member.id },
        h(
          "div",
          { className: "tp-row" },
          h("span", { className: "tp-dot", "data-state": state, "aria-hidden": "true" }),
          h("span", { className: "tp-name", title: member.name }, `@${member.name}`),
          h("span", { className: "tp-muted" }, member.lead === true ? t("lead") : t("teammate")),
          h("span", { className: "tp-spacer" }),
          h("button", { type: "button", className: "tp-link", onClick: () => actions.open(member.id) }, t("openChat")),
          retired
            ? h(
                "button",
                {
                  type: "button",
                  className: "tp-link",
                  disabled: busy,
                  onClick: () => run(() => actions.restore(member.id), t("restoreFailed")),
                },
                t("restore"),
              )
            : h(
                "button",
                {
                  type: "button",
                  className: "tp-link",
                  "data-tone": "muted",
                  disabled: busy,
                  onClick: () => setConfirming((current) => !current),
                },
                t("retire"),
              ),
        ),
        h(
          "div",
          { className: "tp-row" },
          h("span", { className: "tp-muted" }, `${t("context")} ${used === undefined ? "?" : tokens(used)}`),
          h(
            "div",
            {
              className: "tp-bar",
              "data-level": fraction === undefined ? "normal" : barLevel(fraction),
              style: { flex: "1 1 auto" },
            },
            h("span", { style: { width: `${fraction === undefined ? 0 : Math.round(fraction * 100)}%` } }),
          ),
          h("span", { className: "tp-muted" }, windowSize === undefined ? t("unknown") : tokens(windowSize)),
          h("span", { className: "tp-muted" }, running ? t("running") : retired ? t("archived") : t("idle")),
        ),
        confirming
          ? h(
              "div",
              { className: "tp-confirm" },
              h("span", null, t("retireConfirm")),
              h("span", { className: "tp-muted" }, t("retireHint")),
              h("span", { className: "tp-spacer" }),
              h(
                "button",
                {
                  type: "button",
                  "data-role": "danger",
                  disabled: busy,
                  onClick: () => run(() => actions.retire(member.id), t("retireFailed")),
                },
                t("confirm"),
              ),
              h("button", { type: "button", disabled: busy, onClick: () => setConfirming(false) }, t("cancel")),
            )
          : null,
        error === null ? null : h("div", { className: "tp-error", role: "alert" }, error),
      );
    }

    /**
     * Read the panel's data from the Session projections and the Workspace
     * snapshot. Every hook runs unconditionally on every render.
     */
    function useTeamData(props) {
      const { sessionId, useProjection, useSessions, useWorkspaces } = props;
      const catalog = useProjection("subagentCatalog");
      const team = useProjection("agentTeam");
      const leadPressure = useProjection("contextPressure");
      const projections = useSessions((state) => state.projectionsBySession);
      const summaries = useSessions((state) => state.byId);
      const archivedIds = useWorkspaces((state) => state.archivedSessionIds);

      const archived = new Set(archivedIds === undefined ? [] : archivedIds);
      const members = [];
      const leadSummary = summaries === undefined ? undefined : summaries[sessionId];
      const leadEntry = catalog === undefined ? undefined : catalog.find((entry) => entry.id === sessionId);
      members.push({
        id: sessionId,
        name: leadEntry !== undefined && typeof leadEntry.name === "string" ? leadEntry.name : "lead",
        lead: true,
        summary: leadSummary,
        pressure: leadPressure,
      });
      const children = catalog === undefined ? [] : catalog;
      for (const entry of children) {
        if (entry === undefined || entry.id === sessionId) continue;
        if (typeof entry.name !== "string") continue;
        const owned = projections === undefined ? undefined : projections[entry.id];
        members.push({
          id: entry.id,
          name: entry.name,
          lead: false,
          summary: summaries === undefined ? undefined : summaries[entry.id],
          pressure: owned === undefined ? undefined : owned.values.contextPressure,
        });
      }
      const tasks = team === undefined || team.tasks === undefined ? [] : team.tasks.filter((task) => task.status !== "deleted");
      return { members, tasks, archived, enabled: team !== undefined && team.enabled === true };
    }

    /** Header action: opens the panel and carries the live counts. */
    function TeamPanelTrigger(props) {
      const { t } = props;
      const data = useTeamData(props);
      const live = data.members.filter((member) => !data.archived.has(member.id)).length;
      return h(
        "button",
        {
          type: "button",
          className: "tp-button",
          onClick: () => props.openPanel(),
          title: t("open"),
          "data-team-panel-trigger": "",
        },
        h(TeamIcon, { size: 14 }),
        h("span", null, t("open")),
        live > 0 ? h("span", { className: "tp-badge" }, String(live)) : null,
        data.tasks.length > 0 ? h("span", { className: "tp-badge" }, String(data.tasks.length)) : null,
      );
    }

    /** The overlay panel: roster, occupancy, retire/restore, dependency graph. */
    function TeamPanel(props) {
      const { t, close, isOpen, actions } = props;
      const data = useTeamData(props);
      const open = isOpen();
      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === "Escape") close();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [open]);
      if (!open) return null;
      const live = data.members.filter((member) => !data.archived.has(member.id));
      const retired = data.members.filter((member) => data.archived.has(member.id));
      const renderMember = (member) =>
        h(MemberRow, {
          key: member.id,
          member,
          t,
          retired: data.archived.has(member.id),
          actions,
        });
      return h(
        "div",
        { className: "tp-scrim", onClick: close, "data-team-panel-overlay": "" },
        h(
          "div",
          {
            className: "tp-panel",
            onClick: (event) => event.stopPropagation(),
            role: "dialog",
            "aria-modal": "true",
            "aria-label": t("title"),
            "data-team-panel": "",
          },
          h(
            "div",
            { className: "tp-head" },
            h(TeamIcon, { size: 15 }),
            h("h2", null, t("title")),
            h(
              "button",
              { type: "button", className: "tp-icon", onClick: close, title: t("close"), "aria-label": t("close") },
              h(CloseIcon, null),
            ),
          ),
          h(
            "div",
            { className: "tp-body" },
            h(
              "div",
              { className: "tp-section" },
              h("div", { className: "tp-section-title" }, t("members"), h("span", { className: "tp-count" }, `${live.length}/${data.members.length}`)),
              live.length === 0 ? h("div", { className: "tp-empty" }, t("noMembers")) : live.map(renderMember),
            ),
            retired.length === 0
              ? null
              : h(
                  "div",
                  { className: "tp-section", "data-team-retired-section": "" },
                  h("div", { className: "tp-section-title" }, t("retired"), h("span", { className: "tp-count" }, String(retired.length))),
                  retired.map(renderMember),
                ),
            h(
              "div",
              { className: "tp-section" },
              h("div", { className: "tp-section-title" }, t("tasks"), h("span", { className: "tp-count" }, String(data.tasks.length))),
              data.tasks.length === 0 ? h("div", { className: "tp-empty" }, t("noTasks")) : h(TaskGraph, { tasks: data.tasks, t }),
            ),
          ),
        ),
      );
    }

    /** Required Client services: slots and localized copy. */
    const inject = ["slots", "locale"];

    /**
     * Register dictionaries, the stylesheet, the header trigger, and the panel.
     * @param ctx - Client Context carrying the injected slot and locale services.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "team-panel: dictionaries");
      const t = ctx.locale.bind(NS);

      ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.plugin = "team-panel";
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => {
          style.remove();
        };
      }, "team-panel: stylesheet");

      /** Panel visibility shared by the trigger and the overlay. */
      let open = false;
      const listeners = new Set();
      const setOpen = (value) => {
        if (open === value) return;
        open = value;
        for (const listener of listeners) listener();
      };
      const subscribe = (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };
      const isOpen = () => open;

      /** Workspace archive operations: absent services fail loudly in the row. */
      const workspace = () => {
        const service = ctx.get("uiWorkspace");
        if (service === undefined) throw new Error("uiWorkspace is unavailable");
        return service;
      };
      const actions = {
        open: (sessionId) => {
          workspace().openSession(sessionId);
          setOpen(false);
        },
        retire: (sessionId) => workspace().archiveSession(sessionId, { stopActivity: true }),
        restore: (sessionId) => workspace().unarchiveSession(sessionId),
      };

      ctx.slots.inject("conversation.session.header.actions", () =>
        ctx.slots.register(
          {
            name: "conversation.session.header.actions",
            id: "team-panel",
            order: 15,
            locale: NS,
            inject: () => ({ t, openPanel: () => setOpen(true) }),
          },
          TeamPanelTrigger,
        ),
      );

      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          {
            name: "shell.overlay",
            id: "team-panel",
            order: 300,
            locale: NS,
            inject: () => ({ t, close: () => setOpen(false), isOpen, actions }),
          },
          TeamPanel,
        ),
      );

      ctx.effect(() => () => {
        listeners.clear();
      }, "team-panel: visibility listeners");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
