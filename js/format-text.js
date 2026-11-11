// Question text formatting, the same in the course editor (its "Shows as" lines, grading) and
// on the exam page (questions, options, results). Written in the text, set by the editor's
// toolbar:
//   **bold**   *italic*   __underline__   m^2^ (superscript)   H~2~O (subscript)   `code`
//   lines starting "- " make a bulleted list, "1. " a numbered one; other line breaks stay.
//   Maths in LaTeX: $x^2$ in a line, $$…$$ set apart (matrices, systems of equations,
//   fractions, roots, integrals…); chemistry with \ce: $\ce{H2SO4}$, $\ce{2H2 + O2 -> 2H2O}$.
//   \$ is a dollar sign. KaTeX (with mhchem) draws the maths; it loads the first time a text
//   has any, and until then (or offline) the LaTeX shows as it is written.
// formatQuestionText(text) gives safe HTML (the text is escaped first);
// formatQuestionText.inline(text) the same within a line (options); .plain(text) the text
// without the marks, maths as plain characters (PDFs). Load before the page's own scripts.
window.formatQuestionText = (function () {
  'use strict';

  const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Marks within a line of escaped text. Code first, so nothing inside it is read as a mark.
  // Italic needs its * against the words (2 * 3 * 4 stays as it is); superscript and subscript
  // take no spaces (x^2^, H~2~O).
  function marks(text) {
    const codes = [];
    return text
      .replace(/`([^`\n]+)`/g, (m, code) => `\u0000${codes.push(code) - 1}\u0000`)
      .replace(/\*\*\*(?=\S)([^\n]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([^\n]*?\S)__/g, '<u>$1</u>')
      .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/\^([^\s^]+)\^/g, '<sup>$1</sup>')
      .replace(/~([^\s~]+)~/g, '<sub>$1</sub>')
      .replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[i]}</code>`);
  }

  // ── Maths ──
  // Code spans stay as they are (a $ in code is code); $$…$$ may run over several lines; $…$
  // starts and ends against its content and is not followed by a digit, so "$5 and $10" stays
  // text. Each piece of maths is set aside as \u0001n\u0001 while the rest is formatted.
  // The last thing before the closing $ may be an escaped character (\} in $\{1, 2\}$).
  const PIECES = /`[^`\n]+`|\\\$|\$\$([\s\S]+?)\$\$|\$(?=\S)((?:[^$\n\\]|\\.)*?(?:\\.|[^\s$\\]))\$(?!\d)/g;
  function setAside(text) {
    const math = [];
    const rest = String(text ?? '').replace(PIECES, (m, display, inline) => {
      if (m[0] === '`') return m;
      if (m === '\\$') { math.push({ dollar: true }); return `\u0001${math.length - 1}\u0001`; }
      math.push({ tex: (display ?? inline).trim(), display: display != null });
      return `\u0001${math.length - 1}\u0001`;
    });
    return { rest, math };
  }

  const KATEX = 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/';
  let mathReady = false;
  let loading = null;
  // KaTeX and mhchem, once; then every formula still shown as LaTeX is drawn, now and as pages
  // add them.
  function loadMath() {
    if (mathReady) return Promise.resolve(true);
    if (loading) return loading;
    const script = src => new Promise(resolve => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve(true);
      el.onerror = () => resolve(false);
      document.head.appendChild(el);
    });
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${KATEX}katex.min.css`;
    document.head.appendChild(css);
    loading = (window.katex ? Promise.resolve(true) : script(`${KATEX}katex.min.js`))
      .then(ok => (ok ? script(`${KATEX}contrib/mhchem.min.js`) : false))
      .then(ok => {
        mathReady = !!(ok && window.katex);
        if (mathReady) {
          drawPending(document);
          new MutationObserver(() => { if (document.querySelector('.qmath.is-pending')) drawPending(document); })
            .observe(document.documentElement, { childList: true, subtree: true });
        } else loading = null; // offline: try again with the next formula
        return mathReady;
      });
    return loading;
  }

  const katexOptions = display => ({ displayMode: display, throwOnError: false, strict: 'ignore', output: 'html', trust: false });
  function mathHtml(piece, inline) {
    if (piece.dollar) return '$';
    const display = piece.display && !inline;
    if (mathReady) {
      try {
        return `<span class="qmath${display ? ' is-display' : ''}">${window.katex.renderToString(piece.tex, katexOptions(display))}</span>`;
      } catch { /* shown as written */ }
    } else loadMath();
    return `<span class="qmath is-pending${display ? ' is-display' : ''}" data-tex="${escape(piece.tex)}"${display ? ' data-display="1"' : ''}>${escape(piece.tex)}</span>`;
  }
  function drawPending(root) {
    root.querySelectorAll('.qmath.is-pending').forEach(el => {
      try {
        window.katex.render(el.dataset.tex || '', el, katexOptions(el.dataset.display === '1'));
        el.classList.remove('is-pending');
      } catch { el.classList.remove('is-pending'); }
    });
  }
  const putBack = (html, math, inline) => html.replace(/\u0001(\d+)\u0001/g, (m, i) => (math[i] ? mathHtml(math[i], inline) : ''));

  const BULLET = /^\s*[-•]\s+(.*)$/;
  const NUMBER = /^\s*(\d+)[.)]\s+(.*)$/;

  function format(text) {
    const { rest, math } = setAside(text);
    const out = [];
    let lines = [], list = null;
    const endLines = () => { if (lines.length) out.push(lines.map(marks).join('<br>')); lines = []; };
    const endList = () => {
      if (list) out.push(`<${list.type}${list.start > 1 ? ` start="${list.start}"` : ''}>${list.items.map(i => `<li>${marks(i)}</li>`).join('')}</${list.type}>`);
      list = null;
    };
    for (const line of escape(rest).split(/\r?\n/)) {
      const bullet = line.match(BULLET), number = line.match(NUMBER);
      const type = bullet ? 'ul' : number ? 'ol' : null;
      if (!type) { endList(); lines.push(line); continue; }
      endLines();
      if (list?.type !== type) { endList(); list = { type, start: number ? Number(number[1]) : 1, items: [] }; }
      list.items.push(bullet ? bullet[1] : number[2]);
    }
    endLines();
    endList();
    return putBack(out.join(''), math, false);
  }

  // Within a line (options, summaries): maths in the line's size, matrices too.
  format.inline = text => {
    const { rest, math } = setAside(text);
    return putBack(marks(escape(rest)), math, true);
  };

  // ── As plain text (PDFs, names in lists) ──
  const GREEK = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'θ',
    iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
    phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  };
  const SYMBOLS = {
    times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈',
    equiv: '≡', sim: '~', propto: '∝', infty: '∞', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftrightarrow: '⇔',
    leftrightarrow: '↔', rightleftharpoons: '⇌', degree: '°', circ: '°', partial: '∂', nabla: '∇', sum: 'Σ', prod: 'Π', int: '∫',
    oint: '∮', angle: '∠', perp: '⊥', parallel: '∥', in: '∈', notin: '∉', subset: '⊂', cup: '∪', cap: '∩', forall: '∀',
    exists: '∃', cdots: '⋯', ldots: '…', dots: '…', quad: ' ', qquad: '  ',
    mid: '|', setminus: '∖', emptyset: '∅', varnothing: '∅', subseteq: '⊆', supset: '⊃', supseteq: '⊇', ni: '∋',
    neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨', implies: '⇒', iff: '⇔', mapsto: '↦',
  };
  const BLACKBOARD = { N: 'ℕ', Z: 'ℤ', Q: 'ℚ', R: 'ℝ', C: 'ℂ', P: 'ℙ' };
  const FUNCTIONS = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg',
    'lim', 'exp', 'max', 'min', 'det', 'dim', 'deg'];
  const SUB = '₀₁₂₃₄₅₆₇₈₉', SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  // A chemical formula: H2SO4 as H₂SO₄, charges raised, arrows as arrows.
  const chemPlain = f => f
    .replace(/<=>|<->/g, '⇌').replace(/->/g, '→').replace(/<-/g, '←')
    .replace(/\^\{?(\d*)([+-])\}?/g, (m, n, s) => `${[...n].map(d => SUP[d]).join('')}${s === '+' ? '⁺' : '⁻'}`)
    .replace(/([A-Za-z)\]])(\d+)/g, (m, a, d) => a + [...d].map(c => SUB[c]).join(''))
    .replace(/\s*\(([sgl]|aq)\)/g, '($1)');
  function texPlain(tex) {
    let t = String(tex);
    t = t.replace(/\\ce\{((?:[^{}]|\{[^{}]*\})*)\}/g, (m, f) => chemPlain(f));
    // Braces and signs written as such (\{1, 2\}, \%, \&): kept aside from LaTeX's own.
    t = t.replace(/\\\{/g, '\u0005').replace(/\\\}/g, '\u0006').replace(/\\&/g, '\u0007').replace(/\\([%#_$])/g, '$1');
    t = t.replace(/\\mathbb\{([A-Z])\}/g, (m, letter) => BLACKBOARD[letter] || letter);
    t = t.replace(/\\begin\{([pbvBV]?matrix|smallmatrix|array)\}(?:\{[^}]*\})?([\s\S]*?)\\end\{\1\}/g, (m, env, body) => {
      const rows = body.split(/\\\\/).map(r => r.split('&').map(c => c.trim()).join('  ').trim()).filter(Boolean);
      const [open, close] = env[0] === 'v' ? ['|', '|'] : env[0] === 'V' ? ['‖', '‖'] : env[0] === 'b' || env[0] === 'B' ? ['[', ']'] : ['(', ')'];
      return `${open} ${rows.join('; ')} ${close}`;
    });
    t = t.replace(/\\begin\{(cases|aligned|align\*?|gathered)\}([\s\S]*?)\\end\{\1\}/g, (m, env, body) =>
      `${env === 'cases' ? '\u0003 ' : ''}${body.split(/\\\\/).map(r => r.replace(/&/g, ' ').trim()).filter(Boolean).join('; ')}`);
    for (let i = 0; i < 4; i++) t = t.replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)');
    t = t.replace(/\\sqrt\[([^\]]*)\]\{([^{}]*)\}/g, '$1√($2)').replace(/\\sqrt\{([^{}]*)\}/g, '√($1)');
    t = t.replace(/\\(?:vec|overrightarrow)\{([^{}]*)\}/g, '$1⃗').replace(/\\(?:overline|bar|hat|tilde|dot|mathrm|mathbf|mathit|mathcal|text|textrm|textbf|operatorname|boldsymbol)\{([^{}]*)\}/g, '$1');
    t = t.replace(/\\(left|right|big|Big|bigg|Bigg)\b\\?/g, '');
    t = t.replace(/\\([A-Za-z]+)/g, (m, name) => GREEK[name] || SYMBOLS[name] || (FUNCTIONS.includes(name) ? `${name} ` : ''));
    t = t.replace(/\^\{([^{}]*)\}/g, (m, p) => (/^\d+$/.test(p) ? [...p].map(d => SUP[d]).join('') : `^(${p})`))
      .replace(/\^(\d)/g, (m, d) => SUP[d]).replace(/_\{([^{}]*)\}/g, '_$1');
    return t.replace(/\\[,;:! ]/g, ' ').replace(/\\\\/g, '; ').replace(/[{}]/g, '').replace(/&/g, ' ').replace(/[ \t]+/g, ' ').replace(/\u0003/g, '{')
      .replace(/\u0005/g, '{').replace(/\u0006/g, '}').replace(/\u0007/g, '&').trim();
  }

  format.plain = text => {
    const { rest, math } = setAside(text);
    return rest
      .replace(/`([^`\n]+)`/g, '$1').replace(/\*\*\*|\*\*|__/g, '')
      .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, '$1$2')
      .replace(/\^([^\s^]+)\^/g, '^$1').replace(/~([^\s~]+)~/g, '_$1')
      .replace(/\u0001(\d+)\u0001/g, (m, i) => (math[i]?.dollar ? '$' : math[i] ? texPlain(math[i].tex) : ''));
  };
  // Only the maths as plain characters, the other marks left as they are (for a PDF's own
  // handling of them).
  format.mathPlain = text => {
    const { rest, math } = setAside(text);
    return rest.replace(/\u0001(\d+)\u0001/g, (m, i) => (math[i]?.dollar ? '$' : math[i] ? texPlain(math[i].tex) : ''));
  };
  // Whether the text has any marks (maths too), so the editor shows how it will look.
  format.hasMath = text => setAside(text).math.some(p => !p.dollar);
  format.hasMarks = text => /\*[^*\s]|__\S|\^\S+\^|~\S+~|`[^`]+`|^\s*([-•]|\d+[.)])\s/m.test(String(text ?? '')) || format.hasMath(text);
  format.loadMath = loadMath;
  return format;
})();
