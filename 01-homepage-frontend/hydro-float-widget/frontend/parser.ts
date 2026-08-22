// @filename: frontend/parser.ts

const TAGS: Record<string, string[]> = {
    '': ['<em>', '</em>'],
    '_': ['<strong>', '</strong>'],
    '*': ['<strong>', '</strong>'],
    '~': ['<s>', '</s>'],
    '\n': ['<br />'],
    ' ': ['<br />'],
    '-': ['<hr />']
};

function outdent(str: string) {
    return str.replace(RegExp('^' + (str.match(/^(\t| )+/) || '')[0], 'gm'), '');
}

function encodeAttr(str: string) {
    return (str + '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeUrl(str: string) {
    const value = (str || '').trim();
    if (/[\u0000-\u001f\u007f]/.test(value)) return '';
    if (/^(?:javascript|data|vbscript):/i.test(value)) return '';
    return encodeAttr(value);
}

/** * Parse Markdown into an HTML String.
 * @param md 原始 Markdown 字符串
 * @param prevLinks 可选的预设链接
 */
export function parse(md: string, prevLinks?: Record<string, string>): string {
    let tokenizer = /((?:^|\n+)(?:\n---+|\* \*(?: \*)+)\n)|(?:^``` *(\w*)\n([\s\S]*?)\n```$)|((?:(?:^|\n+)(?:\t| {2,}).+)+\n*)|((?:(?:^|\n)([>*+-]|\d+\.)\s+.*)+)|(?:!\[([^\]]*?)\]\(([^)]+?)\))|(\[)|(\](?:\(([^)]+?)\))?)|(?:(?:^|\n+)([^\s].*)\n(-{3,}|={3,})(?:\n+|$))|(?:(?:^|\n+)(#{1,6})\s*(.+)(?:\n+|$))|(?:`([^`].*?)`)|(  \n|\n|__|\*\*|[_*]|~~)/gm,
        context: string[] = [],
        out = '',
        links: Record<string, string> = prevLinks || {},
        last = 0,
        chunk: string, 
        prev: string, 
        token: RegExpExecArray | null, 
        inner: string, 
        t: string;

    function tag(tokenStr: string) {
	if (tokenStr === '\n') return '<br />';
        let desc = TAGS[tokenStr[1] || ''];
        let end = context[context.length - 1] == tokenStr;
        if (!desc) return tokenStr;
        if (!desc[1]) return desc[0];
        if (end) context.pop();
        else context.push(tokenStr);
        return desc[end ? 1 : 0]; 
    }

    function flush() {
        let str = '';
        while (context.length) str += tag(context[context.length - 1]);
        return str;
    }

    md = md.replace(/^\[(.+?)\]:\s*(.+)$/gm, (s, name, url) => {
        links[name.toLowerCase()] = url;
        return '';
    }).replace(/^\n+|\n+$/g, '');

    while ((token = tokenizer.exec(md))) {
        prev = md.substring(last, token.index);
        last = tokenizer.lastIndex;
        chunk = token[0];
        
        if (prev.match(/[^\\](\\\\)*\\$/)) {
            // escaped - 处理转义
        }
        else if (t = (token[3] || token[4])) {
            chunk = '<pre class="code ' + (token[4] ? 'poetry' : token[2].toLowerCase()) + '"><code' + (token[2] ? ` class="language-${token[2].toLowerCase()}"` : '') + '>' + outdent(encodeAttr(t).replace(/^\n+|\n+$/g, '')) + '</code></pre>';
        }
        else if (t = token[6]) {
            if (t.match(/\./)) {
                token[5] = token[5].replace(/^\d+/gm, '');
            }
            inner = parse(outdent(token[5].replace(/^\s*[>*+.-]/gm, '')));
            if (t == '>') t = 'blockquote';
            else {
                t = t.match(/\./) ? 'ol' : 'ul';
                inner = inner.replace(/^(.*)(\n|$)/gm, '<li>$1</li>');
            }
            chunk = '<' + t + '>' + inner + '</' + t + '>';
        }
        else if (token[8]) {
            chunk = `<img src="${safeUrl(token[8])}" alt="${encodeAttr(token[7])}">`;
        }
        else if (token[10]) {
            out = out.replace('<a>', `<a href="${safeUrl(token[11] || links[prev.toLowerCase()] || '')}">`);
            chunk = flush() + '</a>';
        }
        else if (token[9]) {
            chunk = '<a>';
        }
        else if (token[12] || token[14]) {
            t = 'h' + (token[14] ? token[14].length : (token[13] > '=' ? 1 : 2));
            chunk = '<' + t + '>' + parse(token[12] || token[15], links) + '</' + t + '>';
        }
        else if (token[16]) {
            chunk = '<code>' + encodeAttr(token[16]) + '</code>';
        }
        else if (token[17] || token[1]) {
            chunk = tag(token[17] || '--');
        }
        out += encodeAttr(prev);
        out += chunk;
    }

    return (out + encodeAttr(md.substring(last)) + flush()).replace(/^\n+|\n+$/g, '');
}
