(async () => {
  const page = parseDocsUrl(location.href);
  if (!page) return;

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const target = settings.targetDistro;
  const tab = (await send({ type: "tabState" })) ?? { stayed: [], note: null };

  if (tab.note) {
    whenReady(() => {
      showNote(tab.note);
      send({ type: "clearNote" });
    });
  }

  if (settings.mode === "off" || page.distro === target) return;
  if (!settings.redirectFromNewer && distroIndex(page.distro) > distroIndex(target)) return;
  if (tab.stayed.includes(page.distro)) return;

  const result = await send({
    type: "resolve",
    url: location.href,
    target,
    smart: settings.verifyExists,
  });
  if (!result) return;
  const { match, fallbacks } = result;

  // Only switch automatically when we're confident it's the same page (or the
  // user turned lookups off and asked for a plain path swap), and not when the
  // user just came here from the target distro (e.g. via the version picker) —
  // they switched on purpose.
  const confident =
    match &&
    (match.confidence === "exact" ||
      match.confidence === "moved" ||
      (match.confidence === "unverified" && !settings.verifyExists));
  const cameFromTarget = parseDocsUrl(document.referrer)?.distro === target;
  let mode = settings.mode;
  if (!confident || cameFromTarget) mode = "manual";

  if (mode === "auto") {
    await go(match, true);
    return;
  }
  whenReady(() => showBanner(mode, match, fallbacks));

  // -------------------------------------------------------------------------

  async function go(match, automatic) {
    if (automatic) {
      await send({
        type: "setNote",
        note: { from: location.href, fromDistro: page.distro, confidence: match.confidence },
      });
    }
    location.replace(match.url);
  }

  async function stay(distro) {
    await send({ type: "stay", distro });
  }

  // Runs `fn` once the DOM is ready, unless this is docs.ros.org's bot-check
  // page (served at the real URL; it reloads into the real page when done).
  function whenReady(fn) {
    const run = () => {
      if (!document.querySelector('[href*="/.within.website/"], [src*="/.within.website/"]')) fn();
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }
  }

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c != null));
    return node;
  }

  // A card in the bottom-right corner, isolated from the page's styles.
  function createCard() {
    const host = el("div", { id: "ros-docs-version-redirect" });
    const root = host.attachShadow({ mode: "closed" });
    root.append(el("style", { textContent: CARD_CSS }));
    const card = el("div", { className: "card", role: "status" });
    const msg = el("div", { className: "msg" });
    const close = el("button", { className: "close", title: "Dismiss", textContent: "×" });
    close.setAttribute("aria-label", "Dismiss");
    const actions = el("div", { className: "actions" });
    card.append(el("div", { className: "head" }, msg, close), actions);
    root.append(card);
    document.documentElement.append(host);

    const api = {
      card,
      msg,
      actions,
      onDismiss: () => {},
      dismiss() {
        api.onDismiss();
        host.remove();
      },
      setMessage(main, sub) {
        msg.replaceChildren(...main, ...(sub ? [el("div", { className: "sub" }, sub)] : []));
      },
      button(label, onClick, primary = false) {
        const b = el("button", { className: "btn" + (primary ? " primary" : ""), textContent: label });
        b.addEventListener("click", onClick);
        actions.append(b);
      },
      link(label, href, primary = false) {
        actions.append(el("a", { className: "btn" + (primary ? " primary" : ""), textContent: label, href }));
      },
    };
    close.addEventListener("click", () => api.dismiss());
    return api;
  }

  function showBanner(mode, match, fallbacks) {
    const C = distroLabel(page.distro);
    const T = distroLabel(target);
    const ui = createCard();
    const viewing = ["You're viewing ", el("b", { textContent: C }), " docs."];
    const quoted = (t) => `“${t}”`;
    const stayButton = () =>
      ui.button(`Stay on ${C}`, async () => {
        await stay(page.distro);
        ui.dismiss();
      });

    if (!match) {
      ui.setMessage(viewing, `This page doesn't exist in ${T}.`);
      fallbacks.forEach((f, i) => ui.link(f.label, f.url, i === 0));
      stayButton();
      return;
    }

    const detail = {
      exact: null,
      unverified: null,
      moved: match.title ? `In ${T} this page moved: ${quoted(match.title)}.` : `This page moved in ${T}.`,
      fuzzy: `This page isn't in ${T}. Closest match: ${quoted(match.title)}.`,
    }[match.confidence];

    const renderManual = () => {
      ui.onDismiss();
      ui.card.querySelector(".bar")?.remove();
      ui.actions.replaceChildren();
      ui.setMessage(viewing, detail);
      ui.link(match.confidence === "fuzzy" ? "Open closest match" : `Open ${T} version`, match.url, true);
      if (match.confidence === "fuzzy") fallbacks.forEach((f) => ui.link(f.label, f.url));
      stayButton();
    };

    if (mode !== "delayed") {
      renderManual();
      return;
    }

    let remaining = Math.max(1, Number(settings.delaySeconds) || DEFAULT_SETTINGS.delaySeconds);
    const total = remaining;
    const render = () =>
      ui.setMessage(
        [...viewing, ` Switching to `, el("b", { textContent: T }), ` in ${remaining}s…`],
        match.confidence === "moved" ? detail : null
      );
    render();
    ui.button("Go now", () => go(match, false), true);
    ui.button("Cancel", renderManual);
    stayButton();

    const fill = el("div");
    ui.card.append(el("div", { className: "bar" }, fill));
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        fill.style.transition = `width ${total}s linear`;
        fill.style.width = "0%";
      })
    );

    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) return render();
      clearInterval(timer);
      go(match, false);
    }, 1000);
    ui.onDismiss = () => clearInterval(timer);
  }

  // Shown on the destination page after an automatic redirect.
  function showNote(note) {
    const C = distroLabel(note.fromDistro);
    const ui = createCard();
    ui.setMessage(
      ["Switched from ", el("b", { textContent: C }), " docs."],
      note.confidence === "moved" ? "The page has a different location in this version." : null
    );
    ui.button(`Back to ${C} page`, async () => {
      await stay(note.fromDistro);
      location.href = note.from;
    });

    let hideTimer = setTimeout(() => ui.dismiss(), 8000);
    ui.card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    ui.card.addEventListener("mouseleave", () => (hideTimer = setTimeout(() => ui.dismiss(), 4000)));
    ui.onDismiss = () => clearTimeout(hideTimer);
  }
})();

