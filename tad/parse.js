// 对白解析：把「正文 HTML 字符串」扫成 line 对象，不再一边扫描一边拼 HTML。
// 纯函数，不碰 DOM、不读设置，方便单独调试和做单元测试。

const INLINE_TAG = /^<\/?(?:em|strong|b|i|u|q|code|mark|small|sub|sup|font|span|a)\b[^>]*>/i;
const SYSTEM_KEYWORDS = /^(?:ONSTAGE|RECALL|ARCHIVE|FLOOR|STATUS|SYS|VAR|STAGE|SYSTEM|CONFIG|DATA|MEMORY|DATABASE|DEBUG|INFO|ERROR|WARN|TAG|SETTING|VALUE|VARIABLE)$/i;

const EMOTION_TAG = /[\[【]([^\],:【】\[\]\n]{1,30})\s*[,，]\s*([^\]】\n]{1,30})[\]】]/g;
const BARE_TAG = /[\[【]([^\],:【】\[\]\n]{1,30})[\]】]/g;

export function visibleText(value) {
    return String(value || '').replace(/<[^>]+>|&lt;[^&]+&gt;|&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function decodeBasicEntities(value) {
    return String(value)
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
}

export function directorJson(fragment) {
    return String(fragment || '')
        .replace(/<q\b[^>]*>|<\/q>|<br\s*\/?>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;|&#0*34;/gi, '"')
        .replace(/&amp;/gi, '&');
}

export function takeDirector(spoken) {
    const match = String(spoken || '').match(/〖vd:([\s\S]*?)〗/);
    if (!match) return { text: String(spoken || '').trim(), director: null };
    let director = null;
    try {
        const data = JSON.parse(directorJson(match[1]));
        if (data && typeof data === 'object' && !Array.isArray(data)) director = data;
    } catch { /* 导演指令不是合法 JSON 时丢掉，对白照常朗读 */ }
    return { text: String(spoken).replace(match[0], ' ').replace(/\s+/g, ' ').trim(), director };
}

export function segmentText(director) {
    if (!director || !Array.isArray(director.segments)) return '';
    return director.segments.map((item) => (item && item.text) || '').join('').trim();
}

export function segmentEmotion(director) {
    if (!director || !Array.isArray(director.segments)) return 'default';
    const item = director.segments.find((part) => part && part.emotion != null && part.emotion !== '');
    const emotion = item && item.emotion;
    if (typeof emotion === 'string' && emotion.trim()) return emotion.trim();
    if (emotion && typeof emotion === 'object') {
        const preset = emotion.preset || emotion.name;
        if (preset) return String(preset).trim();
    }
    return 'default';
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

function spokenText(raw) {
    const plain = visibleText(String(raw).replace(/<\/?(?:em|strong|b|i|u|q|code|mark|small|sub|sup|font|span|a)\b[^>]*>/gi, ''));
    return decodeBasicEntities(plain);
}

function skipLead(source, index) {
    const match = source.slice(index).match(/^(?:<[^>]+>|[:：\s]|&nbsp;)*/i);
    return index + (match ? match[0].length : 0);
}

function closeQuotePattern(open) {
    if (open === '「' || open === '“' || /^&ldquo;$/i.test(open) || /^&#8220;$/i.test(open)) return /^(?:」|”|&rdquo;|&#8221;)/i;
    if (open === '『') return /^』/;
    return /^(?:"|&quot;)/i;
}

function lineEnded(rest) {
    return /[\n\r]/.test(rest) || /[\[【]/.test(rest) || /<br\b/i.test(rest);
}

// 标记后面紧跟的那句话：优先取成对引号内的内容，没有引号就取到行尾/下一个标记。
function extractSpoken(source, tagEnd, streaming) {
    const start = skipLead(source, tagEnd);
    const rest = source.slice(start);
    const openQuote = rest.match(/^(?:[“"「『]|&ldquo;|&quot;|&#8220;)/i);
    if (openQuote) {
        const closePattern = closeQuotePattern(openQuote[0]);
        let i = start + openQuote[0].length;
        let raw = '';
        let closed = false;
        while (i < source.length) {
            if (source[i] === '\n' || source[i] === '\r' || /^<br\b/i.test(source.slice(i))) break;
            if (source[i] === '<') {
                const inline = source.slice(i).match(INLINE_TAG);
                if (!inline) break;
                raw += inline[0];
                i += inline[0].length;
                continue;
            }
            const close = source.slice(i).match(closePattern);
            if (close) {
                i += close[0].length;
                const tail = source.slice(i).match(/^<\/q\s*>/i);
                if (tail) i += tail[0].length;
                closed = true;
                break;
            }
            raw += source[i];
            i += 1;
        }
        const spoken = spokenText(raw);
        if (spoken.length <= 1) return null;
        return { spoken, settled: closed || !streaming, end: i };
    }

    let i = start;
    let raw = '';
    while (i < source.length) {
        const ch = source[i];
        if (ch === '\n' || ch === '\r' || ch === '[' || ch === '【' || /^<br\b/i.test(source.slice(i))) break;
        if (ch === '<') {
            const inline = source.slice(i).match(INLINE_TAG);
            if (!inline) break;
            raw += inline[0];
            i += inline[0].length;
            continue;
        }
        raw += ch;
        i += 1;
    }
    const spoken = spokenText(raw);
    if (spoken.length <= 1) return null;
    return { spoken, settled: !streaming || lineEnded(source.slice(i)), end: i };
}

function readSegmentDirector(source, tagEnd) {
    const start = skipLead(source, tagEnd);
    if (!source.startsWith('〖vd:', start)) return null;
    const close = source.indexOf('〗', start);
    if (close === -1) return null;
    const directed = takeDirector(source.slice(start, close + 1));
    const text = segmentText(directed.director);
    if (!text) return null;
    return { text, director: directed.director, end: close + 1, settled: true };
}

function badSpeaker(speaker) {
    return !speaker || SYSTEM_KEYWORDS.test(speaker) || /^\d+$/.test(speaker) || speaker.toLowerCase().startsWith('tts');
}

/**
 * 扫描正文，返回 { lines, problems }。
 * line = { kind, start, end, tagEnd, speaker, emotion, text, director, settled }
 * start/end 是相对 source 的偏移，渲染时按区间切片，不再二次正则。
 */
export function parseDialogueLines(source, options = {}) {
    const streaming = options.streaming === true;
    const text = String(source || '');
    const lines = [];
    const problems = [];
    let searchFrom = 0;

    while (searchFrom < text.length) {
        EMOTION_TAG.lastIndex = searchFrom;
        const emotionMatch = EMOTION_TAG.exec(text);
        BARE_TAG.lastIndex = searchFrom;
        let bareMatch = null;
        let segment = null;
        while ((bareMatch = BARE_TAG.exec(text)) !== null) {
            segment = readSegmentDirector(text, bareMatch.index + bareMatch[0].length);
            if (segment) break;
        }
        const emotionAt = emotionMatch ? emotionMatch.index : Infinity;
        const bareAt = segment && bareMatch ? bareMatch.index : Infinity;
        if (emotionAt === Infinity && bareAt === Infinity) break;

        if (bareAt < emotionAt) {
            const speaker = bareMatch[1].trim();
            const tagEnd = bareMatch.index + bareMatch[0].length;
            if (badSpeaker(speaker)) {
                // 方括号本身就常见（脚注、系统提示），这里保持原来的静默跳过，不制造噪音。
                searchFrom = tagEnd;
                continue;
            }
            lines.push({
                kind: 'director',
                start: bareMatch.index,
                end: segment.end,
                tagEnd,
                speaker,
                emotion: segmentEmotion(segment.director),
                text: segment.text,
                director: segment.director,
                settled: true,
            });
            searchFrom = segment.end;
            continue;
        }

        const speaker = emotionMatch[1].trim();
        const emotion = emotionMatch[2].trim();
        const tagEnd = emotionMatch.index + emotionMatch[0].length;
        if (
            !speaker
            || emotion.toLowerCase() === 'new'
            || speaker.toLowerCase().startsWith('tts')
            || /\d|[:：+\-/\\%=><]/.test(emotion)
            || SYSTEM_KEYWORDS.test(speaker)
            || /^\d+$/.test(speaker)
            || emotion.length > 20
        ) {
            if (!badSpeaker(speaker) || SYSTEM_KEYWORDS.test(speaker)) {
                problems.push(`[${speaker}, ${emotion}] 情绪或角色名不像标记，已跳过`);
            }
            searchFrom = tagEnd;
            continue;
        }
        const spoken = extractSpoken(text, tagEnd, streaming);
        if (!spoken) {
            problems.push(`[${speaker}, ${emotion}] 后面没有找到对白`);
            searchFrom = tagEnd;
            continue;
        }
        const directed = takeDirector(spoken.spoken);
        const display = directed.text || segmentText(directed.director);
        if (!display) {
            problems.push(`[${speaker}, ${emotion}] 只找到导演块，没有对白文本`);
            searchFrom = tagEnd;
            continue;
        }
        lines.push({
            kind: 'speech',
            start: emotionMatch.index,
            end: spoken.end,
            tagEnd,
            spokenEnd: spoken.end,
            speaker,
            emotion: emotion || 'default',
            text: display,
            director: directed.director,
            settled: spoken.settled,
        });
        searchFrom = spoken.end;
    }

    return { lines, problems };
}
