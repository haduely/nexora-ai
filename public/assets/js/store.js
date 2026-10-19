/**
 * Nexora AI — client-side state store.
 *
 * Conversations are IN-MEMORY only at Stage 1: refreshing the page clears
 * them. Durable chat history and projects arrive in Stage 3. Only tiny UI
 * preferences (last view, sidebar state) are written to localStorage, and
 * Settings exposes a control to clear them.
 */
(function (global) {
  "use strict";

  const PREFS_KEY = "nexora.prefs.v1";

  const state = {
    conversations: [],
    activeId: null,
    boot: {
      health: null, // last /api/health response or { error }
      models: null // last /api/models response or { error }
    },
    prefs: loadPrefs()
  };

  function loadPrefs() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed;
      }
    } catch (_e) { /* corrupted prefs are simply ignored */ }
    return { lastView: "chat", sidebarOpen: false };
  }

  function savePrefs() {
    try {
      global.localStorage && global.localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
    } catch (_e) { /* storage may be unavailable; UI still works */ }
  }

  function clearPrefs() {
    try {
      global.localStorage && global.localStorage.removeItem(PREFS_KEY);
    } catch (_e) { /* ignore */ }
    state.prefs = { lastView: "chat", sidebarOpen: false };
  }

  function uid() {
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function createConversation() {
    const conv = {
      id: uid(),
      title: "New Chat",
      createdAt: Date.now(),
      messages: []
    };
    state.conversations.push(conv);
    state.activeId = conv.id;
    return conv;
  }

  function activeConversation() {
    return state.conversations.find((c) => c.id === state.activeId) || null;
  }

  function ensureConversation() {
    return activeConversation() || createConversation();
  }

  function pushMessage(message) {
    const conv = ensureConversation();
    const entry = Object.assign({ id: uid(), ts: Date.now() }, message);
    conv.messages.push(entry);
    if (conv.title === "New Chat" && entry.role === "user") {
      const text = String(entry.content || "").replace(/\s+/g, " ").trim();
      conv.title = text.length > 44 ? text.slice(0, 44).trimEnd() + "…" : text || "New Chat";
    }
    return entry;
  }

  const NexoraStore = {
    state: state,
    loadPrefs: loadPrefs,
    savePrefs: savePrefs,
    clearPrefs: clearPrefs,
    createConversation: createConversation,
    activeConversation: activeConversation,
    ensureConversation: ensureConversation,
    pushMessage: pushMessage
  };

  global.NexoraStore = NexoraStore;
})(window);
