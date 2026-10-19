/**
 * Nexora AI — lightweight syntax highlighter for code blocks.
 * Languages: luau (default), lua, js / javascript / ts, json, and anything
 * else falls back to plain text. No dependencies; runs in browser and Node.
 */
(function (global) {
  "use strict";

  const LUAU_KW = new Set([
    "local", "function", "end", "if", "then", "else", "elseif", "for", "while", "do",
    "return", "break", "repeat", "until", "nil", "true", "false", "and", "or", "not",
    "in", "continue", "type", "export", "typeof"
  ]);
  const LUAU_BUILTIN = new Set([
    "game", "workspace", "script", "task", "math", "string", "table", "pairs", "ipairs",
    "print", "warn", "error", "require", "os", "tick", "time", "self", "spawn", "wait",
    "Wait", "tonumber", "tostring", "pcall", "xpcall", "setmetatable", "getmetatable",
    "select", "next", "rawget", "rawset", "coroutine", "bit32", "utf8", "debug",
    "shared", "_G", "plugin", "newproxy"
  ]);

  // Roblox value/type constructors — rendered as class names (teal).
  const LUAU_CLASSES = new Set([
    "Instance", "Vector3", "Vector2", "CFrame", "Color3", "UDim2", "UDim", "Enum",
    "TweenInfo", "Ray", "Region3", "BrickColor", "NumberRange", "NumberSequence",
    "ColorSequence", "Faces", "Axes", "Random", "DateTime", "PhysicalProperties",
    "Rect", "OverlapParams", "RaycastParams", "Font", "BasePart"
  ]);

  const JS_KW = new Set([
    "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
    "class", "new", "async", "await", "import", "export", "from", "try", "catch",
    "finally", "throw", "switch", "case", "break", "continue", "typeof", "delete",
    "in", "of", "this", "null", "undefined", "true", "false", "yield", "static",
    "extends", "super", "get", "set", "with", "debugger", "void", "instanceof"
  ]);
  const JS_BUILTIN = new Set([
    "console", "window", "document", "JSON", "Math", "Object", "Array", "String",
    "Number", "Boolean", "Promise", "Map", "Set", "Error", "RegExp", "Date",
    "fetch", "process", "require", "module", "exports", "globalThis", "NaN", "Infinity"
  ]);

  const JSON_KW = new Set(["true", "false", "null"]);

  const LANGS = {
    luau: { kw: LUAU_KW, builtin: LUAU_BUILTIN, cls: LUAU_CLASSES, hashComments: false },
    lua: { kw: LUAU_KW, builtin: LUAU_BUILTIN, cls: LUAU_CLASSES, hashComments: false },
    js: { kw: JS_KW, builtin: JS_BUILTIN, cls: null, hashComments: false },
    javascript: { kw: JS_KW, builtin: JS_BUILTIN, cls: null, hashComments: false },
    ts: { kw: JS_KW, builtin: JS_BUILTIN, cls: null, hashComments: false },
    typescript: { kw: JS_KW, builtin: JS_BUILTIN, cls: null, hashComments: false },
    jsx: { kw: JS_KW, builtin: JS_BUILTIN, cls: null, hashComments: false },
    json: { kw: JSON_KW, builtin: null, cls: null, hashComments: false },
    sh: { kw: new Set(["if", "then", "fi", "for", "do", "done", "while", "case", "esac", "function", "return", "local"]), builtin: null, cls: null, hashComments: true },
    bash: { kw: new Set(["if", "then", "fi", "for", "do", "done", "while", "case", "esac", "function", "return", "local"]), builtin: null, cls: null, hashComments: true }
  };

  const CLASS_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
  const NUM_RE = /^(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?)/;

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function tokenPatterns(lang, cfg) {
    const list = [];
    // Comments must be tried before strings that might contain "--" etc.
    if (cfg.hashComments) list.push({ cls: "tok-com", re: /^#[^\n]*/ });
    list.push({ cls: "tok-com", re: /^--\[\[[\s\S]*?\]\]/ });
    list.push({ cls: "tok-com", re: /^--[^\n]*/ });
    list.push({ cls: "tok-com", re: /^\/\/[^\n]*/ });
    list.push({ cls: "tok-com", re: /^\/\*[\s\S]*?\*\// });
    list.push({ cls: "tok-str", re: /^(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)/ });
    list.push({ cls: "tok-num", re: NUM_RE });
    return list;
  }

  function highlight(code, lang) {
    const key = String(lang || "luau").toLowerCase();
    const cfg = LANGS[key] || LANGS.luau;
    const patterns = tokenPatterns(key, cfg);
    let out = "";
    let i = 0;
    const n = code.length;

    while (i < n) {
      let matched = false;

      // Try structured tokens first.
      for (const p of patterns) {
        const m = p.re.exec(code.slice(i));
        if (m && m[0].length > 0) {
          out += '<span class="' + p.cls + '">' + escapeHtml(m[0]) + "</span>";
          i += m[0].length;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // Words: keywords, builtins, function calls, class names.
      const word = CLASS_RE.exec(code.slice(i));
      if (word) {
        const w = word[0];
        const after = code.slice(i + w.length);
        let cls = null;
        if (cfg.kw && cfg.kw.has(w)) cls = "tok-kw";
        else if (cfg.builtin && cfg.builtin.has(w)) cls = "tok-builtin";
        else if (cfg.cls && cfg.cls.has(w)) cls = "tok-cls";
        else if (/^\s*\(/.test(after)) cls = "tok-fn";
        else if (/^[A-Z]/.test(w)) cls = "tok-cls";

        if (cls) out += '<span class="' + cls + '">' + escapeHtml(w) + "</span>";
        else out += escapeHtml(w);
        i += w.length;
        continue;
      }

      out += escapeHtml(code[i]);
      i += 1;
    }
    return out;
  }

  const NexoraHighlight = { highlight: highlight, escapeHtml: escapeHtml };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = NexoraHighlight;
  } else {
    global.NexoraHighlight = NexoraHighlight;
  }
})(typeof window !== "undefined" ? window : this);
