// Question text formatting, the same in the course editor (its "Shows as" line, grading) and
// on the exam page (questions, options, results). Written in the text, set by the editor's
// toolbar:
//   **bold**   *italic*   __underline__   m^2^ (superscript)   H~2~O (subscript)   `code`
//   lines starting "- " make a bulleted list, "1. " a numbered one; other line breaks stay.
// formatQuestionText(text) gives safe HTML (the text is escaped first);
// formatQuestionText.inline(text) the same within a line (options); .plain(text) the text
// without the marks (PDFs). Load before the page's own scripts.
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

  const BULLET = /^\s*[-•]\s+(.*)$/;
  const NUMBER = /^\s*(\d+)[.)]\s+(.*)$/;

  function format(text) {
    const out = [];
    let lines = [], list = null;
    const endLines = () => { if (lines.length) out.push(lines.map(marks).join('<br>')); lines = []; };
    const endList = () => {
      if (list) out.push(`<${list.type}${list.start > 1 ? ` start="${list.start}"` : ''}>${list.items.map(i => `<li>${marks(i)}</li>`).join('')}</${list.type}>`);
      list = null;
    };
    for (const line of escape(text).split(/\r?\n/)) {
      const bullet = line.match(BULLET), number = line.match(NUMBER);
      const type = bullet ? 'ul' : number ? 'ol' : null;
      if (!type) { endList(); lines.push(line); continue; }
      endLines();
      if (list?.type !== type) { endList(); list = { type, start: number ? Number(number[1]) : 1, items: [] }; }
      list.items.push(bullet ? bullet[1] : number[2]);
    }
    endLines();
    endList();
    return out.join('');
  }

  format.inline = text => marks(escape(text));
  format.plain = text => String(text ?? '')
    .replace(/`([^`\n]+)`/g, '$1').replace(/\*\*\*|\*\*|__/g, '')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, '$1$2')
    .replace(/\^([^\s^]+)\^/g, '^$1').replace(/~([^\s~]+)~/g, '_$1');
  // Whether the text has any marks, so the editor shows how it will look.
  format.hasMarks = text => /\*[^*\s]|__\S|\^\S+\^|~\S+~|`[^`]+`|^\s*([-•]|\d+[.)])\s/m.test(String(text ?? ''));
  return format;
})();
