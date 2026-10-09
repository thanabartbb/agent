const PY_KW = 'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|match|case';
const JS_KW = 'as|async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|switch|throw|try|typeof|var|void|while|yield|interface|type|implements|readonly';

const RULES = {
  python: [
    ['comment', /#[^\n]*/],
    ['string', /[rRbBuUfF]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/],
    ['decorator', /@[A-Za-z_][\w.]*/],
    ['def', /\b(?:def|class)\b(?=\s+[A-Za-z_])/],
    ['keyword', new RegExp(`\\b(?:${PY_KW})\\b`)],
    ['constant', /\b(?:True|False|None|self|cls)\b/],
    ['number', /\b\d[\d_]*(?:\.\d+)?\b/],
    ['type', /\b(?:int|str|float|bool|dict|list|tuple|set|Any|Optional)\b/],
    ['func', /\b[A-Za-z_]\w*(?=\s*\()/],
  ],
  js: [
    ['comment', /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
    ['string', /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/],
    ['keyword', new RegExp(`\\b(?:${JS_KW})\\b`)],
    ['constant', /\b(?:true|false|null|undefined|this)\b/],
    ['number', /\b\d[\d_]*(?:\.\d+)?\b/],
    ['type', /\b(?:string|number|boolean|unknown|any|never|void|Promise|Record)\b|\b[A-Z][A-Za-z0-9]*(?=[\s.({<])/],
    ['func', /\b[A-Za-z_$][\w$]*(?=\s*\()/],
  ],
  bash: [
    ['comment', /(?:^|(?<=\s))#[^\n]*/],
    ['prompt', /^\s*\$(?=\s)/m],
    ['string', /"(?:\\.|[^"\\])*"|'[^']*'/],
    ['variable', /\$\{?[A-Za-z_]\w*\}?/],
    ['flag', /(?<=\s)--?[A-Za-z][\w-]*/],
    ['func', /(?<=^\s*(?:\$\s+)?)[A-Za-z][\w.-]*/m],
  ],
  json: [
    ['property', /"(?:\\.|[^"\\])*"(?=\s*:)/],
    ['string', /"(?:\\.|[^"\\])*"/],
    ['constant', /\b(?:true|false|null)\b/],
    ['number', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
  ],
};
RULES.ts = RULES.js;

const COMPILED = {};
function compiled(lang) {
  if (!COMPILED[lang]) {
    const rules = RULES[lang] || [];
    COMPILED[lang] = {
      names: rules.map(([name]) => name),
      re: rules.length ? new RegExp(rules.map(([, re]) => `(${re.source})`).join('|'), 'gm') : null,
    };
  }
  return COMPILED[lang];
}

/** Split code into [{ type, text }] tokens. `type` is null for plain text. */
export function tokenize(code, lang) {
  const { names, re } = compiled(lang);
  if (!re) return [{ type: null, text: code }];
  const out = [];
  let last = 0;
  re.lastIndex = 0;
  for (const m of code.matchAll(re)) {
    if (!m[0]) continue;
    if (m.index > last) out.push({ type: null, text: code.slice(last, m.index) });
    const group = m.slice(1).findIndex((g) => g !== undefined);
    out.push({ type: names[group] || null, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push({ type: null, text: code.slice(last) });
  return out;
}

/** Pick a language from the block's title (file name) and, failing that, its content. */
export function detectLang(title = '', code = '') {
  const t = title.toLowerCase();
  if (/\.py$/.test(t)) return 'python';
  if (/\.tsx?$/.test(t)) return 'ts';
  if (/\.(?:m?js|cjs|jsx)$/.test(t) || t === 'sdk' || t.startsWith('sdk ')) return 'js';
  if (t === 'json' || /\.json$/.test(t)) return 'json';
  if (/^(?:terminal|curl|shell|bash|sh)\b/.test(t) || /^\s*(?:\$ |npm |npx |pip |curl |git |export |cd |node |python3? )/.test(code)) return 'bash';
  if (/^\s*[{[]/.test(code)) { try { JSON.parse(code); return 'json'; } catch (_) {} }
  if (/^\s*(?:def |class \w+.*:|from [\w.]+ import |import \w+\s*$|@\w+)/m.test(code)) return 'python';
  if (/\b(?:const|let|await|function|=>)\b|import .* from ['"]/.test(code)) return 'js';
  return 'text';
}
