/**
 * Nexora AI — Projects view (Stage 3).
 *
 * Lists saved projects and their conversations, backed by the Nexora server
 * (/api/workspace, /api/projects, /api/conversations). Every action is a real
 * request; failures are shown, never silently swallowed.
 */
(function (global) {
  "use strict";

  const store = global.NexoraStore;
  let busy = false;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function when(ts) {
    if (!ts) return "";
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return Math.round(diff / 60_000) + "m ago";
    if (diff < 86_400_000) return Math.round(diff / 3_600_000) + "h ago";
    return new Date(ts).toLocaleDateString();
  }

  function convRow(conv) {
    return (
      '<div class="conv-row" data-conv="' + esc(conv.persistedId || conv.id) + '">' +
        '<button class="conv-open" type="button" data-action="open-conv" title="Open this conversation">' +
          '<span class="conv-title">' + esc(conv.title || "New Chat") + "</span>" +
          '<span class="conv-meta">' + (conv.messageCount || conv.messages.length || 0) + " msgs · " + when(conv.updatedAt) + "</span>" +
        "</button>" +
        '<button class="icon-btn conv-del" type="button" data-action="delete-conv" title="Delete conversation" aria-label="Delete conversation">×</button>' +
      "</div>"
    );
  }

  function projectCard(project, conversations) {
    const rows = conversations.length
      ? conversations.map(convRow).join("")
      : '<p class="muted conv-empty">No conversations in this project yet.</p>';
    return (
      '<article class="project-card" data-project="' + esc(project.id) + '">' +
        '<header class="project-head">' +
          '<div class="project-title-wrap">' +
            "<h3>" + esc(project.name) + "</h3>" +
            '<p class="muted">' + (project.description ? esc(project.description) : "No description") +
              " · " + conversations.length + " chat" + (conversations.length === 1 ? "" : "s") + "</p>" +
          "</div>" +
          '<div class="project-actions">' +
            '<button class="btn btn-ghost btn-sm" type="button" data-action="new-chat">New chat</button>' +
            '<button class="btn btn-ghost btn-sm" type="button" data-action="rename">Rename</button>' +
            '<button class="btn btn-ghost btn-sm btn-danger" type="button" data-action="delete">Delete</button>' +
          "</div>" +
        "</header>" +
        '<div class="conv-list">' + rows + "</div>" +
      "</article>"
    );
  }

  function render() {
    const host = document.getElementById("projectsList");
    const note = document.getElementById("projectsStorageNote");
    if (!host) return;

    const workspace = store.state.boot.workspace;
    const projects = store.state.projects || [];
    const ungrouped = store.conversationsFor(null);

    if (note) {
      if (workspace && workspace.error) {
        note.textContent = "Could not read saved data: " + workspace.error + ". New chats still work but will not be saved.";
        note.className = "note err";
      } else if (workspace && workspace.durable === false) {
        note.textContent = "Saved on this server's temporary disk — it survives reloads but resets when the service redeploys.";
        note.className = "note";
      } else {
        note.textContent = "Saved on the Nexora server and scoped to this browser. Nothing is shared with other visitors.";
        note.className = "note";
      }
    }

    if (!workspace) {
      host.innerHTML = '<p class="muted">Loading saved projects…</p>';
      return;
    }

    const blocks = projects.map(function (project) {
      return projectCard(project, store.conversationsFor(project.id));
    });

    if (ungrouped.length) {
      blocks.push(
        '<article class="project-card project-loose">' +
          '<header class="project-head"><div class="project-title-wrap">' +
            "<h3>Ungrouped chats</h3>" +
            '<p class="muted">Not assigned to a project yet · ' + ungrouped.length + "</p>" +
          "</div></header>" +
          '<div class="conv-list">' + ungrouped.map(convRow).join("") + "</div>" +
        "</article>"
      );
    }

    if (!blocks.length) {
      host.innerHTML =
        '<div class="empty-card">' +
          '<div class="empty-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>' +
          "<h3>No saved work yet</h3>" +
          '<p class="muted">Create a project, or just send a chat message — conversations are saved automatically and appear here.</p>' +
        "</div>";
      return;
    }
    host.innerHTML = blocks.join("");
  }

  async function refresh() {
    try {
      await store.loadWorkspace();
    } catch (_e) { /* render() shows the error */ }
    render();
  }

  function newChatIn(projectId) {
    const conv = store.createConversation(projectId || null);
    if (global.NexoraApp) global.NexoraApp.setView("chat");
    if (global.NexoraChat) global.NexoraChat.renderAll();
    if (global.NexoraApp) global.NexoraApp.showToast(projectId ? "New chat in this project." : "New chat started.");
    return conv;
  }

  async function openConv(id) {
    try {
      await store.openConversation(id);
      if (global.NexoraApp) global.NexoraApp.setView("chat");
      if (global.NexoraChat) global.NexoraChat.renderAll();
    } catch (err) {
      if (global.NexoraApp) global.NexoraApp.showToast("Could not open conversation: " + err.message);
    }
  }

  async function onClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.getAttribute("data-action");
    const card = button.closest("[data-project]");
    const projectId = card ? card.getAttribute("data-project") : null;
    const convRowEl = button.closest("[data-conv]");
    const convId = convRowEl ? convRowEl.getAttribute("data-conv") : null;

    if (action === "new-chat") return newChatIn(projectId);

    if (action === "open-conv" && convId) return openConv(convId);

    if (action === "delete-conv" && convId) {
      const conv = store.findConversation(convId);
      const label = conv ? conv.title : "this conversation";
      if (!global.confirm('Delete "' + label + '"? This removes it from the server.')) return;
      await store.deleteConversation(convId);
      if (global.NexoraChat) global.NexoraChat.renderAll();
      render();
      return;
    }

    if (!projectId) return;
    const project = store.state.projects.find(function (p) { return p.id === projectId; });
    if (!project) return;

    if (action === "rename") {
      const name = global.prompt("Project name", project.name);
      if (!name || !name.trim() || name.trim() === project.name) return;
      try {
        await store.renameProject(projectId, name.trim());
        render();
      } catch (err) {
        if (global.NexoraApp) global.NexoraApp.showToast("Rename failed: " + err.message);
      }
      return;
    }

    if (action === "delete") {
      if (!global.confirm('Delete project "' + project.name + '"? Its chats are kept under Ungrouped.')) return;
      try {
        await store.deleteProject(projectId);
        render();
      } catch (err) {
        if (global.NexoraApp) global.NexoraApp.showToast("Delete failed: " + err.message);
      }
    }
  }

  async function onCreate(event) {
    event.preventDefault();
    if (busy) return;
    const nameInput = document.getElementById("newProjectName");
    const descInput = document.getElementById("newProjectDescription");
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    busy = true;
    const submit = document.getElementById("btnCreateProject");
    if (submit) submit.disabled = true;
    try {
      await store.createProject(name, descInput ? descInput.value.trim() : "");
      nameInput.value = "";
      if (descInput) descInput.value = "";
      render();
      if (global.NexoraApp) global.NexoraApp.showToast('Project "' + name + '" created.');
    } catch (err) {
      if (global.NexoraApp) global.NexoraApp.showToast("Could not create project: " + err.message);
    } finally {
      busy = false;
      if (submit) submit.disabled = false;
    }
  }

  function init() {
    const host = document.getElementById("projectsList");
    if (host) host.addEventListener("click", function (e) { onClick(e); });
    const form = document.getElementById("newProjectForm");
    if (form) form.addEventListener("submit", onCreate);
    const toggle = document.getElementById("btnNewProject");
    if (toggle) {
      toggle.addEventListener("click", function () {
        const formEl = document.getElementById("newProjectForm");
        if (!formEl) return;
        formEl.classList.toggle("hidden");
        if (!formEl.classList.contains("hidden")) document.getElementById("newProjectName").focus();
      });
    }
    render();
  }

  global.NexoraProjects = { init: init, render: render, refresh: refresh };
})(window);
