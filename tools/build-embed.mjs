// Gera dist-embed/factory.js (ESM, three incluído, minificado) e dist-embed/factory.css (public/styles.css escopado em .fabrica-embed).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-embed');
const S = '.fabrica-embed';

/** Quebra CSS em blocos de nível 1: { sel, body } (body vazio para declarações sem bloco). Ignora chaves em strings/comentários. */
function blocks(css) {
  const res = []; let i = 0;
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  while (i < css.length) {
    const o = css.indexOf('{', i); if (o < 0) break;
    let d = 1, j = o + 1;
    while (d && j < css.length) { const c = css[j++]; if (c === '{') d++; else if (c === '}') d--; }
    res.push({ sel: css.slice(i, o).trim(), body: css.slice(o + 1, j - 1) });
    i = j;
  }
  return res;
}

// Container query no lugar de @media: o componente responde à largura do container, não da janela do app hospedeiro.
const mediaToContainer = (q) => {
  if (!/width|aspect/.test(q)) return q; // prefers-reduced-motion etc. continuam @media
  const conds = [...new Set(q.replace(/^@media\s*/, '').replace(/\(max-aspect-ratio:[^)]*\)/g, '(max-width:639px)').split(',').map((c) => c.trim()))];
  return `@container fabrica ${conds.join(' or ')}`; // @container não aceita lista com vírgula
};

function scope(sel, inMedia) {
  return sel.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    if (s === ':root' || s === 'html') return null;
    if (s === 'body') return inMedia ? `${S} .fe-root` : null; // regra de página inteira: a base do embed é a .fe-root abaixo
    if (s === '*') return `${S}, ${S} *`;
    return `${S} ${s}`;
  }).filter(Boolean).join(', ');
}

function transform(css) {
  const parts = [];
  for (const { sel, body } of blocks(css)) {
    if (sel.startsWith('@keyframes')) { parts.push(`${sel.replace(/@keyframes\s+(\S+)/, '@keyframes fabrica-$1')}{${body}}`); continue; }
    if (sel.startsWith('@media')) {
      const inner = blocks(body).map((b) => { const s = scope(b.sel, true); return s ? `${s}{${b.body}}` : ''; }).join('');
      parts.push(`${mediaToContainer(sel)}{${inner}}`); continue;
    }
    if (sel.split(',').some((s) => s.trim() === ':root')) { parts.push(`${S}{${body}}`); continue; } // tokens ficam no container
    const s = scope(sel, false);
    if (s) parts.push(`${s}{${body}}`);
  }
  let r = parts.join('\n');
  r = r.replace(/animation:blink/g, 'animation:fabrica-blink').replace(/100vw/g, '100cqw').replace(/100dvh/g, '100cqh');
  const base = `${S}{container:fabrica / inline-size;position:relative;min-height:520px;overflow:hidden;background:var(--bg);color:var(--txt);font:14px/1.35 system-ui,'Segoe UI',Roboto,sans-serif;text-align:left;letter-spacing:normal}
${S} .fe-root{display:grid;grid-template-rows:minmax(0,1fr) auto;height:100%;min-height:520px}`;
  return `${base}\n${r}\n`;
}

mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, 'src/embed/embed.js')], bundle: true, format: 'esm', minify: true, target: 'es2022',
  outfile: join(out, 'factory.js'), legalComments: 'none', logLevel: 'warning',
});
writeFileSync(join(out, 'factory.css'), transform(readFileSync(join(root, 'public/styles.css'), 'utf8')));

const js = readFileSync(join(out, 'factory.js'), 'utf8');
const bad = [/\beval\s*\(/, /new\s+Function\s*\(/, /\bFunction\s*\(\s*["'`]/].filter((r) => r.test(js));
if (bad.length) { console.error('bundle contém eval/new Function:', bad.map(String).join(', ')); process.exit(1); }
console.log(`dist-embed/factory.js ${(js.length / 1024).toFixed(0)} KB, factory.css ok`);
