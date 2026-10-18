/* build.mjs — inline everything into one static page. */
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";

const src = (p) => readFileSync(new URL("./src/" + p, import.meta.url), "utf8");
let html = src("index.html");

function fill(marker, text) {
  if (!html.includes(marker)) throw new Error("marker " + marker + " is missing from src/index.html");
  html = html.replace(marker, () => text);
}

fill("<!--{{STYLE}}-->", src("style.css").trimEnd());
fill("<!--{{SPEC}}-->", src("spec.html").trimEnd());
fill("<!--{{ENGINE}}-->", src("engine.js").trimEnd());
fill("<!--{{APP}}-->", src("app.js").trimEnd());

/* the page must be self-contained: no external scripts, styles, fonts or imports */
const offenders = [
  /<script[^>]+\bsrc\s*=/i, /<link\b[^>]*\bhref\s*=/i, /<img\b/i, /<iframe\b/i,
  /@import/i, /url\(\s*["']?https?:/i, /<embed\b|<object\b/i
].filter((re) => re.test(html));
if (offenders.length) throw new Error("the page would load external resources: " + offenders.join(", "));
if (/<\/script>/i.test(html.slice(0, html.search(/<\/script>/i)))) throw new Error("script content contains </script>");
if (html.split("<style>").length !== 2 || html.split("<script>").length !== 2) throw new Error("expected exactly one inline style and script block");

mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("./dist/index.html", import.meta.url), html);

/* GitHub Pages serves a project site from a branch folder, and the only folders it
   offers are the root and /docs. So the published copy is generated here, byte for
   byte the same file the tests check — and a test fails if the two ever diverge. */
mkdirSync(new URL("./docs/", import.meta.url), { recursive: true });
writeFileSync(new URL("./docs/index.html", import.meta.url), html);
writeFileSync(new URL("./docs/.nojekyll", import.meta.url), "");

const kb = (statSync(new URL("./dist/index.html", import.meta.url)).size / 1024).toFixed(1);
console.log("dist/index.html written — " + kb + " kB, " + html.split("\n").length + " lines");
console.log("docs/index.html written — the GitHub Pages copy");
