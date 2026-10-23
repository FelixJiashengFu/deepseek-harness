/**
 * Browser half of dsh-parallel-workers: the "并行 / Parallel" toggle in the composer's right-hand
 * seat (`conversation.input.right`, next to the model selector).
 *
 * The state comes from the host's `parallel-workers` session projection (the folded log, not client
 * optimism), so reloads, resumed sessions and other windows agree. Clicking runs `/parallel on` or
 * `/parallel off` through the session's command channel; the host records the change and, while the
 * mode is on, adds a system-prompt section that sends large splittable tasks through the `deliver`
 * skill and the mcp__harness__* tools.
 *
 * Authored directly in the loader's bundle format, with no build step. Keep every `require()` inside
 * the platform module table (react is seeded there).
 */
window.__ModuleLoader__.load({
  id: "dsh-parallel-workers",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    const PLUGIN_ID = "dsh-parallel-workers";
    /** Locale namespace and projection key. */
    const NS = "parallel-workers";
    /** Composer seat: a list slot right of the input, before the model selector. */
    const SEAT = "conversation.input.right";

    const CSS = [
      ".dshpw-wrap{align-items:center;gap:6px;display:inline-flex}",
      ".dshpw-chip{border-radius:var(--dsw-radius-sm);background:transparent;min-width:34px;height:28px;",
      "color:var(--dsw-alias-label-secondary);cursor:pointer;border:none;align-items:center;gap:4px;padding:0 8px;",
      "font-size:13px;font-weight:500;line-height:20px;display:inline-flex;transition:background-color .12s,color .12s}",
      ".dshpw-chip:hover:not(:disabled){background:color-mix(in srgb,transparent,var(--dsw-alias-label-primary) 8%);color:var(--dsw-alias-label-primary)}",
      ".dshpw-chip.dshpw-on{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}",
      ".dshpw-chip.dshpw-on:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-business-tertiary),var(--dsw-alias-state-business-primary) 6%);color:var(--dsw-alias-state-business-primary)}",
      ".dshpw-chip:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
      ".dshpw-chip:disabled{opacity:.6;cursor:default}",
      ".dshpw-glyph{flex:none;width:14px;height:14px;display:inline-flex}",
      ".dshpw-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}",
    ].join("");

    /** Add the stylesheet once; the returned disposer removes it when the plugin unloads. */
    function installStyles() {
      if (typeof document === "undefined") return () => {};
      const tagId = PLUGIN_ID + "/toggle.css";
      let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]");
      if (tag === null) {
        tag = document.createElement("style");
        tag.dataset.plugin = PLUGIN_ID;
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }
      return () => tag.remove();
    }

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      "label": "并行",
      "off.aria": "并行交付模式已关闭，按下开启",
      "off.title": "并行交付：关闭 — 点击开启，大任务会拆给多个 DeepSeek 工人并行完成（/parallel on）",
      "on.aria": "并行交付模式已开启，按下关闭",
      "on.title": "并行交付：已开启 — 可拆分的大任务会交给 DeepSeek 工人并行完成；点击关闭（/parallel off）",
      "failed": "切换失败",
    };
    /** English dictionary, with the same keys. */
    const en = {
      "label": "Parallel",
      "off.aria": "Parallel delivery mode off, press to turn on",
      "off.title": "Parallel delivery: off — click to split large tasks across DeepSeek workers (/parallel on)",
      "on.aria": "Parallel delivery mode on, press to turn off",
      "on.title": "Parallel delivery: on — large splittable tasks go to DeepSeek workers; click to turn off (/parallel off)",
      "failed": "Could not switch",
    };

    /** One dot fanning out into three lanes. */
    function FanGlyph() {
      return h(
        "svg",
        { className: "dshpw-glyph", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", "aria-hidden": true },
        h("circle", { cx: 3, cy: 8, r: 1.7, fill: "currentColor", stroke: "none" }),
        h("path", { d: "M4.6 8h2.6M7.2 8c2.2 0 2-4.6 4.4-4.6h1.4M7.2 8h5.8M7.2 8c2.2 0 2 4.6 4.4 4.6h1.4" }),
      );
    }

    function ParallelToggle({ useProjection, setMode, t }) {
      const mode = useProjection(NS);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const aliveRef = React.useRef(true);
      React.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);
      // No projection means the host half is not composed here: show nothing.
      if (mode === undefined || mode === null) return null;
      const on = mode.active === true;
      const toggle = () => {
        setBusy(true);
        setError(null);
        setMode(!on).then(
          (failure) => {
            if (!aliveRef.current) return;
            setBusy(false);
            setError(failure);
          },
          (reason) => {
            if (!aliveRef.current) return;
            setBusy(false);
            setError(reason instanceof Error ? reason.message : String(reason));
          },
        );
      };
      return h(
        "span",
        { className: "dshpw-wrap" },
        h(
          "button",
          {
            type: "button",
            className: on ? "dshpw-chip dshpw-on" : "dshpw-chip",
            "aria-pressed": on,
            "aria-label": t(on ? "on.aria" : "off.aria"),
            title: t(on ? "on.title" : "off.title"),
            disabled: busy,
            onClick: toggle,
          },
          h(FanGlyph),
          t("label"),
        ),
        error !== null ? h("span", { className: "dshpw-error", role: "status", title: error }, t("failed")) : null,
      );
    }

    /** Services this browser half needs. */
    const inject = ["slots", "remote", "remote.commands", "locale"];

    /**
     * Register the toggle into the composer's right seat. `ctx.slots.inject` waits for the
     * conversation UI to declare the seat, so load order does not matter.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(installStyles, "parallel-workers: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "parallel-workers: dictionaries");
      ctx.slots.inject(SEAT, () => ctx.slots.register({
        name: SEAT,
        id: "parallel-workers",
        order: 0,
        locale: NS,
        inject: (sessionId) => ({
          setMode: async (on) => {
            const line = on ? "/parallel on" : "/parallel off";
            const result = await ctx.remote.commands.execute(sessionId, line, []);
            if (!result.ok) return `${result.error.message} (${result.error.code})`;
            if (result.value === undefined) return "unknown command: /parallel";
            if (result.value && result.value.kind === "error") return result.value.text || "error";
            return null;
          },
        }),
      }, ParallelToggle));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
