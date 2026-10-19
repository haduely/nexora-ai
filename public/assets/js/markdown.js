/**
 * Nexora AI — Markdown renderer for assistant messages.
 * Supports: fenced code blocks (with syntax highlighting + copy button),
 * headings, bold/italic, inline code, lists, blockquotes, links, hr.
 * All input is treated as untrusted text: raw HTML is always escaped.
 * Runs in browser and Node (used by tests).
 */
(function (global) {
  "use strict";

  const Highlight =
    typeof module !== "undefined" && typeof module.require === "function" && typeof require === "function" && typeof window === "undefined"
      ? require("./highlight.js")
      : (global.NexoraHighlight || (typeof window !== "undefined" ? window.NexoraHighlight : null));

  if (!Highlight) {
    throw new Error("NexoraHighlight must be loaded before Markdown.");
  }

  const esc = Highlight.escapeHtml;

  let blockCounter = 0;

  /* ------------------------------ code blocks ------------------------- */

  function renderCodeBlock(lang, code) {
    const language = String(lang || "text").trim().toLowerCase() || "text";
    const body = Highlight.highlight(code, language);
    const id = "nx-cb-" + blockCounter++;
    return (
      '<div class="codeblock">' +
      '<div class="codeblock-head">' +
      '<span class="codeblock-lang">' + esc(language) + "</span>" +
      '<button class="copy-btn" type="button" data-copy-for="' + id + '" aria-label="Copy code">' +
      '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>' +
      "<span>Copy</span>" +
      "</button>" +
      "</div>" +
      '<pre><code id="' + id + '">' + body + "</code></pre>" +
      "</div>"
    );
  }

  /* ------------------------------- inline ----------------------------- */

  function safeUrl(url) {
    const u = String(url).trim();
    if (/^(https?:|mailto:)/i.test(u)) return u;
    if (/^[/#]/.test(u)) return u;
    return null;
  }

  function renderInline(text) {
    // Escape first — no raw HTML ever survives.
    let s = esc(text);

    // Protect `code` spans from further formatting.
    const codeSpans = [];
    s = s.replace(/`([^`\n]+)`/g, function (_m, code) {
      codeSpans.push(code);
      return "\u0000CS" + (codeSpans.length - 1) + "\u0000";
    });

    // Links [text](url)
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (_m, label, url) {
      const safe = safeUrl(url.replace(/&amp;/g, "&"));
      if (!safe) return label;
      return '<a href="' + esc(safe) + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
    });

    // Bold then italic.
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, "$1<em>$2</em>");

    // Restore code spans.
    s = s.replace(/\u0000CS(\d+)\u0000/g, function (_m, idx) {
      return '<code class="inline">' + codeSpans[Number(idx)] + "</code>";
    });

    return s;
  }

  /* -------------------------------- blocks ---------------------------- */

  function renderProse(segment) {
    const lines = segment.replace(/\r\n/g, "\n").split("\n");
    let html = "";
    let para = [];
    let listType = null; // "ul" | "ol" | null
    let quote = [];

    function flushPara() {
      if (para.length) {
        html += "<p>" + renderInline(para.join(" ")) + "</p>";
        para = [];
      }
    }
    function closeList() {
      if (listType) {
        html += "</" + listType + ">";
        listType = null;
      }
    }
    function flushQuote() {
      if (quote.length) {
        html += "<blockquote>" + renderInline(quote.join(" ")) + "</blockquote>";
        quote = [];
      }
    }
    function flushAll() {
      flushPara();
      closeList();
      flushQuote();
    }

    for (const rawLine of lines) {
      const line = rawLine;

      if (!line.trim()) {
        flushAll();
        continue;
      }

      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        flushAll();
        const level = heading[1].length;
        html += "<h" + level + ">" + renderInline(heading[2]) + "</h" + level + ">";
        continue;
      }

      if (/^(-{3,}|\*{3,})\s*$/.test(line.trim())) {
        flushAll();
        html += "<hr/>";
        continue;
      }

      const bq = /^>\s?(.*)$/.exec(line);
      if (bq) {
        flushPara();
        closeList();
        quote.push(bq[1]);
        continue;
      }

      const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (ul) {
        flushPara();
        flushQuote();
        if (listType !== "ul") {
          closeList();
          html += "<ul>";
          listType = "ul";
        }
        html += "<li>" + renderInline(ul[1]) + "</li>";
        continue;
      }

      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ol) {
        flushPara();
        flushQuote();
        if (listType !== "ol") {
          closeList();
          html += "<ol>";
          listType = "ol";
        }
        html += "<li>" + renderInline(ol[1]) + "</li>";
        continue;
      }

      // Indented continuation of a list item.
      if (listType && /^\s{2,}\S/.test(line)) {
        html += " " + renderInline(line.trim());
        continue;
      }

      closeList();
      flushQuote();
      para.push(line.trim());
    }
    flushAll();
    return html;
  }

  /* -------------------------------- render ---------------------------- */

  function render(text) {
    if (text == null) return "";
    const source = String(text);
    const parts = [];
    // Split on fenced code blocks: ```lang\ncode```
    const fenceRe = /```([\w+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let m;
    while ((m = fenceRe.exec(source)) !== null) {
      parts.push({ type: "prose", text: source.slice(lastIndex, m.index) });
      parts.push({ type: "code", lang: m[1] || "text", code: m[2] });
      lastIndex = fenceRe.lastIndex;
    }
    parts.push({ type: "prose", text: source.slice(lastIndex) });

    let out = "";
    for (const part of parts) {
      if (part.type === "code") out += renderCodeBlock(part.lang, part.code);
      else {
        const prose = renderProse(part.text);
        if (prose) out += prose;
      }
    }
    return out;
  }

  const Markdown = { render: render, renderInline: renderInline, renderCodeBlock: renderCodeBlock };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Markdown;
  } else {
    global.Markdown = Markdown;
  }
})(typeof window !== "undefined" ? window : this);
