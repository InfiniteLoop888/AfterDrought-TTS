// 渲染载体：先把每一行换成「不可见标记 + 译文」，等酒馆的正则和 Markdown 跑完，
// 再把标记换成语音控件。直接插 HTML 的话，一个标签夹在两段文字中间就会把卡片的
// 整段包裹切断（前端美化卡尤其明显）；标记字符是普通文字，正则和 Markdown 都不认它。
// Unicode 私用区，和 ST-iPhonie 用的是同一套写法。
const OPEN = '\uE000';
const MID = '\uE001';
const CLOSE = '\uE002';
const BASE = 0xE100;
const TOP = 0xE8FF;

const MARKED = new RegExp(`${OPEN}([\\uE100-\\uE8FF])${MID}([^]*?)${CLOSE}`, 'g');
// 标记被正则拆开时留下的孤儿字符，认得出来就一起清掉。
const LEFT = new RegExp(`${OPEN}[\\uE100-\\uE8FF]?${MID}?|${CLOSE}`, 'g');

/** 第 index 行换成标记。一条消息的行数远到不了上限，真超了就原样留着，不挂控件。 */
export function markLine(index, text) {
    if (index > TOP - BASE) return String(text);
    return OPEN + String.fromCharCode(BASE + index) + MID + text + CLOSE;
}

// 正则把一行切断了（行里留下没配对的标签）就只留文字、不挂控件，免得插进去把卡片撑坏。
// 成对的标签没问题：酒馆会把引号包进 <q>，Markdown 会加 <em>、<strong>。
function cutInto(html) {
    let text = String(html).replace(/<br\s*\/?>/gi, '');
    let before;
    do {
        before = text;
        text = text.replace(/<([A-Za-z][\w-]*)(?:\s[^<>]*)?>([^<]*)<\/\1\s*>/g, '$2');
    } while (text !== before);
    return text.includes('<');
}

// 前端美化卡的后处理正则常把回复整段塞进代码块或一整页 HTML，酒馆助手会把后者画进 iframe：
// 控件落进去既没有样式也点不到，标记还会被当成正文显示。这类整块只留文字，和 ST 的 unwaveFramed 一致。
// 标记是在 Markdown 之前插的，走到这里 ``` 已经变成 <pre><code>，所以两种形状都算。
const FRAMED = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|<pre\b[^>]*>[\s\S]*?<\/pre\s*>|<code\b[^>]*>[\s\S]*?<\/code\s*>|<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>|<(?:!doctype\s+html|html)\b[\s\S]*?(?:<\/html\s*>|$)/gi;

/** 去掉落在整块代码/HTML 页面里的标记，只留文字。 */
export function unwaveFramed(html) {
    return String(html).replace(FRAMED, (block) => unmark(block));
}

/**
 * 格式化之后：标记换成 controls[行号]；标记被切坏或者那行没控件时只留文字。
 * onDrop 用来告诉调用方「这句被丢下了」，不然只有译文没有气泡，看不出是自己写的正则切坏了。
 */
export function waveMarks(html, controls = [], onDrop) {
    return unwaveFramed(html).replace(MARKED, (match, number, text) => {
        const control = controls[number.charCodeAt(0) - BASE];
        if (!control) return text;
        if (cutInto(text)) {
            if (typeof onDrop === 'function') onDrop(text);
            return text;
        }
        return control;
    }).replace(LEFT, '');
}

/** 只去掉标记、留下文字：扩展关掉或没走到格式化时用。 */
export function unmark(text) {
    return String(text).replace(MARKED, '$2').replace(LEFT, '');
}
