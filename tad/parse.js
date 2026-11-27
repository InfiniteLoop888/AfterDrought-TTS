// 对白解析：把「正文 HTML 字符串」扫成 line 对象，不再一边扫描一边拼 HTML。
// 纯函数，不碰 DOM、不读设置，方便单独调试和做单元测试。
// 默认认 ST-iPhonie 的写法：「译文」+ <tts>角色|情绪|文本</tts>；
// 模板可通过 options.format 覆盖（见 compileFormat），自由格式则只写标签。

const SYSTEM_KEYWORDS = /^(?:ONSTAGE|RECALL|ARCHIVE|FLOOR|STATUS|SYS|VAR|STAGE|SYSTEM|CONFIG|DATA|MEMORY|DATABASE|DEBUG|INFO|ERROR|WARN|TAG|SETTING|VALUE|VARIABLE)$/i;

// 代码块里的标签多半是示例或教程，念出来就是噪音。
// 到这一步正文已经是 HTML，围栏代码块一般是 <pre><code>。
const CODE_BLOCKS = [
    /```[\s\S]*?```/g,
    /~~~[\s\S]*?~~~/g,
    /`[^`\n]*`/g,
    /<pre\b[\s\S]*?<\/pre>/gi,
    /<code\b[\s\S]*?<\/code>/gi,
];

// 返回逐字符的「在代码里」标记，长度和原文一致，偏移量不用换算。
function codeMask(text, streaming) {
    if (!text.includes('`') && !/<(?:pre|code)\b/i.test(text)) return null;
    const mask = new Uint8Array(text.length);
    const patterns = streaming ? CODE_BLOCKS.concat(/```[\s\S]*$/g, /~~~[\s\S]*$/g) : CODE_BLOCKS;
    for (const re of patterns) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(text)) !== null) {
            if (!match[0].length) {
                re.lastIndex += 1;
                continue;
            }
            mask.fill(1, match.index, match.index + match[0].length);
        }
    }
    return mask;
}

export function decodeBasicEntities(value) {
    return String(value)
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
}

// 电话/心声：情绪字段开头的这个词只决定播放音效，不能送给网关（网关不认识它）。
// 从 voice-fx.js 的 voiceEffect 搬过来，词表保持一致。
const EFFECT_WORDS = [
    ['inner', /心声|内心独白|内心|心里话|独白|inner ?voice|inner ?thoughts?/gi],
    ['phone', /电话里|电话|通话|听筒|对讲机|over the phone|on the phone|phone call|telephone|phone/gi],
];
const EFFECT_EDGES = /^[\s·・|,，、:：/\\\-—_()（）【】\[\]「」『』]+|[\s·・|,，、:：/\\\-—_()（）【】\[\]「」『』]+$/g;

/** {effect: 'phone' | 'inner' | '', emotion: 去掉标记词后真正送给网关的情绪} */
export function voiceEffect(emotion) {
    const raw = String(emotion ?? '');
    let effect = '';
    let rest = raw;
    for (const [name, re] of EFFECT_WORDS) {
        re.lastIndex = 0;
        if (!re.test(rest)) continue;
        if (!effect) effect = name;
        re.lastIndex = 0;
        rest = rest.replace(re, ' ');
    }
    if (!effect) return { effect: '', emotion: raw };
    rest = rest.replace(/\s+/g, ' ').replace(EFFECT_EDGES, '').replace(/[·・]\s*[·・]+/g, '·').trim();
    return { effect, emotion: rest || 'default' };
}

export function splitSentences(text) {
    const parts = [];
    const opens = '“「『';
    const closes = '”」』';
    for (const block of String(text || '').replace(/\r/g, '').split(/\n+/)) {
        let buf = '';
        let quoted = 0;
        for (const ch of block) {
            buf += ch;
            if (ch === '"') quoted += quoted > 0 ? -1 : 1;
            else if (opens.includes(ch)) quoted += 1;
            else if (closes.includes(ch)) quoted = Math.max(0, quoted - 1);
            if (quoted === 0 && /[。！？!?…]/.test(ch)) {
                if (buf.trim()) parts.push(buf.trim());
                buf = '';
            }
        }
        if (buf.trim()) parts.push(buf.trim());
    }
    return parts.filter((part) => part.length > 1);
}

// ST-iPhonie 的写法：「译文」+ <tts>角色|情绪|文本</tts>。
// 译文是正文里显示的那句，文本是真正送进网关念的那句；中文里两者是同一条。
// ST 默认开「小手机短标签」，新输出写的是 <i-tts>，两种都认；全角 ｜ 当分隔符的人也不少。
// 上限是「一句台词能有多长」：以前写死 6000，超长的标签会整体不匹配，
// 而且因为配对检查数得到开闭标签，连提示都没有，只留一堆裸文字。
const TTS_TAG = /<(?:i-)?tts\s*>([\s\S]{1,20000}?)<\/(?:i-)?tts\s*>/gi;
// 译文紧贴在标签前面才算「这句的译文」。模型写法五花八门，都要认成同一句：
// 中文引号/直角引号/半角双引号、外层再包一层引号（"“你好”"）、全角引号（＂你好＂）。
// 引号内的字符类一律排除其它引号，否则「“你好。”“再见。”<tts>」会被整段吞掉。
const QUOTED_BEFORE = [
    /[*_]{0,3}([“「『"])([^“「『”」』"\n]{1,2000})([”」』"])[*_]{0,3}[ \t]*$/,
    /[*_]{0,3}["＂]([“「『][^“”「」『』\n]{1,2000}[”」』])["＂][*_]{0,3}[ \t]*$/,
    /[*_]{0,3}＂([^“”「」『』＂\n]{1,2000})＂[*_]{0,3}[ \t]*$/,
];
// 心声的两种写法：斜体/下划线包住，或括号包住。只有情绪写着「心声」时才认，
// 免得把「（他笑了）」这种旁白当成译文，从正文里挖走。
const INNER_BEFORE = [
    { pattern: /(\*{1,3}|_{1,2})([^*_\n“”"「」]{1,1000}?)\1[*_]{0,2}[ \t]*$/, text: 2 },
    { pattern: /[（(]([^（）()\n“”"]{1,1000})[）)][*_]{0,2}[ \t]*$/, text: 1 },
];
// 模型照抄提示词占位符时，别把它当角色名送进网关。
const PLACEHOLDER_ROLE = /^\{\{?\s*(?:角色|角色名|role|speaker|char)\s*\}?\}$/iu;

// ---------------------------------------------------------------------------
// 台词格式：提示词、解析、渲染共用同一条模板，占位符固定为
// {译文} {角色} {情绪} {文本}。模板里不写 {译文} 就是自由格式：
// 正文照常写，标签只补充「谁、什么情绪、念哪句」，显示文本取自标签前面紧贴的那句话。
export const DEFAULT_VOICE_FORMAT = '“{译文}”<tts>{角色}|{情绪}|{文本}</tts>';
export const FREE_VOICE_FORMAT = '<tts>{角色}|{情绪}|{文本}</tts>';

function isStandardFormat(source, names) {
    return names.join('|') === '译文|角色|情绪|文本'
        && source.replace(/\s+/g, '') === DEFAULT_VOICE_FORMAT.replace(/\s+/g, '');
}

/** 把模板拆成 { source, names, literals, free, standard }；literals 是占位符之间的固定文字。 */
export function compileFormat(format) {
    const source = String(format ?? '').trim() || DEFAULT_VOICE_FORMAT;
    const names = [];
    const literals = [];
    let at = 0;
    for (const match of source.matchAll(/\{(译文|角色|情绪|文本)\}/g)) {
        literals.push(source.slice(at, match.index));
        names.push(match[1]);
        at = match.index + match[0].length;
    }
    literals.push(source.slice(at));
    return { source, names, literals, free: !names.includes('译文'), standard: isStandardFormat(source, names) };
}

/** 设置面板用：空串表示没问题。 */
export function formatProblem(format) {
    const { source, names, literals } = compileFormat(format);
    if (source.length > 200) return '格式最多 200 个字';
    if (!names.length) return '至少要写 {角色}、{情绪}、{文本} 这三个占位符';
    for (const field of ['角色', '情绪', '文本']) {
        if (names.filter((name) => name === field).length !== 1) return `{${field}} 必须正好写一次`;
    }
    if (names.filter((name) => name === '译文').length > 1) return '{译文} 最多写一次';
    // 首尾两段可以是空的（译文写在最前面、或者最后没有收尾文字），只要求占位符之间别空着。
    if (literals.slice(1, -1).some((literal) => !literal.length)) return '占位符之间要有固定文字（比如 | 和 <tts>）';
    return '';
}

// 模板里的 <tts> 两种写法都认（ST 的短标签是 <i-tts>）；| 允许写成全角 ｜。
// 标签常和别的固定文字连在一起（例如 」<tts>），所以按片段处理，不只认整个字面量。
function literalPattern(literal) {
    const escape = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tag = (part) => escape(part)
        .replace(/<\/(?:i-)?tts>/gi, '<\\/(?:i-)?tts>')
        .replace(/<(?:i-)?tts>/gi, '<(?:i-)?tts>');
    return String(literal).split('|').map(tag).join('[|｜]');
}

function formatPattern(format) {
    const tail = literalPattern(format.literals[format.names.length]);
    // 模板以占位符结尾时（`【{角色}, {情绪}】{文本}` 这种），惰性匹配会正好吞 0 个字，
    // 「文本」永远是空的，一句都解析不出来。这时改成读到下一组的开头或正文结尾为止。
    const head = format.names.length ? literalPattern(format.literals[0]) : '';
    let pattern = '';
    format.names.forEach((name, index) => {
        const literal = literalPattern(format.literals[index]);
        if (index !== format.names.length - 1 || tail) {
            pattern += `${literal}([\\s\\S]{0,20000}?)`;
            return;
        }
        pattern += head
            ? `${literal}([\\s\\S]{1,20000}?)(?=${head}|$)`
            : `${literal}([\\s\\S]{1,20000})`;
    });
    return new RegExp(pattern + tail, 'gi');
}

// 标签写法诊断：<tts role="x"> 这种带属性的写法既不进 TTS_TAG，也不进未闭合统计，
// 结果就是静默不配音。这里宽松扫一遍，没被任何一行覆盖的标签都提一句。
function tagShapeProblems(text, mask, lines, format, reportBare) {
    const problems = [];
    const seen = new Set();
    const covered = (index) => lines.some((line) => index >= line.start && index < line.end);
    const loose = /<(?:i-)?tts\b([^>]*)>/gi;
    let match;
    while ((match = loose.exec(text)) !== null) {
        if (mask && mask[match.index]) continue;
        if (covered(match.index)) continue;
        const attrs = (match[1] || '').trim();
        if (!attrs && !reportBare) continue;
        const snippet = match[0].slice(0, 60).replace(/\s+/g, ' ');
        const message = attrs
            ? `语音标签写法不对，<tts> 不能带属性，应该写成 ${format.source}：${snippet}`
            : `语音标签写法不对，应该写成 ${format.source}：${snippet}`;
        if (seen.has(message)) continue;
        seen.add(message);
        problems.push(message);
    }
    return problems;
}

function nextTtsTag(text, mask, from) {
    TTS_TAG.lastIndex = from;
    let match;
    while ((match = TTS_TAG.exec(text)) !== null) {
        if (mask && mask[match.index]) continue;
        return match;
    }
    return null;
}

// 念出来的文本里会带引擎标签（[叹气]、<break>、(laughs)），比对和显示时先摘掉。
const VOICE_ONLY = /\[[^\]]*\]|<[^>]*>|\((?:[a-z][a-z\s'-]*)\)/gi;

function voiceOnlyText(value) {
    VOICE_ONLY.lastIndex = 0;
    return String(value || '').replace(VOICE_ONLY, '');
}

const coreText = (value) => voiceOnlyText(value).replace(/[\s\p{P}\p{S}]/gu, '');

function chineseText(value) {
    const core = coreText(value);
    return /\p{Script=Han}/u.test(core)
        && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(core)
        && !/[a-z]{3,}/i.test(core);
}

// 模型把一句话拆成两半（前半句在译文里、后半句只在标签里）时，读者只剩半句。
// 中文台词把两半接回整句，念的也是整句；其他语言的译文是翻译，不猜。
function mendLine(line) {
    if (!line.translation) return line;
    const translated = coreText(line.translation);
    const spoken = coreText(line.text);
    if (!translated || !spoken || translated === spoken || translated.includes(spoken)) return line;
    if (!chineseText(line.text) || !chineseText(line.translation)) return line;
    if (spoken.includes(translated)) return { ...line, translation: voiceOnlyText(line.text).trim() };
    const shared = [...new Set(translated)].filter((ch) => spoken.includes(ch)).length
        / Math.min(new Set(translated).size, new Set(spoken).size);
    if (shared >= 0.3) return line;
    const head = line.translation.trim();
    const joint = /[\p{P}]$/u.test(head) ? '' : '，';
    return {
        ...line,
        translation: head + joint + voiceOnlyText(line.text).trim(),
        text: head + joint + line.text.trim(),
    };
}

function quotedBefore(head) {
    for (const pattern of QUOTED_BEFORE) {
        const match = head.match(pattern);
        if (match) return { text: match[2] ?? match[1], length: match[0].length };
    }
    return null;
}

function innerBefore(head) {
    for (const { pattern, text } of INNER_BEFORE) {
        const match = head.match(pattern);
        if (match) return { text: match[text], length: match[0].length };
    }
    return null;
}

// 情绪写着心声（心声·难过 / 内心 / 独白）就按心声显示：不带引号，斜体。
function innerEmotion(emotion) {
    return /心声|内心|独白|inner/i.test(emotion || '');
}

// 引号紧贴在标签前面才算「这句的译文」，中间隔着旁白就不认，免得把上一句抢过来。
// 引号外再包一层斜体（*“…”*）也认，ST 的写法里常见。
// 读不出来时带上原因，好让用户知道该改哪里。
function readTtsLine(source, match) {
    const parts = match[1].replace(/｜/g, '|').split('|');
    if (parts.length < 2) return { problem: '标签里缺少分隔符 |，应该写成 角色|情绪|文本' };
    if (parts.length > 3) return { problem: `标签里分成了 ${parts.length} 段，应该只有 角色|情绪|文本` };
    const speaker = decodeBasicEntities(parts[0]).trim();
    const emotion = parts.length === 3 ? decodeBasicEntities(parts[1]).trim() : '';
    const spoken = decodeBasicEntities(parts[parts.length - 1]).trim();
    if (!speaker) return { problem: '标签里没有写角色名' };
    if (PLACEHOLDER_ROLE.test(speaker)) return { problem: `角色名还是占位符 ${speaker}` };
    if (!spoken) return { problem: '标签里没有写台词' };
    if (badSpeaker(speaker) || speaker.length > 100 || emotion.length > 100) return { problem: '角色名或情绪不像标记' };
    const head = source.slice(0, match.index);
    const inner = innerEmotion(emotion);
    const before = quotedBefore(head) || (inner ? innerBefore(head) : null);
    const translation = before ? decodeBasicEntities(before.text.trim()) : '';
    return { line: mendLine({
        kind: 'tts',
        start: before ? match.index - before.length : match.index,
        end: match.index + match[0].length,
        speaker,
        emotion: emotion || 'default',
        text: spoken,
        translation,
        inner,
        settled: true,
    }) };
}

function badSpeaker(speaker) {
    return !speaker
        || SYSTEM_KEYWORDS.test(speaker)
        || /^\d+$/.test(speaker)
        || speaker.toLowerCase().startsWith('tts')
        || PLACEHOLDER_ROLE.test(speaker);
}

function readFormatLine(source, match, format) {
    const values = {};
    format.names.forEach((name, index) => {
        values[name] = decodeBasicEntities(match[index + 1]).trim();
    });
    const speaker = values['角色'] || '';
    const emotion = values['情绪'] || '';
    // 模板以 {文本} 结尾时，最后一段会一直读到正文末尾，容易把收尾的 HTML 一起吞进来。
    const spoken = String(values['文本'] || '').replace(/(?:<[^<>]*>\s*)+$/, '').trim();
    if (!speaker) return { problem: '标签里没有写角色名' };
    if (PLACEHOLDER_ROLE.test(speaker)) return { problem: `角色名还是占位符 ${speaker}` };
    if (!spoken) return { problem: '标签里没有写台词' };
    if (badSpeaker(speaker) || speaker.length > 100 || emotion.length > 100) return { problem: '角色名或情绪不像标记' };
    const inner = innerEmotion(emotion);
    let translation = values['译文'] || '';
    let start = match.index;
    let tagOnly = false;
    if (!translation) {
        // 自由格式：显示文本取标签前面紧贴的那句（引号/斜体）；取不到就只挂控件，不动正文。
        const head = source.slice(0, match.index);
        const before = quotedBefore(head) || (inner ? innerBefore(head) : null);
        if (before) {
            translation = decodeBasicEntities(before.text.trim());
            start = match.index - before.length;
        } else {
            tagOnly = true;
        }
    }
    const line = {
        kind: 'tts',
        start,
        end: match.index + match[0].length,
        speaker,
        emotion: emotion || 'default',
        text: spoken,
        translation,
        inner,
        tagOnly,
        settled: true,
    };
    // 自由格式里正文那句是读者看到的原文，不能被标签文本覆盖。
    return { line: values['译文'] ? mendLine(line) : line };
}

/**
 * 扫描正文，返回 { lines, problems }。
 * line = { kind, start, end, speaker, emotion, text, translation, inner, tagOnly, settled }
 * start/end 是相对 source 的偏移，渲染时按区间切片，不再二次正则。
 * options.format 可换成自定义模板；默认是 ST-iPhonie 的「译文」+ <tts> 形状。
 */
export function parseDialogueLines(source, options = {}) {
    const text = String(source || '');
    const format = compileFormat(options.format);
    const streaming = options.streaming === true;
    return format.standard ? parseStandard(text, streaming, format) : parseFormat(text, format, streaming);
}

// 默认形状走这套：容忍各种引号变体、i-tts、全角竖线，坏了也尽量接回整句。
function parseStandard(text, streaming, format) {
    const lines = [];
    const problems = [];
    const mask = codeMask(text, streaming);
    let searchFrom = 0;

    while (searchFrom < text.length) {
        const ttsMatch = nextTtsTag(text, mask, searchFrom);
        if (!ttsMatch) break;
        const read = readTtsLine(text, ttsMatch);
        if (!read.line) {
            const snippet = ttsMatch[0].slice(0, 40).replace(/\s+/g, ' ');
            problems.push(`语音标签没认出来（${read.problem}）：${snippet}`);
            searchFrom = ttsMatch.index + ttsMatch[0].length;
            continue;
        }
        lines.push(read.line);
        searchFrom = read.line.end;
    }

    // 边生成边判断会误报（标签还没写完），等这段话生成完再提示。
    if (streaming) return { lines, problems: [] };

    // 开了没闭合的标签会被酒馆当未知标签剥掉，正文里只剩半截文字，这里提前提一句。
    const tagScan = /<\/?(?:i-)?tts\s*>/gi;
    let opened = 0;
    let closed = 0;
    let tagMatch;
    while ((tagMatch = tagScan.exec(text)) !== null) {
        if (mask && mask[tagMatch.index]) continue;
        if (tagMatch[0][1] === '/') closed += 1;
        else opened += 1;
    }
    if (opened > closed) problems.push(`有 ${opened - closed} 个语音标签没闭合，少了 </tts>`);
    problems.push(...tagShapeProblems(text, mask, lines, format, false));

    return { lines, problems };
}

// 自定义模板按字面解析：占位符顺序、分隔符都由模板决定，不再猜引号变体。
function parseFormat(text, format, streaming) {
    const lines = [];
    const problems = [];
    const mask = codeMask(text, streaming);
    const pattern = formatPattern(format);
    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (!match[0].length) {
            pattern.lastIndex += 1;
            continue;
        }
        if (mask && mask[match.index]) continue;
        const read = readFormatLine(text, match, format);
        if (!read.line) {
            problems.push(`语音标签没认出来（${read.problem}）：${match[0].slice(0, 40).replace(/\s+/g, ' ')}`);
            continue;
        }
        lines.push(read.line);
        if (read.line.end > pattern.lastIndex) pattern.lastIndex = read.line.end;
    }
    if (streaming) return { lines, problems: [] };
    problems.push(...tagShapeProblems(text, mask, lines, format, true));
    return { lines, problems };
}
