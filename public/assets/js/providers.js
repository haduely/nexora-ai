/**
 * Nexora AI — Models view: real provider configuration.
 *
 * Renders a card per provider adapter, saves configuration to the local
 * server (API keys are write-only — they are never rendered back into the
 * page), tests connections, and loads live model lists.
 */
(function (global) {
  "use strict";

  const PROVIDER_ORDER = ["pollinations", "gemini", "ollama", "openai"];

  const DESCRIPTIONS = {
    pollinations: "Keyless free community endpoint — chat works with zero setup. Requires internet; no account or key.",
    gemini: "Google's Gemini API — free tier available with a key from Google AI Studio. Requires internet.",
    ollama: "Local open-source models running on your machine via Ollama. No key, no internet, fully private.",
    openai: "Any OpenAI-compatible API (Groq, OpenRouter, OpenAI, and similar). Key and pricing depend on the provider you choose."
  };

  const els = {};
  let lastView = null; // last public provider view from the server

  function cacheEls() {
    els.grid = document.getElementById("providerGrid");
    els.summary = document.getElementById("modelsSummary");
    els.note = document.getElementById("modelsNote");
    els.dot = document.getElementById("modelsDot");
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function api(path, body) {
    return global.NexoraApp.fetchJson(path, body);
  }

  /* ------------------------------ card UI ------------------------------ */

  function cardHtml(id, p) {
    const statusTag = p.configured
      ? '<span class="tag tag-ok">' + (p.hasKey ? "Configured" : "Available") + "</span>"
      : '<span class="tag tag-warn">Not configured</span>';

    let fields = "";
    if (!p.keyless) {
      fields +=
        '<label class="field"><span>API key</span>' +
        '<input type="password" id="pf-' + id + '-key" autocomplete="off" spellcheck="false" ' +
        'placeholder="' + (p.hasKey ? "Key stored on server — type to replace" : "Paste API key (stored on server only)") + '" />' +
        "</label>";
      if (p.hasKey) {
        fields += '<button class="link-btn" type="button" data-act="clear-key">Remove stored key</button>';
      }
    }
    if (id === "ollama" || id === "openai") {
      fields +=
        '<label class="field"><span>Base URL</span>' +
        '<input type="text" id="pf-' + id + '-base" spellcheck="false" value="' + esc(p.baseUrl) + '" ' +
        'placeholder="' + (id === "ollama" ? "http://127.0.0.1:11434" : "https://api.example.com/v1") + '" />' +
        "</label>";
    }
    fields +=
      '<label class="field"><span>Model</span>' +
      '<input type="text" id="pf-' + id + '-model" list="pfl-' + id + '" spellcheck="false" value="' + esc(p.model) + '" ' +
      'placeholder="model id" />' +
      '<datalist id="pfl-' + id + '"></datalist>' +
      "</label>";

    return (
      '<div class="provider-card" data-provider="' + id + '">' +
      '<div class="provider-card-head">' +
      "<div><h3>" + esc(p.label) + "</h3></div>" +
      statusTag +
      "</div>" +
      '<p class="provider-desc">' + esc(DESCRIPTIONS[id] || "") + "</p>" +
      '<div class="provider-tags">' +
      (p.keyless ? '<span class="tag">No key needed</span>' : '<span class="tag">Key required</span>') +
      '<span class="tag">' + (p.internetRequired ? "Requires internet" : "Runs locally") + "</span>" +
      (p.model ? '<span class="tag">Active model: ' + esc(p.model) + "</span>" : "") +
      "</div>" +
      '<div class="provider-fields">' + fields + "</div>" +
      '<div class="provider-actions">' +
      '<button class="btn btn-primary btn-sm" type="button" data-act="save">Save &amp; Activate</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-act="test">Test connection</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-act="load-models">Load models</button>' +
      "</div>" +
      '<div class="provider-result" data-result hidden></div>' +
      '<p class="provider-hint">' + esc(p.keyHint || "") + "</p>" +
      "</div>"
    );
  }

  function render(view) {
    if (!els.grid) return;
    if (view) lastView = view;
    if (!lastView || !lastView.providers) {
      els.grid.innerHTML = '<p class="muted">Waiting for the local server…</p>';
      return;
    }
    const activeId = lastView.active && lastView.active.id;
    els.grid.innerHTML = PROVIDER_ORDER.filter((id) => lastView.providers[id])
      .map((id) => {
        const html = cardHtml(id, lastView.providers[id]);
        return activeId === id
          ? html.replace('class="provider-card"', 'class="provider-card active"').replace(
              'data-result hidden',
              'data-result hidden'
            )
          : html;
      })
      .join("");

    // Mark the active card visually with a badge.
    if (activeId) {
      const card = els.grid.querySelector('.provider-card[data-provider="' + activeId + '"]');
      if (card && !card.querySelector(".active-badge")) {
        const badge = document.createElement("span");
        badge.className = "active-badge";
        badge.textContent = "ACTIVE";
        card.querySelector(".provider-card-head").appendChild(badge);
      }
    }
  }

  function showResult(card, kind, html) {
    const box = card.querySelector("[data-result]");
    box.hidden = false;
    box.className = "provider-result " + kind;
    box.innerHTML = html;
  }

  /* ------------------------------ actions ------------------------------ */

  function fillModelList(id, models) {
    const dl = document.getElementById("pfl-" + id);
    if (!dl) return;
    dl.innerHTML = models.map((m) => '<option value="' + esc(m) + '"></option>').join("");
  }

  function collectFields(id, card) {
    const out = {};
    const key = card.querySelector("#pf-" + id + "-key");
    const base = card.querySelector("#pf-" + id + "-base");
    const model = card.querySelector("#pf-" + id + "-model");
    if (key && key.value.trim()) out.apiKey = key.value.trim();
    if (base) out.baseUrl = base.value.trim();
    if (model) out.model = model.value.trim();
    return out;
  }

  async function save(id, card) {
    const payload = Object.assign({ provider: id, activate: true }, collectFields(id, card));
    showResult(card, "pending", "Saving…");
    try {
      const data = await api("/api/providers", payload);
      showResult(card, "ok", "✓ Saved and activated. " + esc(data.key || ""));
      if (data.view) render(data.view);
      global.NexoraApp.refreshModelsView && global.NexoraApp.refreshModelsView();
      global.NexoraApp.showToast("Provider saved — key stored on the server only.");
      // Clear the key field so the secret does not linger in the DOM.
      const key = card.querySelector("#pf-" + id + "-key");
      if (key) key.value = "";
    } catch (err) {
      const e = err && err.error ? err.error : {};
      showResult(card, "err", "✕ " + esc(e.message || err.message || "Save failed") + (e.hint ? '<br/><span class="hint">' + esc(e.hint) + "</span>" : ""));
    }
  }

  async function clearKey(id, card) {
    try {
      const data = await api("/api/providers", { provider: id, apiKey: "CLEAR" });
      showResult(card, "ok", "✓ Stored key removed.");
      if (data.view) render(data.view);
    } catch (err) {
      showResult(card, "err", "✕ " + esc(err.message || "Could not remove key"));
    }
  }

  async function testOrLoad(id, card) {
    const isLoad = true;
    showResult(card, "pending", "Contacting " + id + "…");
    try {
      // Save current field values first (without activating) so the test uses them.
      await api("/api/providers", Object.assign({ provider: id, activate: false }, collectFields(id, card)));
      const data = await api("/api/providers/test", { provider: id });
      fillModelList(id, data.models || []);
      showResult(
        card,
        "ok",
        "✓ Connected — " + data.modelCount + " model" + (data.modelCount === 1 ? "" : "s") + " available" +
          (data.note ? " (" + esc(data.note) + ")" : "") + ". Pick one from the Model field."
      );
      if (data.view) render(data.view);
    } catch (err) {
      const e = err && err.error ? err.error : {};
      showResult(card, "err", "✕ " + esc(e.message || err.message || "Connection test failed") +
        (e.hint ? '<br/><span class="hint">' + esc(e.hint) + "</span>" : ""));
    }
  }

  /* -------------------------------- init ------------------------------- */

  function init() {
    cacheEls();
    if (!els.grid) return;
    els.grid.addEventListener("click", function (event) {
      const btn = event.target.closest("button[data-act]");
      if (!btn) return;
      const card = btn.closest(".provider-card");
      if (!card) return;
      const id = card.getAttribute("data-provider");
      const act = btn.getAttribute("data-act");
      if (act === "save") save(id, card);
      else if (act === "test" || act === "load-models") testOrLoad(id, card);
      else if (act === "clear-key") clearKey(id, card);
    });
  }

  global.NexoraProviders = { init: init, render: render };
})(window);
