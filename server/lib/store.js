"use strict";
/**
 * Nexora AI - Stage 3 persistence (zero dependencies).
 *
 * Stores named projects and their conversations in one JSON file, scoped per
 * device. "Device" is a random id the browser keeps in localStorage and sends
 * as X-Nexora-Device; it is not an account, but it keeps one visitor's saved
 * chats invisible to every other visitor on a shared deployment.
 *
 * Writes are debounced and atomic (temp file + rename), so a crash mid-write
 * cannot leave a half-written store. Nothing here is served over HTTP.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LIMITS = {
  owners: 200,
  projectsPerOwner: 50,
  conversationsPerOwner: 120,
  messagesPerConversation: 120,
  messageChars: 8000,
  titleChars: 120,
  nameChars: 80,
  descriptionChars: 400
};

const VALID_ROLES = new Set(["user", "assistant"]);
const DEVICE_RE = /^[a-z0-9-]{8,64}$/i;

let writeTimer = null;
let pending = false;

class StoreError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "StoreError";
    this.status = status || 400;
    this.code = code || "STORE_ERROR";
    this.expose = true;
  }
}

function dataDir() {
  const dir = String(process.env.NEXORA_DATA_DIR || "").trim();
  return dir || path.join(__dirname, "..", "..", "data");
}

function storePath() {
  return path.join(dataDir(), "nexora-store.json");
}

const state = load();

function load() {
  const empty = { version: 1, savedAt: 0, owners: {} };
  try {
    const raw = fs.readFileSync(storePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.owners !== "object") return empty;
    return { version: 1, savedAt: Number(parsed.savedAt) || 0, owners: parsed.owners };
  } catch (_e) {
    return empty;
  }
}

function saveNow() {
  const file = storePath();
  const text = JSON.stringify(state);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    state.savedAt = Date.now();
    pending = false;
    return true;
  } catch (err) {
    console.error("[nexora] could not save workspace data:", err.message);
    return false;
  }
}

/**
 * Write-through persistence.
 *
 * An earlier version debounced writes by 250 ms. That lost data whenever the
 * process was stopped abruptly (on Windows SIGTERM terminates the process
 * without running JS handlers), so every mutation now writes synchronously.
 * The store is small (a few KB per chat), so this is cheap and predictable.
 */
function scheduleSave() {
  saveNow();
}

/** Flush on shutdown so a normal stop does not lose the last 250ms. */
function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (pending) saveNow();
}

function newId(prefix) {
  return prefix + "_" + crypto.randomBytes(8).toString("hex");
}

function cleanText(value, max, label) {
  if (typeof value !== "string") throw new StoreError(label + " must be text.", 400, "BAD_INPUT");
  const text = value.replace(/\u0000/g, "").trim();
  if (!text) throw new StoreError(label + " cannot be empty.", 400, "BAD_INPUT");
  if (text.length > max) throw new StoreError(label + " is too long (max " + max + " characters).", 400, "TOO_LONG");
  return text;
}

function deviceIdFrom(value) {
  const id = String(value || "").trim();
  if (!DEVICE_RE.test(id)) {
    throw new StoreError("Missing or invalid X-Nexora-Device header.", 400, "BAD_DEVICE");
  }
  return id.toLowerCase();
}

function ownerFor(deviceId, create) {
  const id = deviceIdFrom(deviceId);
  let owner = state.owners[id];
  if (!owner && create) {
    const ids = Object.keys(state.owners);
    if (ids.length >= LIMITS.owners) {
      // Evict the least recently used owner instead of growing without bound.
      let oldest = ids[0];
      for (const key of ids) {
        if ((state.owners[key].updatedAt || 0) < (state.owners[oldest].updatedAt || 0)) oldest = key;
      }
      delete state.owners[oldest];
    }
    owner = { id: id, createdAt: Date.now(), updatedAt: Date.now(), projects: [], conversations: [] };
    state.owners[id] = owner;
  }
  if (owner) owner.updatedAt = Date.now();
  return owner || null;
}

/* ------------------------------- projects ------------------------------ */

function listProjects(deviceId) {
  const owner = ownerFor(deviceId, false);
  if (!owner) return [];
  return owner.projects
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description || "",
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      conversationCount: owner.conversations.filter((c) => c.projectId === project.id).length
    }));
}

