/**
 * Nexora AI — client-side state store (Stage 3).
 *
 * Conversations live in memory for instant rendering and are mirrored to the
 * Nexora server so they survive a page reload. Each browser gets a random
 * device id; the server scopes saved projects/conversations to it, so on a
 * shared deployment nobody else can see your chats. This is not an account:
 * clearing site data starts a fresh, empty workspace.
 *
 * Only tiny UI preferences stay in localStorage.
 */
(function (global) {
  "use strict";

  const PREFS_KEY = "nexora.prefs.v1";
  const DEVICE_KEY = "nexora.device.v1";
  const SAVE_DEBOUNCE_MS = 700;

  const state = {
    conversations: [],
    projects: [],
    activeId: null,
    boot: {
      health: null,
      models: null,
      workspace: null
    },
    prefs: loadPrefs()
  };

  const saveTimers = new Map();
  const saving = new Set();

  /* ------------------------------ preferences ------------------------- */

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

  /* ------------------------------- device ----------------------------- */

  function randomId() {
    const bytes = new Uint8Array(12);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  function deviceId() {
    try {
      const existing = global.localStorage && global.localStorage.getItem(DEVICE_KEY);
      if (existing && /^[a-z0-9-]{8,64}$/i.test(existing)) return existing;
      const created = "dev-" + Date.now().toString(36) + "-" + randomId();
      global.localStorage && global.localStorage.setItem(DEVICE_KEY, created);
      return created;
    } catch (_e) {
      // No storage: the workspace stays in memory for this page only.
      if (!state.ephemeralDevice) state.ephemeralDevice = "dev-tmp-" + randomId();
      return state.ephemeralDevice;
    }
  }

  function api(method, path, body) {
    const options = {
      method: method,
      headers: { Accept: "application/json", "X-Nexora-Device": deviceId() }
    };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(path, options).then(function (res) {
      return res.text().then(function (text) {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = null; }
        if (!res.ok) {
          const err = new Error((parsed && parsed.error && (parsed.error.message || parsed.error)) || "HTTP " + res.status);
          err.status = res.status;
          throw err;
        }
        return parsed;
      });
    });
  }

  /* ---------------------------- conversations ------------------------- */

  function localId() {
    return "local-" + Date.now().toString(36) + "-" + randomId().slice(0, 6);
  }

  function createConversation(projectId) {
    const conv = {
      id: localId(),
      persistedId: null,
      title: "New Chat",
      projectId: projectId || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    state.conversations.push(conv);
    state.activeId = conv.id;
    rememberActive(conv.id);
    return conv;
  }

  function activeConversation() {
    return state.conversations.find(function (c) { return c.id === state.activeId; }) || null;
  }

  function ensureConversation() {
    return activeConversation() || createConversation();
  }

  function findConversation(id) {
    return state.conversations.find(function (c) { return c.id === id || c.persistedId === id; }) || null;
  }

  function rememberActive(id) {
    if (!id) return;
    state.prefs.lastConversationId = id;
    savePrefs();
  }

  function pushMessage(message) {
    const conv = ensureConversation();
    const entry = Object.assign({ id: localId(), ts: Date.now() }, message);
    conv.messages.push(entry);
    if (conv.title === "New Chat" && entry.role === "user") {
      const text = String(entry.content || "").replace(/\s+/g, " ").trim();
      conv.title = text.length > 44 ? text.slice(0, 44).trimEnd() + "…" : text || "New Chat";
    }
    conv.updatedAt = Date.now();
    scheduleSave(conv);
    return entry;
  }

  /* ------------------------------ persistence ------------------------- */

  function scheduleSave(conv) {
    if (!conv || state.offline) return;
    const key = conv.persistedId || conv.id;
    const existing = saveTimers.get(key);
    if (existing) clearTimeout(existing);
    saveTimers.set(key, setTimeout(function () {
      saveTimers.delete(key);
      persist(conv);
    }, SAVE_DEBOUNCE_MS));
  }

  function persist(conv) {
    if (!conv || saving.has(conv)) return Promise.resolve();
    saving.add(conv);
    const snapshot = conv.updatedAt || Date.now();
    const persistable = conv.messages.filter(function (m) {
      return (m.role === "user" || m.role === "assistant") && typeof m.content === "string";
    });
    const oldId = conv.id;
    const bootstrap = conv.persistedId
      ? Promise.resolve()
      : api("POST", "/api/conversations", { title: conv.title, projectId: conv.projectId || null })
          .then(function (res) {
            conv.persistedId = res.conversation.id;
            conv.id = res.conversation.id;
            if (state.activeId === oldId) state.activeId = conv.id;
            return res;
          });

    return bootstrap
      .then(function () {
        return api("PUT", "/api/conversations/" + encodeURIComponent(conv.persistedId), {
          title: conv.title,
          projectId: conv.projectId || null,
          messages: persistable
        });
      })
      .then(function () {
        state.offline = false;
        state.prefs.lastConversationId = conv.persistedId;
        savePrefs();
      })
      .catch(function (err) {
        // Keep working locally; the Projects view shows the real error state.
        if (err && err.status === 0) state.offline = true;
        if (global.console) console.warn("[nexora] could not save conversation:", err.message);
      })
      .then(function () { saving.delete(conv); })
      .then(function () {
        conv.savedAt = snapshot;
        // A message may have arrived while this write was in flight.
        if (conv.updatedAt > snapshot) scheduleSave(conv);
      });
  }

  /** Best-effort flush for pagehide: send anything still waiting on the timer. */
  function flushSaves() {
    saveTimers.forEach(function (timer) { clearTimeout(timer); });
    saveTimers.clear();
    state.conversations.forEach(function (conv) {
      if (conv.summaryOnly || !conv.messages.length) return;
      if ((conv.updatedAt || 0) <= (conv.savedAt || 0)) return;
      persist(conv);
    });
  }

  function loadWorkspace() {
    return api("GET", "/api/workspace").then(function (data) {
      state.boot.workspace = data;
      state.projects = data.projects || [];
      // Summaries only: never overwrite a conversation already loaded in memory.
      const known = new Set(state.conversations.map(function (c) { return c.persistedId || c.id; }));
      (data.conversations || []).forEach(function (summary) {
        if (known.has(summary.id)) {
          const conv = findConversation(summary.id);
          if (conv) {
            conv.title = summary.title;
            conv.projectId = summary.projectId;
          }
          return;
        }
        state.conversations.push({
          id: summary.id,
          persistedId: summary.id,
          title: summary.title,
          projectId: summary.projectId,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          messages: [],
          summaryOnly: true
        });
      });
      return data;
    }).catch(function (err) {
      state.boot.workspace = { error: err.message };
      throw err;
    });
  }

  function openConversation(id) {
    const conv = findConversation(id);
    if (conv && !conv.summaryOnly) {
      state.activeId = conv.id;
      rememberActive(conv.persistedId || conv.id);
      return Promise.resolve(conv);
    }
    return api("GET", "/api/conversations/" + encodeURIComponent(conv ? conv.persistedId : id)).then(function (res) {
      const full = res.conversation;
      const existing = findConversation(full.id);
      const merged = existing || { id: full.id, persistedId: full.id };
      merged.title = full.title;
      merged.projectId = full.projectId;
      merged.createdAt = full.createdAt;
      merged.updatedAt = full.updatedAt;
      merged.messages = (full.messages || []).map(function (m) { return Object.assign({}, m); });
      merged.summaryOnly = false;
      if (!existing) state.conversations.push(merged);
      state.activeId = merged.id;
      rememberActive(merged.id);
      return merged;
    });
  }

  function deleteConversation(id) {
    const conv = findConversation(id);
    if (!conv) return Promise.resolve();
    const done = conv.persistedId
      ? api("DELETE", "/api/conversations/" + encodeURIComponent(conv.persistedId)).catch(function () { return null; })
      : Promise.resolve();
    return done.then(function () {
      state.conversations = state.conversations.filter(function (c) { return c !== conv; });
      if (state.activeId === conv.id) {
        state.activeId = null;
        state.prefs.lastConversationId = null;
        savePrefs();
      }
    });
  }

  function setProject(conv, projectId) {
    if (!conv) return;
    conv.projectId = projectId || null;
    conv.updatedAt = Date.now();
    scheduleSave(conv);
  }

  /* -------------------------------- projects -------------------------- */

  function createProject(name, description) {
    return api("POST", "/api/projects", { name: name, description: description || "" }).then(function (res) {
      state.projects.unshift(res.project);
      return res.project;
    });
  }

  function renameProject(id, name) {
    return api("PATCH", "/api/projects/" + encodeURIComponent(id), { name: name }).then(function (res) {
      const project = state.projects.find(function (p) { return p.id === id; });
      if (project) project.name = res.project.name;
      return res.project;
    });
  }

  function deleteProject(id) {
    return api("DELETE", "/api/projects/" + encodeURIComponent(id)).then(function () {
      state.projects = state.projects.filter(function (p) { return p.id !== id; });
      state.conversations.forEach(function (c) {
        if (c.projectId === id) c.projectId = null;
      });
    });
  }

  function conversationsFor(projectId) {
    return state.conversations
      .filter(function (c) { return (c.projectId || null) === (projectId || null); })
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  }

  const NexoraStore = {
    state: state,
    loadPrefs: loadPrefs,
    savePrefs: savePrefs,
    clearPrefs: clearPrefs,
    deviceId: deviceId,
    api: api,
    createConversation: createConversation,
    activeConversation: activeConversation,
    ensureConversation: ensureConversation,
    findConversation: findConversation,
    pushMessage: pushMessage,
    scheduleSave: scheduleSave,
    flushSaves: flushSaves,
    loadWorkspace: loadWorkspace,
    openConversation: openConversation,
    deleteConversation: deleteConversation,
    setProject: setProject,
    createProject: createProject,
    renameProject: renameProject,
    deleteProject: deleteProject,
    conversationsFor: conversationsFor
  };

  global.NexoraStore = NexoraStore;
})(window);
