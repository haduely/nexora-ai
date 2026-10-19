/**
 * Nexora AI — application bootstrap: navigation, top bar, server status,
 * settings actions, and responsive sidebar. Stage 2.
 */
(function (global) {
  "use strict";

  const store = global.NexoraStore;

  const VIEW_META = {
    chat: { title: "Chat", subtitle: "Describe what you want to build" },
    projects: { title: "Projects", subtitle: "Organize conversations by game — Stage 3" },
    studio: { title: "Studio", subtitle: "Connection status and project access" },
    models: { title: "Models", subtitle: "Configure providers, keys, and models" },
    settings: { title: "Settings", subtitle: "Server, preferences, and security" }
  };

  let toastTimer = null;

  /* -------------------------------- toast ----------------------------- */

  function showToast(message) {
    const el = document.getElementById("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove("show");
    }, 2800);
  }

  /* ----------------------------- navigation --------------------------- */

  function setView(name, opts) {
    const persist = !opts || opts.persist !== false;
    if (!VIEW_META[name]) name = "chat";

    document.querySelectorAll(".nav-item").forEach(function (item) {
      item.classList.toggle("active", item.getAttribute("data-view") === name);
    });
    document.querySelectorAll("[data-view-panel]").forEach(function (panel) {
      panel.classList.toggle("hidden", panel.getAttribute("data-view-panel") !== name);
    });

    document.getElementById("viewTitle").textContent = VIEW_META[name].title;
    document.getElementById("viewSubtitle").textContent = VIEW_META[name].subtitle;

    if (persist) {
      store.state.prefs.lastView = name;
      store.savePrefs();
    }

    closeSidebar();

    if (name === "chat") {
      setTimeout(function () { document.getElementById("composerInput").focus(); }, 60);
    }
    if (name === "settings") refreshHealth();
    if (name === "models") loadModels();
    if (name === "studio") refreshStudio(true);
  }

  function openSidebar() {
    document.getElementById("sidebar").classList.add("open");
    document.getElementById("sidebarOverlay").hidden = false;
  }
  function closeSidebar() {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("sidebarOverlay").hidden = true;
  }

  /* ---------------------------- server status ------------------------- */

  async function fetchJson(path, body) {
    const options = { headers: { Accept: "application/json" } };
    if (body !== undefined) {
      options.method = "POST";
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const res = await fetch(path, options);
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = null; }
    if (!res.ok) {
      const err = new Error((parsed && parsed.error && (parsed.error.message || parsed.error)) || "HTTP " + res.status);
      err.status = res.status;
      err.payload = parsed;
      throw err;
    }
    if (!parsed) throw new Error("Invalid response from server.");
    return parsed;
  }

  function renderHealth() {
    const h = store.state.boot.health;
    const urlEl = document.getElementById("setServerUrl");
    const healthEl = document.getElementById("setServerHealth");
    const verEl = document.getElementById("setServerVersion");
    const stageEl = document.getElementById("setBuildStage");
    if (!urlEl) return;

    urlEl.textContent = global.location.origin;
    if (!h) {
      healthEl.textContent = "checking…";
      healthEl.className = "";
      verEl.textContent = "—";
      if (stageEl) stageEl.textContent = "—";
    } else if (h.error) {
      healthEl.textContent = "unreachable (" + h.error + ")";
      healthEl.className = "err";
      verEl.textContent = "—";
      if (stageEl) stageEl.textContent = "—";
    } else {
      healthEl.textContent = "ok";
      healthEl.className = "ok";
      verEl.textContent = h.product + " " + h.version;
      if (stageEl) stageEl.textContent = "Stage " + h.stage + " — " + h.stageName;
    }
  }

  async function refreshHealth() {
    renderHealth();
    try {
      store.state.boot.health = await fetchJson("/api/health");
    } catch (err) {
      store.state.boot.health = { error: err.message };
    }
    renderHealth();
  }

  /* --------------------------- provider status ------------------------ */

  function renderModels() {
    const m = store.state.boot.models;
    const summary = document.getElementById("modelsSummary");
    const note = document.getElementById("modelsNote");
    const dot = document.getElementById("modelsDot");
    const chipText = document.getElementById("modelChipText");
    const sideAi = document.getElementById("sideAiStatus");
    if (!summary) return;

    if (!m) {
      summary.textContent = "Checking configuration…";
      note.textContent = "Asking the local server what is actually configured.";
      return;
    }
    if (m.error) {
      summary.textContent = "Local server unreachable";
      note.textContent = "Could not reach the Nexora server (" + m.error + "). The interface keeps working; retry with Refresh.";
      chipText.textContent = "Server unreachable";
      if (dot) dot.className = "dot dot-err dot-lg";
      if (sideAi) sideAi.innerHTML = '<span class="dot dot-err"></span><span>AI · server unreachable</span>';
      return;
    }

    if (m.active && m.active.id && m.providers && m.providers[m.active.id]) {
      const p = m.providers[m.active.id];
      summary.textContent = "Active: " + p.label + (m.active.model ? " · " + m.active.model : "");
      note.textContent = p.internetRequired
        ? "Requires internet. Chat requests are proxied through this local server — your key never reaches the browser."
        : "Runs locally on your machine. No internet required.";
      chipText.textContent = (m.active.model || p.label);
      if (dot) dot.className = "dot dot-ok dot-lg";
      if (sideAi) sideAi.innerHTML = '<span class="dot dot-ok"></span><span>AI · ready</span>';
    } else {
      summary.textContent = "No AI provider is active";
      note.textContent = "Save & Activate one of the providers below. Pollinations works immediately with no key.";
      chipText.textContent = "No model configured";
      if (dot) dot.className = "dot dot-warn dot-lg";
      if (sideAi) sideAi.innerHTML = '<span class="dot dot-warn"></span><span>AI · not configured</span>';
    }

    if (global.NexoraProviders) global.NexoraProviders.render(m);
  }

  async function loadModels() {
    renderModels();
    try {
      store.state.boot.models = await fetchJson("/api/providers");
    } catch (err) {
      store.state.boot.models = { error: err.message };
    }
    renderModels();
  }

  // Used by the Models cards after a save/test so the top bar + cards refresh.
  function refreshModelsView() {
    loadModels();
  }

  /* ----------------------------- studio status ------------------------ */

  function renderStudio() {
    const s = store.state.boot.studio;
    const pill = document.getElementById("studioPill");
    const side = document.getElementById("sideStudioStatus");
    const badge = document.getElementById("studioBadge");
    const dot = document.getElementById("studioDot");
    const title = document.getElementById("studioStatusTitle");
    const detail = document.getElementById("studioStatusDetail");
    if (!pill) return;

    if (!s) {
      pill.innerHTML = '<span class="dot dot-off"></span> Studio · checking…';
      return;
    }

    const connected = s.connected === true;
    const label = connected ? s.kind.toUpperCase() : "Disconnected";
    const dotClass = connected ? "dot dot-ok" : "dot dot-off";

    pill.innerHTML = '<span class="' + dotClass + '"></span> Studio · ' + label;
    if (side) side.innerHTML = '<span class="' + dotClass + '"></span><span>Studio · ' + (connected ? "connected" : "disconnected") + "</span>";
    if (badge) {
      badge.textContent = connected ? "Connected" : "Disconnected";
      badge.className = "badge" + (connected ? "" : " badge-off");
    }
    if (dot) dot.className = "dot dot-lg " + (connected ? "dot-ok" : "dot-off");
    if (title) title.textContent = connected ? "Connected via " + label : "Disconnected";
    if (detail) {
      const urlLine = s.url ? " Probed: <code>" + escapeHtml(s.url) + "</code>." : "";
      const toolLine = s.toolCount ? " Tools available: <b>" + s.toolCount + "</b> — chat can inspect the real project." : "";
      const errLine = s.detail ? " " + escapeHtml(s.detail) + "." : "";
      detail.innerHTML = connected
        ? "A real local endpoint answered." + toolLine + urlLine
        : "Nexora reports <b>Connected</b> only after a real local bridge or MCP server responds — never otherwise." + errLine + urlLine;
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  async function refreshStudio(force) {
    if (store.state.boot.studio === undefined) renderStudio();
    try {
      store.state.boot.studio = await fetchJson("/api/studio/status" + (force ? "?refresh=1" : ""));
    } catch (err) {
      store.state.boot.studio = { connected: false, detail: "status check failed: " + err.message, toolCount: 0 };
    }
    renderStudio();
  }

  /* --------------------------------- init ----------------------------- */

  function init() {
    store.state.prefs = store.loadPrefs();

    document.querySelectorAll(".nav-item").forEach(function (item) {
      item.addEventListener("click", function () {
        setView(item.getAttribute("data-view"));
      });
    });

    document.getElementById("btnNewChat").addEventListener("click", function () {
      store.createConversation();
      global.NexoraChat.renderAll();
      setView("chat");
      showToast("Started a new chat.");
    });

    document.getElementById("modelChip").addEventListener("click", function () {
      setView("models");
    });

    document.getElementById("btnMenu").addEventListener("click", function () {
      const sidebar = document.getElementById("sidebar");
      if (sidebar.classList.contains("open")) closeSidebar();
      else openSidebar();
    });
    document.getElementById("sidebarOverlay").addEventListener("click", closeSidebar);

    document.getElementById("btnModelsRefresh").addEventListener("click", function () {
      loadModels();
      showToast("Re-reading provider configuration from the server.");
    });

    document.getElementById("btnRecheckHealth").addEventListener("click", function () {
      refreshHealth();
      showToast("Re-checking local server health…");
    });
    document.getElementById("btnClearPrefs").addEventListener("click", function () {
      store.clearPrefs();
      showToast("Local preferences cleared.");
      setTimeout(function () { global.location.reload(); }, 700);
    });

    if (global.NexoraProviders) global.NexoraProviders.init();
    global.NexoraChat.init();

    setView(store.state.prefs.lastView || "chat", { persist: false });
    refreshHealth();
    loadModels();
    refreshStudio(false);
  }

  global.NexoraApp = {
    init: init,
    setView: setView,
    showToast: showToast,
    fetchJson: fetchJson,
    refreshHealth: refreshHealth,
    loadModels: loadModels,
    refreshModelsView: refreshModelsView,
    refreshStudio: refreshStudio
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
