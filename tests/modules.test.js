"use strict";
/**
 * Nexora AI — module smoke tests for the Markdown + syntax highlighting
 * pipeline used by chat code blocks. Run with:
 *   node tests/modules.test.js
 */
const assert = require("assert");
const path = require("path");

const Highlight = require(path.join(__dirname, "..", "public", "assets", "js", "highlight.js"));
const Markdown = require(path.join(__dirname, "..", "public", "assets", "js", "markdown.js"));

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ok  " + label);
  } catch (err) {
    console.error("  FAIL " + label + " — " + err.message);
    process.exitCode = 1;
    throw err;
  }
}

console.log("Nexora AI — module tests");

check("bold and inline code render", () => {
  const html = Markdown.render("**bold** and `code`");
  assert.ok(html.includes("<strong>bold</strong>"), "missing <strong>: " + html);
  assert.ok(html.includes('<code class="inline">code</code>'), "missing inline code: " + html);
});

check("raw HTML in prose is escaped", () => {
  const html = Markdown.render("hello <script>alert(1)</script> world");
  assert.ok(!html.includes("<script>"), "script tag not escaped: " + html);
  assert.ok(html.includes("&lt;script&gt;"), "escaped form missing: " + html);
});

check("raw HTML inside code fences is escaped", () => {
  const html = Markdown.render("```html\n<b>hi</b>\n```");
  assert.ok(!html.includes("<b>hi</b>"), "code content not escaped: " + html);
  assert.ok(html.includes("&lt;b&gt;hi&lt;/b&gt;"), "escaped code missing: " + html);
});

check("luau fence produces highlighted tokens", () => {
  const html = Markdown.render('```luau\nlocal speed = 10 -- studs\n```');
  assert.ok(html.includes('class="tok-kw">local</span>'), "kw token missing: " + html);
  assert.ok(html.includes('class="tok-num">10</span>'), "number token missing: " + html);
  assert.ok(html.includes('class="tok-com">-- studs</span>'), "comment token missing: " + html);
  assert.ok(html.includes("codeblock-lang"), "code block chrome missing");
  assert.ok(html.includes('class="copy-btn"'), "copy button missing");
});

check("javascript fence highlights keywords and strings", () => {
  const html = Markdown.render('```js\nconst x = "nexora";\n```');
  assert.ok(html.includes('class="tok-kw">const</span>'), "js kw missing: " + html);
  // String contents are HTML-escaped, so the quotes appear as &quot;.
  assert.ok(html.includes('class="tok-str">&quot;nexora&quot;</span>'), "js string missing: " + html);
});

check("function calls and class names are tagged", () => {
  const html = Highlight.highlight('Instance.new("Part")', "luau");
  assert.ok(html.includes('class="tok-cls">Instance</span>'), "class token missing: " + html);
  assert.ok(html.includes('class="tok-fn">new</span>'), "fn token missing: " + html);
});

check("headings, lists, blockquote render", () => {
  const html = Markdown.render("## Plan\n- step one\n- step two\n> note");
  assert.ok(html.includes("<h2>Plan</h2>"), "heading missing: " + html);
  assert.ok(html.includes("<ul>"), "list missing: " + html);
  assert.ok(html.includes("<li>step one</li>"), "list item missing: " + html);
  assert.ok(html.includes("<blockquote>"), "blockquote missing: " + html);
});

check("unsafe link protocols are dropped", () => {
  const html = Markdown.render("[click](javascript:alert(1))");
  assert.ok(!html.includes("javascript:"), "unsafe url kept: " + html);
  assert.ok(html.includes("click"), "label lost: " + html);
});

check("safe https links keep rel protection", () => {
  const html = Markdown.render("[docs](https://create.roblox.com/docs)");
  assert.ok(html.includes('href="https://create.roblox.com/docs"'), "href missing: " + html);
  assert.ok(html.includes('rel="noopener noreferrer"'), "rel missing: " + html);
});

check("plain text paragraph renders", () => {
  const html = Markdown.render("Make combat feel heavier.");
  assert.ok(html.includes("<p>Make combat feel heavier.</p>"), "paragraph missing: " + html);
});

console.log("\n" + passed + " module tests passed.");
