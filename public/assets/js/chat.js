/**
 * Nexora AI — chat view.
 *
 * Stage 2: sends your message to the local server (/api/chat), which calls
 * the active AI provider (Gemini / Ollama / OpenAI-compatible / Pollinations)
 * with the conversation history, and renders the model's real reply.
 *
 * Nothing here fabricates responses. If no provider is active, or a request
 * fails, the UI says exactly that and offers a real retry.
 */
(function (global) {
  "use strict";

  const store = global.NexoraStore;
  const Markdown = global.Markdown;

  const MAX_HISTORY_SENT = 40;
  const els = {};
  let pending = false;

  function cacheEls() {
    els.scroll = document.getElementById("chatScroll");
    els.empty = document.getElementById("chatEmpty");
    els.messages = document.getElementById("messages");
    els.input = document.getElementById("composerInput");
    els.send = document.getElementById("btnSend");
  }

  /* ------------------------------ rendering --------------------------- */

  function avatarSvg(role) {
    if (role === "user") {
      return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="8.5" r="3.7" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 1.5l2.7 7.1 7.3 2.7-7.3 2.7L12 22.5l-2.7-7.8L2 12l7.3-2.7z"/></svg>';
  }

  function noticeIcon() {
    return '<span class="notice-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 7.5v5.5M12 16.3v.2"/></svg></span>';
  }

  function nameFor(role) {
    if (role === "user") return "You";
    if (role === "assistant") return "Nexora";
    return "Status";
  }

  function buildMessageEl(msg) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + msg.role;

    if (msg.role === "notice") {
      wrap.innerHTML = '<div class="msg-content">' + noticeIcon() + "<div>" + Markdown.render(msg.content) + "</div></div>";
      return wrap;
    }

    if (msg.role === "error") {
      wrap.classList.add("notice");
      wrap.innerHTML =
        '<div class="msg-content">' + noticeIcon() +
        "<div><b>" + esc(msg.content) + "</b>" +
        (msg.hint ? '<br/><span class="err-hint">' + Markdown.renderInline(msg.hint) + "</span>" : "") +
        '<br/><button class="btn btn-ghost btn-sm retry-btn" type="button" data-error-id="' + esc(msg.errorId) + '">Retry</button>' +
        "</div></div>";
      return wrap;
    }

    const avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    avatar.innerHTML = avatarSvg(msg.role);

    const body = document.createElement("div");
    body.className = "msg-body";

    const name = document.createElement("div");
    name.className = "msg-name";
    name.textContent = nameFor(msg.role);

    const content = document.createElement("div");
    content.className = "msg-content";
    if (msg.role === "assistant") content.innerHTML = Markdown.render(msg.content);
    else content.textContent = msg.content;

    body.appendChild(name);
    body.appendChild(content);
    wrap.appendChild(avatar);
    wrap.appendChild(body);
    return wrap;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderAll() {
    const conv = store.activeConversation();
    els.messages.innerHTML = "";
    if (!conv || conv.messages.length === 0) {
      els.empty.classList.remove("hidden");
      return;
    }
    els.empty.classList.add("hidden");
    for (const msg of conv.messages) els.messages.appendChild(buildMessageEl(msg));
    scrollToBottom(true);
  }

  function appendMessage(msg) {
    const conv = store.activeConversation();
    if (conv && conv.messages.length === 1) els.empty.classList.add("hidden");
    const wrap = buildMessageEl(msg);
    els.messages.appendChild(wrap);
    scrollToBottom(false);
    return wrap;
  }

  // Static Roblox verification findings that survived the automatic correction
  // round. Shown honestly under the reply — never presented as a runtime test.
  function renderVerification(wrap, verification) {
    if (!wrap || !verification || !Array.isArray(verification.findings) || verification.findings.length === 0) return;
    const body = wrap.querySelector(".msg-body");
    if (!body) return;
    const box = document.createElement("div");
    box.className = "verify-note";
    const shown = verification.findings.slice(0, 4);
    box.innerHTML =
      "<b>Static Roblox checks flagged " + verification.findings.length + " issue(s):</b>" +
      "<ul>" + shown.map(function (f) { return "<li>" + esc(f.message) + "</li>"; }).join("") + "</ul>" +
      (verification.findings.length > shown.length
        ? '<p class="muted">…and ' + (verification.findings.length - shown.length) + " more.</p>"
        : "") +
      '<p class="muted">Static review only — nothing was executed in Studio. Say “fix the flagged issues” to have Nexora correct them.</p>';
    body.appendChild(box);
  }

  function scrollToBottom(instant) {
    requestAnimationFrame(function () {
      if (instant) els.scroll.style.scrollBehavior = "auto";
      els.scroll.scrollTop = els.scroll.scrollHeight;
      if (instant) els.scroll.style.scrollBehavior = "";
    });
  }

  /* --------------------------- typing indicator ------------------------ */

  function showTyping() {
    hideTyping();
    const el = document.createElement("div");
    el.className = "msg assistant typing";
    el.id = "nxTyping";
    el.innerHTML =
      '<div class="msg-avatar">' + avatarSvg("assistant") + "</div>" +
      '<div class="msg-body"><div class="msg-name">Nexora</div>' +
      '<div class="msg-content"><span class="typing-dots"><i></i><i></i><i></i></span></div></div>';
    els.messages.appendChild(el);
    scrollToBottom(false);
  }

  function hideTyping() {
    const el = document.getElementById("nxTyping");
    if (el) el.remove();
  }

  /* ---------------------------- provider state ------------------------- */

  function activeProvider() {
    const models = store.state.boot.models;
    if (!models || models.error) return null;
    return models.active || null;
  }

  /* ------------------------------ sending ------------------------------ */

  function historyFor(conv, excludeId) {
    return conv.messages
      .filter(function (m) {
        return (m.role === "user" || m.role === "assistant") && m.id !== excludeId && typeof m.content === "string";
      })
      .slice(-MAX_HISTORY_SENT)
      .map(function (m) {
        return { role: m.role, content: m.content };
      });
  }

  async function requestReply(conv, userMsg) {
    pending = true;
    updateSendState();
    showTyping();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMsg.content,
          history: historyFor(conv, userMsg.id)
        })
      });
      let data = null;
      try { data = JSON.parse(await res.text()); } catch (_e) { data = null; }

      hideTyping();

      if (!res.ok || !data || typeof data.text !== "string") {
        const err = (data && data.error) || {};
        const failed = store.pushMessage({
          role: "error",
          content: err.message || "Request failed (HTTP " + res.status + ").",
          hint: err.hint || null,
          errorId: userMsg.id
        });
        appendMessage(failed);
        return;
      }

      const reply = store.pushMessage({ role: "assistant", content: data.text });
      const el = appendMessage(reply);
      if (data.truncated) {
        const body = el && el.querySelector(".msg-body");
        if (body) {
          const note = document.createElement("div");
          note.className = "trunc-note";
          note.textContent = "The provider stopped this reply at its length limit, so the end may be missing. Ask \u201ccontinue\u201d for the rest.";
          body.appendChild(note);
        }
      }
      renderVerification(el, data.verification);
    } catch (err) {
      hideTyping();
      const failed = store.pushMessage({
        role: "error",
        content: "Could not reach the Nexora server: " + (err.message || err),
        hint: "Make sure the Nexora server window is still running, then press Retry.",
        errorId: userMsg.id
      });
      appendMessage(failed);
    } finally {
      pending = false;
      updateSendState();
      els.input.focus();
    }
  }

  function sendMessage() {
    if (pending) return;
    const text = els.input.value.replace(/\n+$/, "");
    if (!text.trim()) return;

    const conv = store.ensureConversation();
    els.input.value = "";
    autoResize();

    const active = activeProvider();
    if (!active) {
      // Honest empty-provider path — no fabrication.
      const userMsg = store.pushMessage({ role: "user", content: text });
      if (conv.messages.length === 1) renderAll();
      else appendMessage(userMsg);
      const notice = store.pushMessage({
        role: "notice",
        content:
          "**No AI provider is active, so no model was called.**\n\n" +
          "Open **Models** and press *Save & Activate* on a provider — " +
          "**Pollinations** works immediately with no key, or connect **Gemini** with a free key from " +
          "[aistudio.google.com/apikey](https://aistudio.google.com/apikey). Your message stays in this conversation."
      });
      appendMessage(notice);
      return;
    }

    const userMsg = store.pushMessage({ role: "user", content: text });
    if (conv.messages.length === 1) renderAll();
    else appendMessage(userMsg);

    requestReply(conv, userMsg);
  }

  function retry(errorId) {
    if (pending) return;
    const conv = store.activeConversation();
    if (!conv) return;
    const userMsg = conv.messages.find(function (m) { return m.id === errorId && m.role === "user"; });
    if (!userMsg) return;

    // Remove the error bubble, then re-send the original message for real.
    const idx = conv.messages.findIndex(function (m) { return m.role === "error" && m.errorId === errorId; });
    if (idx >= 0) conv.messages.splice(idx, 1);
    renderAll();
    requestReply(conv, userMsg);
  }

  /* ------------------------------ composer ----------------------------- */

  function updateSendState() {
    els.send.disabled = pending || !els.input.value.trim();
    els.send.textContent = pending ? "Sending…" : "Send";
  }

  function autoResize() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 190) + "px";
    updateSendState();
  }

  /* --------------------------- copy code blocks ------------------------ */

  async function copyText(text) {
    if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch (_e) { /* fall through */ }
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_e) { ok = false; }
    ta.remove();
    return ok;
  }

  function wireDelegates() {
    els.messages.addEventListener("click", async function (event) {
      const copyBtn = event.target.closest(".copy-btn");
      if (copyBtn) {
        const codeEl = document.getElementById(copyBtn.getAttribute("data-copy-for"));
        if (!codeEl) return;
        const ok = await copyText(codeEl.textContent);
        const label = copyBtn.querySelector("span");
        if (ok) {
          copyBtn.classList.add("copied");
          if (label) label.textContent = "Copied";
          setTimeout(function () {
            copyBtn.classList.remove("copied");
            if (label) label.textContent = "Copy";
          }, 1600);
        } else {
          global.NexoraApp && global.NexoraApp.showToast("Copy failed — select the code and copy manually.");
        }
        return;
      }
      const retryBtn = event.target.closest(".retry-btn");
      if (retryBtn) retry(retryBtn.getAttribute("data-error-id"));
    });
  }

  /* -------------------------------- init ------------------------------ */

  function init() {
    cacheEls();

    els.input.addEventListener("input", autoResize);
    els.input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendMessage();
      }
    });
    els.send.addEventListener("click", sendMessage);

    document.getElementById("suggestions").addEventListener("click", function (event) {
      const chip = event.target.closest(".suggestion");
      if (!chip) return;
      els.input.value = chip.textContent.trim();
      autoResize();
      els.input.focus();
    });

    wireDelegates();
    autoResize();
    renderAll();
  }

  global.NexoraChat = { init: init, renderAll: renderAll, sendMessage: sendMessage };
})(window);