function createProject(deviceId, input) {
  const owner = ownerFor(deviceId, true);
  if (owner.projects.length >= LIMITS.projectsPerOwner) {
    throw new StoreError("Project limit reached (" + LIMITS.projectsPerOwner + "). Delete one first.", 409, "LIMIT");
  }
  const name = cleanText(input && input.name, LIMITS.nameChars, "Project name");
  const description = input && input.description !== undefined
    ? cleanText(String(input.description || "").trim() || "-", LIMITS.descriptionChars, "Description")
    : "";
  const project = {
    id: newId("p"),
    name: name,
    description: description === "-" ? "" : description,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  owner.projects.push(project);
  scheduleSave();
  return project;
}

function updateProject(deviceId, id, input) {
  const owner = ownerFor(deviceId, false);
  const project = owner && owner.projects.find((p) => p.id === id);
  if (!project) throw new StoreError("Project not found.", 404, "NOT_FOUND");
  if (input && input.name !== undefined) project.name = cleanText(input.name, LIMITS.nameChars, "Project name");
  if (input && input.description !== undefined) {
    const raw = String(input.description || "").trim();
    project.description = raw ? cleanText(raw, LIMITS.descriptionChars, "Description") : "";
  }
  project.updatedAt = Date.now();
  scheduleSave();
  return project;
}

function deleteProject(deviceId, id) {
  const owner = ownerFor(deviceId, false);
  if (!owner) throw new StoreError("Project not found.", 404, "NOT_FOUND");
  const index = owner.projects.findIndex((p) => p.id === id);
  if (index < 0) throw new StoreError("Project not found.", 404, "NOT_FOUND");
  owner.projects.splice(index, 1);
  let detached = 0;
  for (const conv of owner.conversations) {
    if (conv.projectId === id) {
      conv.projectId = null;
      detached += 1;
    }
  }
  scheduleSave();
  return { deleted: true, detached: detached };
}

/* ---------------------------- conversations ---------------------------- */

function summary(conv) {
  return {
    id: conv.id,
    title: conv.title,
    projectId: conv.projectId || null,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length
  };
}

function listConversations(deviceId) {
  const owner = ownerFor(deviceId, false);
  if (!owner) return [];
  return owner.conversations
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(summary);
}

function createConversation(deviceId, input) {
  const owner = ownerFor(deviceId, true);
  if (owner.conversations.length >= LIMITS.conversationsPerOwner) {
    throw new StoreError("Conversation limit reached (" + LIMITS.conversationsPerOwner + "). Delete one first.", 409, "LIMIT");
  }
  const projectId = input && input.projectId ? String(input.projectId) : null;
  if (projectId && !owner.projects.some((p) => p.id === projectId)) {
    throw new StoreError("Unknown project.", 400, "BAD_PROJECT");
  }
  const now = Date.now();
  const conv = {
    id: newId("c"),
    title: input && input.title ? cleanText(input.title, LIMITS.titleChars, "Title") : "New Chat",
    projectId: projectId,
    createdAt: now,
    updatedAt: now,
    messages: []
  };
  owner.conversations.push(conv);
  scheduleSave();
  return conv;
}

function getConversation(deviceId, id) {
  const owner = ownerFor(deviceId, false);
  const conv = owner && owner.conversations.find((c) => c.id === id);
  if (!conv) throw new StoreError("Conversation not found.", 404, "NOT_FOUND");
  return conv;
}

function sanitizeMessages(list) {
  if (!Array.isArray(list)) throw new StoreError("Messages must be a list.", 400, "BAD_INPUT");
  const out = [];
  for (const raw of list.slice(-LIMITS.messagesPerConversation)) {
    if (!raw || typeof raw !== "object") continue;
    const role = String(raw.role || "");
    if (!VALID_ROLES.has(role)) continue;
    let content = typeof raw.content === "string" ? raw.content : "";
    if (!content.trim()) continue;
    if (content.length > LIMITS.messageChars) content = content.slice(0, LIMITS.messageChars);
    out.push({
      id: typeof raw.id === "string" && raw.id ? raw.id.slice(0, 40) : newId("m"),
      role: role,
      content: content,
      ts: Number(raw.ts) || Date.now()
    });
  }
  return out;
}

function saveConversation(deviceId, id, input) {
  const owner = ownerFor(deviceId, false);
  const conv = owner && owner.conversations.find((c) => c.id === id);
  if (!conv) throw new StoreError("Conversation not found.", 404, "NOT_FOUND");
  if (input && input.title !== undefined) conv.title = cleanText(input.title, LIMITS.titleChars, "Title");
  if (input && input.projectId !== undefined) {
    const projectId = input.projectId ? String(input.projectId) : null;
    if (projectId && !owner.projects.some((p) => p.id === projectId)) {
      throw new StoreError("Unknown project.", 400, "BAD_PROJECT");
    }
    conv.projectId = projectId;
  }
  if (input && input.messages !== undefined) conv.messages = sanitizeMessages(input.messages);
  conv.updatedAt = Date.now();
  scheduleSave();
  return { id: conv.id, title: conv.title, projectId: conv.projectId, updatedAt: conv.updatedAt, messageCount: conv.messages.length };
}

function deleteConversation(deviceId, id) {
  const owner = ownerFor(deviceId, false);
  if (!owner) throw new StoreError("Conversation not found.", 404, "NOT_FOUND");
  const index = owner.conversations.findIndex((c) => c.id === id);
  if (index < 0) throw new StoreError("Conversation not found.", 404, "NOT_FOUND");
  owner.conversations.splice(index, 1);
  scheduleSave();
  return { deleted: true };
}

function workspace(deviceId) {
  ownerFor(deviceId, false);
  return {
    projects: listProjects(deviceId),
    conversations: listConversations(deviceId),
    storage: "server-file",
    durable: !process.env.NEXORA_EPHEMERAL_DISK
  };
}

/** Test/reset helper - writes an empty store immediately. */
function reset() {
  state.owners = {};
  state.savedAt = Date.now();
  pending = true;
  saveNow();
}

module.exports = {
  LIMITS: LIMITS,
  StoreError: StoreError,
  dataDir: dataDir,
  storePath: storePath,
  deviceIdFrom: deviceIdFrom,
  listProjects: listProjects,
  createProject: createProject,
  updateProject: updateProject,
  deleteProject: deleteProject,
  listConversations: listConversations,
  createConversation: createConversation,
  getConversation: getConversation,
  saveConversation: saveConversation,
  deleteConversation: deleteConversation,
  workspace: workspace,
  flush: flush,
  reset: reset
};