const CARD_CSS = `
  :host { all: initial; }
  .card {
    --bg: #ffffff; --fg: #18181b; --muted: #71717a; --line: #e4e4e7; --hover: #f4f4f5;
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    max-width: min(360px, calc(100vw - 32px)); box-sizing: border-box; overflow: hidden;
    padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line);
    background: var(--bg); color: var(--fg);
    box-shadow: 0 4px 24px rgba(0,0,0,.08);
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    animation: enter .18s ease-out;
  }
  @media (prefers-color-scheme: dark) {
    .card {
      --bg: #18181b; --fg: #f4f4f5; --muted: #a1a1aa; --line: #2e2e33; --hover: #27272a;
      box-shadow: 0 4px 24px rgba(0,0,0,.4);
    }
  }
  @keyframes enter { from { opacity: 0; transform: translateY(6px); } }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
  b { font-weight: 600; }
  .head { display: flex; gap: 12px; align-items: flex-start; }
  .msg { flex: 1; }
  .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .close {
    flex: none; display: grid; place-items: center; width: 20px; height: 20px; margin: -1px -6px 0 0;
    border: 0; border-radius: 5px; background: none; color: var(--muted); cursor: pointer;
    font: 16px/1 system-ui, sans-serif; padding: 0;
  }
  .close:hover { background: var(--hover); color: var(--fg); }
  .actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
  .btn {
    font: inherit; font-size: 12.5px; font-weight: 500; padding: 5px 10px; border-radius: 6px;
    border: 0; background: none; color: var(--muted); cursor: pointer; text-decoration: none;
    transition: background .15s, color .15s;
  }
  .btn:hover { background: var(--hover); color: var(--fg); }
  .btn.primary, .btn.primary:hover { background: var(--fg); color: var(--bg); }
  .btn.primary:hover { opacity: .85; }
  .btn:focus-visible, .close:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; }
  .bar > div { height: 100%; width: 100%; background: var(--muted); }
`;
