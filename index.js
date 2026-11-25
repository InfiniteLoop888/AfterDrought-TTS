import { eventSource, event_types, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';

const STORAGE = {
    api: 'tad_api',
    auto: 'tad_auto',
    enabled: 'tad_enabled',
    inject: 'tad_inject',
    fab: 'tad_fab',
};

const PROMPT_KEY = 'tts-afterdrought-dialogue';
const DEFAULT_API = 'http://127.0.0.1:7860';
const SPEECH_SAMPLING = {
    do_sample: 'true',
    temperature: '0.7',
    num_beams: '1',
    repetition_penalty: '10',
};


const VECTORS = {
    // ==========================================
    // 基础情绪
    // [开心, 愤怒, 悲伤, 恐惧, 厌恶, 低落, 惊讶, 平静]
    // ==========================================

    '平静': [0, 0, 0, 0, 0, 0, 0, 0.18],
    '日常': [0.02, 0, 0, 0, 0, 0, 0, 0.22],
    '自然': [0.04, 0, 0, 0, 0, 0, 0, 0.25],
    '温柔': [0.12, 0, 0, 0, 0, 0, 0, 0.30],
    '轻松': [0.22, 0, 0, 0, 0, 0, 0, 0.18],
    '开心': [0.55, 0, 0, 0, 0, 0, 0, 0.08],
    '高兴': [0.65, 0, 0, 0, 0, 0, 0, 0.05],
    '喜悦': [0.78, 0, 0, 0, 0, 0, 0, 0],
    '兴奋': [0.85, 0, 0, 0, 0, 0, 0.12, 0],
    '狂喜': [1.0, 0, 0, 0, 0, 0, 0.15, 0],

    // ==========================================
    // 愤怒与不满
    // ==========================================

    '不满': [0, 0.18, 0, 0, 0.05, 0, 0, 0.12],
    '不悦': [0, 0.25, 0, 0, 0.08, 0, 0, 0.08],
    '恼火': [0, 0.45, 0, 0, 0.08, 0, 0, 0],
    '生气': [0, 0.60, 0, 0, 0.05, 0, 0, 0],
    '愤怒': [0, 0.82, 0, 0, 0.08, 0, 0, 0],
    '暴怒': [0, 1.0, 0, 0, 0.15, 0, 0, 0],
    '恼羞成怒': [0.12, 0.65, 0, 0, 0, 0, 0.05, 0],
    '气愤': [0, 0.75, 0.05, 0, 0.12, 0, 0, 0],
    '委屈地生气': [0, 0.35, 0.38, 0, 0, 0.12, 0, 0],
    '压抑怒火': [0, 0.48, 0.05, 0, 0.05, 0, 0, 0.20],
    '冷淡不满': [0, 0.25, 0, 0, 0.12, 0.05, 0, 0.25],

    // ==========================================
    // 悲伤与低落
    // ==========================================

    '失落': [0, 0, 0.30, 0, 0, 0.25, 0, 0.05],
    '难过': [0, 0, 0.55, 0, 0, 0.15, 0, 0],
    '悲伤': [0, 0, 0.72, 0, 0, 0.20, 0, 0],
    '伤心': [0, 0, 0.80, 0, 0, 0.15, 0, 0],
    '低落': [0, 0, 0.15, 0, 0, 0.40, 0, 0.08],
    '沮丧': [0, 0.08, 0.30, 0, 0, 0.45, 0, 0],
    '绝望': [0, 0, 0.85, 0.08, 0, 0.55, 0, 0],
    '心碎': [0, 0, 0.90, 0, 0, 0.60, 0, 0],
    '悲伤地微笑': [0.18, 0, 0.42, 0, 0, 0.12, 0, 0.05],
    '强忍悲伤': [0, 0, 0.48, 0, 0, 0.25, 0, 0.28],
    '哽咽': [0, 0, 0.72, 0.08, 0, 0.18, 0, 0],
    '哭泣': [0, 0, 0.85, 0.10, 0, 0.30, 0, 0],
    '痛哭': [0, 0, 1.0, 0.18, 0, 0.35, 0, 0],

    // ==========================================
    // 恐惧与紧张
    // ==========================================

    '紧张': [0, 0, 0, 0.28, 0, 0.05, 0, 0.12],
    '不安': [0, 0, 0.08, 0.35, 0, 0.12, 0, 0.08],
    '担忧': [0, 0, 0.18, 0.38, 0, 0.12, 0, 0.05],
    '害怕': [0, 0, 0, 0.60, 0, 0.05, 0, 0],
    '恐惧': [0, 0, 0, 0.82, 0, 0, 0.05, 0],
    '惊恐': [0, 0, 0, 0.95, 0, 0, 0.35, 0],
    '慌张': [0.05, 0, 0, 0.60, 0, 0, 0.25, 0],
    '焦虑': [0, 0.08, 0.12, 0.55, 0, 0.18, 0, 0],
    '忐忑': [0.08, 0, 0.05, 0.38, 0, 0.05, 0.08, 0.05],
    '如释重负': [0.38, 0, 0, 0, 0, 0.05, 0, 0.15],

    // ==========================================
    // 厌恶与嫌弃
    // ==========================================

    '嫌弃': [0, 0.08, 0, 0, 0.40, 0, 0, 0.08],
    '厌恶': [0, 0.05, 0, 0, 0.70, 0, 0, 0],
    '反感': [0, 0.22, 0, 0, 0.52, 0, 0, 0],
    '鄙夷': [0, 0.18, 0, 0, 0.65, 0, 0, 0.08],
    '嫌弃地吐槽': [0.05, 0.18, 0, 0, 0.45, 0, 0, 0.05],
    '无奈': [0.05, 0.08, 0.12, 0, 0, 0.18, 0, 0.25],

    // ==========================================
    // 惊讶与困惑
    // ==========================================

    '惊讶': [0.08, 0, 0, 0, 0, 0, 0.55, 0],
    '震惊': [0, 0, 0, 0.05, 0, 0, 0.90, 0],
    '惊喜': [0.48, 0, 0, 0, 0, 0, 0.45, 0],
    '意外': [0.12, 0, 0, 0, 0, 0, 0.45, 0.05],
    '疑惑': [0, 0, 0, 0, 0, 0, 0.30, 0.12],
    '困惑': [0, 0, 0.05, 0, 0, 0.08, 0.25, 0.12],
    '难以置信': [0, 0, 0, 0, 0, 0, 0.70, 0],
    '恍然大悟': [0.30, 0, 0, 0, 0, 0, 0.35, 0.08],

    // ==========================================
    // 害羞与亲密
    // ==========================================

    '害羞': [0.18, 0, 0.03, 0.12, 0, 0, 0.05, 0.12],
    '羞涩': [0.22, 0, 0, 0.08, 0, 0, 0, 0.18],
    '脸红': [0.28, 0, 0, 0.05, 0, 0, 0.03, 0.08],
    '不好意思': [0.18, 0, 0, 0.08, 0, 0, 0, 0.18],
    '羞恼': [0.15, 0.35, 0, 0, 0, 0, 0.08, 0],
    '撒娇': [0.48, 0, 0, 0, 0, 0, 0, 0.08],
    '依恋': [0.35, 0, 0.05, 0, 0, 0, 0, 0.25],
    '宠溺': [0.40, 0, 0, 0, 0, 0, 0, 0.28],
    '暧昧': [0.28, 0, 0, 0, 0, 0, 0, 0.12],
    '温存': [0.32, 0, 0, 0, 0, 0, 0, 0.32],
    '深情': [0.42, 0, 0.08, 0, 0, 0, 0, 0.18],
    '吃醋': [0.05, 0.32, 0.15, 0, 0.05, 0.08, 0, 0.05],
    '占有欲': [0.12, 0.38, 0.05, 0, 0, 0, 0, 0.05],
    '委屈撒娇': [0.18, 0.12, 0.35, 0, 0, 0.08, 0, 0.05],
    '期待': [0.35, 0, 0, 0.08, 0, 0, 0.18, 0.05],
    '眷恋': [0.25, 0, 0.18, 0, 0, 0.05, 0, 0.22],

    // ==========================================
    // 特殊语气与复杂情绪
    // ==========================================

    '调皮': [0.48, 0.05, 0, 0, 0, 0, 0.12, 0],
    '俏皮': [0.42, 0, 0, 0, 0, 0, 0.08, 0.08],
    '得意': [0.55, 0, 0, 0, 0, 0, 0.05, 0.05],
    '自信': [0.32, 0, 0, 0, 0, 0, 0, 0.28],
    '傲娇': [0.18, 0.28, 0, 0, 0, 0, 0.05, 0.05],
    '温柔地责备': [0.08, 0.22, 0, 0, 0, 0, 0, 0.28],
    '无可奈何': [0.02, 0.08, 0.12, 0, 0, 0.18, 0, 0.28],
    '苦笑': [0.08, 0.05, 0.35, 0, 0, 0.12, 0, 0.08],
    '自嘲': [0.12, 0, 0.25, 0, 0, 0.18, 0, 0.08],
    '认真': [0, 0, 0, 0, 0, 0, 0, 0.42],
    '严肃': [0, 0.08, 0, 0, 0, 0, 0, 0.48],
    '坚定': [0.08, 0.15, 0, 0, 0, 0, 0, 0.28],
    '疲惫': [0, 0, 0.12, 0, 0, 0.42, 0, 0.12],
    '困倦': [0.02, 0, 0.05, 0, 0, 0.35, 0, 0.20],
    '慵懒': [0.12, 0, 0, 0, 0, 0.18, 0, 0.25],
    '敷衍': [0, 0.08, 0, 0, 0.12, 0.12, 0, 0.18],
    '冷淡': [0, 0.05, 0.05, 0, 0.08, 0.15, 0, 0.32],
    '尴尬': [0.05, 0, 0.08, 0.12, 0, 0, 0.12, 0.08],
    '释然': [0.25, 0, 0.05, 0, 0, 0, 0, 0.25],
    '感动': [0.30, 0, 0.38, 0, 0, 0.08, 0.08, 0.05],
    '欣慰': [0.40, 0, 0, 0, 0, 0, 0, 0.30],
    '幸福': [0.65, 0, 0, 0, 0, 0, 0, 0.15],
    '温暖': [0.38, 0, 0, 0, 0, 0, 0, 0.35],

    // ==========================================
    // English aliases
    // ==========================================

    happy: [0.60, 0, 0, 0, 0, 0, 0, 0],
    excited: [0.85, 0, 0, 0, 0, 0, 0.12, 0],
    joyful: [0.78, 0, 0, 0, 0, 0, 0, 0],
    angry: [0, 0.82, 0, 0, 0.08, 0, 0, 0],
    annoyed: [0, 0.35, 0, 0, 0.12, 0, 0, 0.08],
    sad: [0, 0, 0.65, 0, 0, 0.20, 0, 0],
    crying: [0, 0, 0.85, 0.10, 0, 0.30, 0, 0],
    afraid: [0, 0, 0, 0.65, 0, 0, 0, 0],
    nervous: [0, 0, 0, 0.30, 0, 0.05, 0, 0.15],
    disgusted: [0, 0.05, 0, 0, 0.70, 0, 0, 0],
    surprised: [0.08, 0, 0, 0, 0, 0, 0.55, 0],
    calm: [0, 0, 0, 0, 0, 0, 0, 0.18],
    gentle: [0.12, 0, 0, 0, 0, 0, 0, 0.30],
    shy: [0.18, 0, 0.03, 0.12, 0, 0, 0.05, 0.12],
    embarrassed: [0.15, 0, 0.05, 0.12, 0, 0, 0.08, 0.10],
    playful: [0.48, 0.05, 0, 0, 0, 0, 0.12, 0],
    affectionate: [0.40, 0, 0, 0, 0, 0, 0, 0.28],
    sarcastic: [0.05, 0.20, 0, 0, 0.12, 0, 0, 0.12],
    tired: [0, 0, 0.12, 0, 0, 0.42, 0, 0.12],
    confident: [0.32, 0, 0, 0, 0, 0, 0, 0.28]
};


const BARS_HTML = '<span class="sovits-voice-waves"><span class="sovits-voice-bar"></span><span class="sovits-voice-bar"></span><span class="sovits-voice-bar"></span></span>';
const BUBBLE_ROOTS = '.mes_text, .message-body, .markdown-content, #chat .mes_text, .mes .text';
const LONG_PRESS_MS = 550;
const SYSTEM_KEYWORDS = /^(?:ONSTAGE|RECALL|ARCHIVE|FLOOR|STATUS|SYS|VAR|STAGE|SYSTEM|CONFIG|DATA|MEMORY|DATABASE|DEBUG|INFO|ERROR|WARN|TAG|SETTING|VALUE|VARIABLE)$/i;

const memory = new Map();
const pending = new Set();
const genQueue = [];
let audio = null;
let playToken = 0;
let scanTimer = 0;
let pumping = false;
let playNewReply = false;
let streaming = false;
let voiceBlob = null;
let voiceName = '';

function apiBase() {
    return (localStorage.getItem(STORAGE.api) || DEFAULT_API)
        .trim()
        .replace(/\/+$/, '')
        .replace(/\/api\/v1$/, '')
        .replace(/\/tts$/, '');
}

function enabled() {
    return localStorage.getItem(STORAGE.enabled) !== '0';
}

function autoPlay() {
    return localStorage.getItem(STORAGE.auto) === '1';
}

function injectEnabled() {
    return localStorage.getItem(STORAGE.inject) !== '0';
}

function currentCharacterName() {
    try {
        const context = globalThis.SillyTavern?.getContext?.();
        if (!context) return '';
        const characters = Array.isArray(context.characters) ? context.characters : [];
        const byAvatar = characters.find((character) => character && character.avatar === context.characterId);
        const byIndex = Number.isInteger(context.characterId) ? characters[context.characterId] : null;
        return String(byAvatar?.name || byIndex?.name || context.name2 || '').trim();
    } catch {
        return '';
    }
}

let speakableGeneration = true;

function promptEmotionNames() {
    return Object.keys(VECTORS).filter((name) => /[\u4e00-\u9fff]/.test(name));
}

function dialoguePrompt() {
    const name = currentCharacterName();
    const who = name ? `当前角色卡的名字是「${name}」。这个角色开口时必须使用这个名字，不要换成称呼、代词或昵称。\n` : '';
    return `[对白语音标记]
${who}角色真正说出口的每一句都要打上语音标记，否则无法朗读。旁白、动作、心理活动保持普通正文，不要放进标记。

格式，标记和这句对白在同一行：
[角色名, 情绪] 对白内容

规则：
1. 同一个人全篇只用同一个角色名。
2. 情绪只能从这些词里选一个：default、${promptEmotionNames().join('、')}。听不出明显情绪时用 default。
3. 标记后面同一行只写这一句口头对白。旁白另起一行，写在标记外面。

示例：
她把目光挪开。
[甘雨, 害羞] 你、你怎么突然说这种话……
[甘雨, default] 今天的工作终于结束了。`.trim();
}

function applyDialoguePrompt() {
    const text = injectEnabled() ? dialoguePrompt() : '';
    setExtensionPrompt(
        PROMPT_KEY,
        text,
        extension_prompt_types.IN_CHAT,
        1,
        false,
        extension_prompt_roles.SYSTEM,
        () => speakableGeneration,
    );
}

function generating() {
    const stop = document.querySelector('#mes_stop');
    if (!stop) return false;
    return getComputedStyle(stop).display !== 'none';
}

function replyStreaming() {
    return streaming || generating();
}

function escapeHtmlAttr(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function visibleText(value) {
    return String(value || '').replace(/<[^>]+>|&lt;[^&]+&gt;|&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function bubbleKey(speaker, emotion, text) {
    return `${speaker}\n${emotion}\n${text}`;
}

function buildBubbleHtml(speaker, emotion, text, settled = true) {
    const key = bubbleKey(speaker, emotion, text);
    const cached = voiceName ? memory.get(`${voiceName}\n${emotion}\n${text}`) : '';
    const status = cached ? 'ready' : (pending.has(key) ? 'queued' : 'waiting');
    const loading = status === 'queued' ? ' loading' : '';
    const width = Math.min(220, 60 + Math.max(2, Math.ceil(text.length * 0.25)) * 10);
    const seconds = Math.max(2, Math.ceil(text.length * 0.25));
    const url = cached ? ` data-audio-url="${escapeHtmlAttr(cached)}"` : '';
    const settledAttr = settled ? '' : ' data-settled="0"';
    return `<span class="voice-bubble${loading}" style="width: ${width}px" data-status="${status}" data-key="${escapeHtmlAttr(key)}"${url} data-text="${escapeHtmlAttr(text)}" data-voice-name="${escapeHtmlAttr(speaker)}" data-voice-emotion="${escapeHtmlAttr(emotion)}"${settledAttr}>${BARS_HTML}<span class="sovits-voice-duration">${seconds}&quot;</span></span>`;
}

function lineEnded(rest) {
    return /[\n\r]/.test(rest) || /[\[【]/.test(rest) || /<br\b/i.test(rest);
}

function extractSpoken(source, tagEnd) {
    const stripped = source.slice(tagEnd).replace(/^(?:<[^>]+>|[:：\s]|&nbsp;)+/gi, '');
    const openQuote = /^(?:[“"「『]|&ldquo;|&quot;|&#8220;)/i;
    const quoteMatch = stripped.match(/^(?:([“"「『]|&ldquo;|&quot;|&#8220;)([\s\S]*?)([”"」』]|&rdquo;|&quot;|&#8221;))/i);
    if (openQuote.test(stripped)) {
        if (!(quoteMatch && visibleText(quoteMatch[2]))) {
            const plain = stripped.replace(/^(?:[“"「『]|&ldquo;|&quot;|&#8220;)/i, '').match(/^([^<\[【\n\r]+)/);
            const partial = plain ? visibleText(plain[1]) : '';
            if (partial.length <= 1) return null;
            return { spoken: partial, settled: !replyStreaming() };
        }
        return { spoken: visibleText(quoteMatch[2]), settled: true };
    }
    const plain = stripped.match(/^([^<\[【\n\r]+)/);
    const spoken = plain ? visibleText(plain[1]) : '';
    if (spoken.length <= 1) return null;
    const rest = stripped.slice(plain[0].length);
    return { spoken, settled: !replyStreaming() || lineEnded(rest) };
}

function parseTextToBubbles(html) {
    let source = html.replace(/[\[【]([^\],:【】\[\]\n]{1,30})\s*[,，]\s*(?:New|new)[\]】]/g, (match, speaker) => {
        const name = speaker.trim();
        if (!name || /^\d+$/.test(name) || SYSTEM_KEYWORDS.test(name)) return match;
        return `[${name}, default]`;
    });

    const tagRe = /[\[【]([^\],:【】\[\]\n]{1,30})\s*[,，]\s*([^\]】\n]{1,30})[\]】]/g;
    let result = '';
    let lastIndex = 0;
    let matched = false;
    let match;
    while ((match = tagRe.exec(source)) !== null) {
        const speaker = match[1].trim();
        const emotion = match[2].trim();
        const tagEnd = match.index + match[0].length;
        if (!speaker || emotion.toLowerCase() === 'new' || speaker.toLowerCase().startsWith('tts')) continue;
        if (
            /\d|[:：+\-/\\%=><]/.test(emotion)
            || SYSTEM_KEYWORDS.test(speaker)
            || /^\d+$/.test(speaker)
            || emotion.length > 20
        ) continue;

        const spoken = extractSpoken(source, tagEnd);
        if (!spoken) continue;

        matched = true;
        result += source.slice(lastIndex, match.index);
        lastIndex = tagEnd;
        result += buildBubbleHtml(speaker, emotion || 'default', spoken.spoken, spoken.settled);
    }
    const tagged = matched ? result + source.slice(lastIndex) : source;
    const withLegacy = tagged.replace(/(\s*)\[TTSVoice[:：]\s*([^:：]+)\s*[:：]\s*([^:：]*)\s*[:：]\s*(.*?)\]/gi, (full, space, name, emotion, text) => {
        const spoken = visibleText(text);
        if (!spoken) return full;
        return `${space || ''}${buildBubbleHtml(name.trim(), emotion.trim() || 'default', spoken)}`;
    });
    return withLegacy === html ? html : withLegacy;
}

function emotionFields(emotion) {
    const name = (emotion || 'default').trim();
    const vector = VECTORS[name] || VECTORS[name.toLowerCase()];
    if (!vector) return { emo_mode: '0', emo_weight: '0.65' };
    const fields = { emo_mode: '2', emo_weight: '0.8' };
    vector.forEach((value, index) => {
        fields[`vec${index + 1}`] = String(value);
    });
    return fields;
}

function voiceDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('tts-afterdrought', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('kv');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function rememberVoice(blob, name) {
    voiceBlob = blob;
    voiceName = name || 'voice.wav';
    memory.clear();
    document.querySelectorAll('.voice-bubble').forEach((btn) => {
        btn.dataset.status = 'waiting';
        btn.removeAttribute('data-audio-url');
        btn.classList.remove('loading', 'playing', 'error');
    });
    scheduleLast(false);
    try {
        const db = await voiceDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put({ blob: voiceBlob, name: voiceName }, 'voice');
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch { /* 存不下时，这次页面里仍然用刚选的文件 */ }
}

async function referenceAudio() {
    if (voiceBlob) return { blob: voiceBlob, name: voiceName || 'voice.wav' };
    try {
        const db = await voiceDb();
        const saved = await new Promise((resolve, reject) => {
            const request = db.transaction('kv', 'readonly').objectStore('kv').get('voice');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        if (saved && saved.blob) {
            voiceBlob = saved.blob;
            voiceName = saved.name || 'voice.wav';
            return { blob: voiceBlob, name: voiceName };
        }
    } catch { /* 没有存过音色时用服务自带示例 */ }
    const response = await fetch(`${apiBase()}/api/v1/examples/voice_03.wav`);
    if (!response.ok) throw new Error('读不到参考音频');
    voiceBlob = await response.blob();
    voiceName = 'voice_03.wav';
    return { blob: voiceBlob, name: voiceName };
}

function stopPlayback() {
    playToken += 1;
    if (audio) {
        audio.pause();
        audio = null;
    }
    document.querySelectorAll('.voice-bubble.playing').forEach((node) => node.classList.remove('playing'));
    document.querySelectorAll('.voice-bubble[data-autoplay="1"]').forEach((node) => {
        delete node.dataset.autoplay;
    });
}

async function readSse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let doneEvent = null;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = block.split('\n').find((item) => item.startsWith('data:'));
            if (!line) continue;
            let event;
            try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (event.type === 'error') throw new Error(event.detail || '生成失败');
            if (event.type === 'stopped') throw new Error(event.detail || '已停止生成');
            if (event.type === 'done') doneEvent = event;
        }
    }
    if (!doneEvent || !doneEvent.wav) throw new Error('生成连接中断');
    return doneEvent;
}

async function fetchAudio(segment) {
    const voice = await referenceAudio();
    const key = `${voice.name}\n${segment.emotion}\n${segment.text}`;
    if (memory.has(key)) return memory.get(key);
    const body = new FormData();
    body.append('text', segment.text);
    body.append('client_id', 'afterdrought-tts');
    body.append('spk_audio', voice.blob, voice.name);
    for (const [name, value] of Object.entries(emotionFields(segment.emotion))) {
        body.append(name, value);
    }
    for (const [name, value] of Object.entries(SPEECH_SAMPLING)) {
        body.append(name, value);
    }
    let response;
    try {
        response = await fetch(`${apiBase()}/api/v1/tts`, { method: 'POST', body });
    } catch {
        throw new Error('TTS 服务未就绪');
    }
    if (!response.ok) {
        let detail = `TTS 失败 (${response.status})`;
        try {
            const data = await response.json();
            if (data.detail) detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
        } catch { /* 非 JSON 错误体 */ }
        throw new Error(detail);
    }
    const doneEvent = await readSse(response);
    const wavPath = doneEvent.wav.startsWith('/') ? `${apiBase()}${doneEvent.wav}` : doneEvent.wav;
    const wav = await fetch(wavPath);
    if (!wav.ok) throw new Error('音频下载失败');
    const url = URL.createObjectURL(await wav.blob());
    memory.set(key, url);
    return url;
}

function playUrl(url) {
    if (audio) audio.pause();
    const next = new Audio(url);
    audio = next;
    return new Promise((resolve) => {
        const finish = () => {
            if (audio === next) audio = null;
            resolve();
        };
        next.onended = finish;
        next.onerror = finish;
        next.play().catch(finish);
    });
}

function bubblesByKey(key) {
    return [...document.querySelectorAll('#chat .voice-bubble')].filter((btn) => btn.dataset.key === key);
}

function enqueue(btn, { autoplay = false } = {}) {
    if (!btn || btn.dataset.status !== 'waiting') return;
    const key = btn.dataset.key;
    const cached = voiceName ? memory.get(`${voiceName}\n${btn.dataset.voiceEmotion}\n${btn.dataset.text}`) : '';
    if (cached) {
        btn.dataset.status = 'ready';
        btn.dataset.audioUrl = cached;
        btn.classList.remove('loading');
        if (autoplay) playBubble(btn);
        return;
    }
    if (autoplay) btn.dataset.autoplay = '1';
    if (pending.has(key)) {
        btn.dataset.status = 'queued';
        btn.classList.add('loading');
        return;
    }
    btn.dataset.status = 'queued';
    btn.classList.add('loading');
    pending.add(key);
    genQueue.push(btn);
}

async function playBubble(btn) {
    const url = btn?.dataset.audioUrl;
    if (!url) return;
    const token = ++playToken;
    const same = bubblesByKey(btn.dataset.key);
    document.querySelectorAll('.voice-bubble.playing').forEach((node) => node.classList.remove('playing'));
    same.forEach((node) => node.classList.add('playing'));
    await playUrl(url);
    if (token === playToken) same.forEach((node) => node.classList.remove('playing'));
}

async function pump() {
    if (pumping) return;
    pumping = true;
    try {
        while (genQueue.length) {
            let btn = genQueue.shift();
            const key = btn?.dataset.key;
            if (!btn || !key) continue;
            if (!btn.isConnected) {
                const live = bubblesByKey(key).find((node) => node.isConnected);
                if (!live) {
                    pending.delete(key);
                    continue;
                }
                if (btn.dataset.autoplay === '1') live.dataset.autoplay = '1';
                btn = live;
            }
            try {
                btn.dataset.status = 'generating';
                btn.classList.add('loading');
                const url = await fetchAudio({
                    speaker: btn.dataset.voiceName,
                    emotion: btn.dataset.voiceEmotion || 'default',
                    text: btn.dataset.text,
                });
                bubblesByKey(key).forEach((node) => {
                    node.dataset.status = 'ready';
                    node.dataset.audioUrl = url;
                    node.classList.remove('loading', 'error');
                    node.removeAttribute('title');
                });
                if (btn.dataset.autoplay === '1') await playBubble(btn);
        } catch (error) {
                bubblesByKey(key).forEach((node) => {
                    node.dataset.status = 'error';
                    node.classList.remove('loading');
                    node.classList.add('error');
                    node.title = error.message || String(error);
                });
            } finally {
                pending.delete(key);
            }
        }
    } finally {
        pumping = false;
        if (genQueue.length) pump();
    }
}

function lastMesText() {
    const nodes = document.querySelectorAll('.mes_text');
    return nodes.length ? nodes[nodes.length - 1] : null;
}

function scheduleLast(autoplay) {
    const last = lastMesText();
    if (!last) return;
    last.querySelectorAll('.voice-bubble').forEach((btn) => {
        if (btn.dataset.settled === '0') return;
        if (autoplay && btn.dataset.status !== 'ready' && btn.dataset.status !== 'error') btn.dataset.autoplay = '1';
        if (btn.dataset.status === 'waiting') enqueue(btn, { autoplay });
    });
    pump();
}

function scan() {
    if (!enabled()) return;
    let changed = false;
    document.querySelectorAll(BUBBLE_ROOTS).forEach((node) => {
        if (!node.isConnected || node.closest('.voice-bubble')) return;
        const html = node.innerHTML;
        if (!html || (!html.includes('[') && !html.includes('【'))) return;
        const next = parseTextToBubbles(html);
        if (next === html) return;
        node.innerHTML = next;
        changed = true;
    });
    if (changed) {
        const autoplay = playNewReply;
        setTimeout(() => scheduleLast(autoplay), 100);
    }
    if (!generating()) playNewReply = false;
}

function rerollBubble(btn) {
    if (!btn) return;
    const emotion = btn.dataset.voiceEmotion || 'default';
    const text = btn.dataset.text || '';
    if (voiceName) memory.delete(`${voiceName}\n${emotion}\n${text}`);
    bubblesByKey(btn.dataset.key).forEach((node) => {
        node.dataset.status = 'waiting';
        node.removeAttribute('data-audio-url');
        node.classList.remove('loading', 'playing', 'error');
    });
    enqueue(btn, { autoplay: false });
    pump();
}

function downloadBubble(btn) {
    const url = btn?.dataset.audioUrl;
    if (!url) return;
    const link = document.createElement('a');
    const speaker = btn.dataset.voiceName || 'voice';
    link.href = url;
    link.download = `${speaker}.wav`;
    link.click();
}

function bindBubbleMenu() {
    const menu = document.createElement('div');
    menu.id = 'tad-bubble-menu';
    menu.hidden = true;
    const download = document.createElement('button');
    download.type = 'button';
    download.textContent = '下载语音';
    const reroll = document.createElement('button');
    reroll.type = 'button';
    reroll.textContent = '重新生成';
    menu.append(download, reroll);
    document.body.append(menu);

    let target = null;
    let press = null;
    let suppressUntil = 0;

    function closeMenu() {
        menu.hidden = true;
        target = null;
    }

    function openMenu(btn, x, y) {
        if (btn.dataset.status !== 'ready') return;
        target = btn;
        menu.hidden = false;
        const width = 140;
        const height = 72;
        menu.style.left = `${Math.max(8, Math.min(x + 8, window.innerWidth - width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(y + 8, window.innerHeight - height - 8))}px`;
    }

    download.addEventListener('click', (event) => {
        event.stopPropagation();
        downloadBubble(target);
        closeMenu();
    });
    reroll.addEventListener('click', (event) => {
        event.stopPropagation();
        const btn = target;
        closeMenu();
        if (btn && window.confirm('确定要重新生成这段语音吗？')) rerollBubble(btn);
    });
    document.addEventListener('click', (event) => {
        if (!menu.hidden && !menu.contains(event.target)) closeMenu();
    });
    document.addEventListener('contextmenu', (event) => {
        const btn = event.target.closest?.('.voice-bubble');
        if (!btn) return;
        event.preventDefault();
        openMenu(btn, event.clientX, event.clientY);
    });
    document.addEventListener('pointerdown', (event) => {
        const btn = event.target.closest?.('.voice-bubble');
        if (!btn || event.pointerType === 'mouse' || event.button !== 0 || btn.dataset.status !== 'ready') return;
        press = { id: event.pointerId, x: event.clientX, y: event.clientY, btn, triggered: false };
        press.timer = setTimeout(() => {
            if (!press) return;
            press.triggered = true;
            suppressUntil = Date.now() + 900;
            openMenu(press.btn, press.x, press.y);
        }, LONG_PRESS_MS);
    });
    document.addEventListener('pointermove', (event) => {
        if (!press || event.pointerId !== press.id) return;
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) {
            clearTimeout(press.timer);
            press = null;
        }
    });
    const endPress = () => {
        if (!press) return;
        clearTimeout(press.timer);
        if (press.triggered) suppressUntil = Date.now() + 900;
        press = null;
    };
    document.addEventListener('pointerup', endPress);
    document.addEventListener('pointercancel', endPress);

    document.addEventListener('click', (event) => {
        const btn = event.target.closest?.('.voice-bubble');
        if (!btn) return;
        if (Date.now() < suppressUntil) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (!enabled()) return;
        if (btn.classList.contains('playing')) {
            stopPlayback();
            return;
        }
        if (btn.dataset.status === 'ready') {
            if (!btn.dataset.audioUrl) {
                btn.dataset.status = 'error';
                btn.classList.remove('playing');
                return;
            }
            playBubble(btn);
            return;
        }
        if (btn.dataset.status !== 'waiting' && btn.dataset.status !== 'error') return;
        btn.dataset.status = 'waiting';
        btn.classList.remove('error');
        enqueue(btn, { autoplay: false });
        pump();
    });
}

function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scan(), 0);
}

function voiceHintText() {
    return voiceName || '未选文件时用服务自带 voice_03.wav';
}

function paintControls() {
    document.querySelectorAll('[data-tad="api"]').forEach((node) => {
        if (document.activeElement !== node) node.value = apiBase();
    });
    document.querySelectorAll('[data-tad="enabled"]').forEach((node) => {
        node.checked = enabled();
    });
    document.querySelectorAll('[data-tad="auto"]').forEach((node) => {
        node.checked = autoPlay();
    });
    document.querySelectorAll('[data-tad="inject"]').forEach((node) => {
        node.checked = injectEnabled();
    });
    document.querySelectorAll('[data-tad="voice-hint"]').forEach((node) => {
        node.textContent = voiceHintText();
    });
}

function commitSettings(patch) {
    const previous = apiBase();
    if (patch.api !== undefined) localStorage.setItem(STORAGE.api, patch.api.trim() || DEFAULT_API);
    if (patch.enabled !== undefined) localStorage.setItem(STORAGE.enabled, patch.enabled ? '1' : '0');
    if (patch.auto !== undefined) localStorage.setItem(STORAGE.auto, patch.auto ? '1' : '0');
    if (patch.inject !== undefined) localStorage.setItem(STORAGE.inject, patch.inject ? '1' : '0');
    applyDialoguePrompt();
    if (apiBase() !== previous && voiceName === 'voice_03.wav') {
        voiceBlob = null;
        voiceName = '';
    }
    if (patch.enabled === false) {
        stopPlayback();
    } else if (patch.enabled === true) {
        scan();
    }
    paintControls();
    if (patch.api !== undefined || patch.enabled !== undefined) refreshStatus();
}

async function refreshStatus() {
    const nodes = [...document.querySelectorAll('[data-tad="status"]')];
    nodes.forEach((node) => {
        node.className = 'tad-status';
        node.textContent = '检查中…';
    });
    document.querySelectorAll('[data-tad="voice-hint"]').forEach((node) => {
        node.textContent = voiceHintText();
    });
    let text = 'IndexTTS 未就绪';
    let ok = false;
    try {
        const response = await fetch(`${apiBase()}/api/v1/health`);
        if (!response.ok) throw new Error(String(response.status));
        text = 'IndexTTS 在线';
        ok = true;
    } catch { /* 面板上显示未就绪 */ }
    nodes.forEach((node) => {
        node.textContent = text;
        node.className = ok ? 'tad-status tad-status-ok' : 'tad-status tad-status-down';
    });
}

function appendSettingsFields(parent) {
    const status = document.createElement('div');
    status.className = 'tad-status';
    status.dataset.tad = 'status';
    status.textContent = '未检查';

    const apiLabel = document.createElement('label');
    apiLabel.className = 'tad-field';
    apiLabel.append(document.createTextNode('IndexTTS 地址'));
    const apiInput = document.createElement('input');
    apiInput.type = 'text';
    apiInput.className = 'text_pole';
    apiInput.dataset.tad = 'api';
    apiInput.value = apiBase();
    apiLabel.append(apiInput);

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'tad-check';
    check.textContent = '检查连接';

    const voiceLabel = document.createElement('label');
    voiceLabel.className = 'tad-field';
    voiceLabel.append(document.createTextNode('音色参考'));
    const voiceInput = document.createElement('input');
    voiceInput.type = 'file';
    voiceInput.accept = 'audio/*,.wav,.mp3,.flac,.ogg,.opus';
    voiceInput.dataset.tad = 'voice';
    voiceLabel.append(voiceInput);
    const voiceHint = document.createElement('div');
    voiceHint.className = 'tad-hint';
    voiceHint.dataset.tad = 'voice-hint';
    voiceHint.textContent = voiceHintText();

    const switches = document.createElement('div');
    switches.className = 'tad-switches';
    for (const [key, label] of [
        ['enabled', '启用'],
        ['auto', '新回复自动朗读'],
        ['inject', '注入对白格式'],
    ]) {
        const row = document.createElement('label');
        row.className = 'tad-switch';
        const text = document.createElement('span');
        text.textContent = label;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.tad = key;
        row.append(text, input);
        switches.append(row);
    }

    apiInput.addEventListener('change', () => commitSettings({ api: apiInput.value }));
    check.addEventListener('click', () => refreshStatus());
    voiceInput.addEventListener('change', () => {
        const file = voiceInput.files && voiceInput.files[0];
        if (!file) return;
        rememberVoice(file, file.name).then(() => paintControls());
    });
    switches.addEventListener('change', (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return;
        commitSettings({ [input.dataset.tad]: input.checked });
    });

    parent.append(status, apiLabel, check, voiceLabel, voiceHint, switches);
}

function openSheet() {
    const overlay = document.querySelector('#tad-overlay');
    if (!overlay) return;
    overlay.hidden = false;
    refreshStatus();
}

function closeSheet() {
    const overlay = document.querySelector('#tad-overlay');
    if (overlay) overlay.hidden = true;
}

function bindFab(fab) {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let moved = false;

    const saved = localStorage.getItem(STORAGE.fab);
    if (saved) {
        try {
            const pos = JSON.parse(saved);
            fab.style.left = `${pos.left}px`;
            fab.style.top = `${pos.top}px`;
            fab.style.right = 'auto';
        } catch { /* 坏掉的位置记录就用默认右上角 */ }
    }

    fab.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const rect = fab.getBoundingClientRect();
        startX = event.clientX;
        startY = event.clientY;
        originLeft = rect.left;
        originTop = rect.top;
        moved = false;
        fab.setPointerCapture(event.pointerId);
    });
    fab.addEventListener('pointermove', (event) => {
        if (!fab.hasPointerCapture(event.pointerId)) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 6) return;
        moved = true;
        const left = Math.max(8, Math.min(window.innerWidth - fab.offsetWidth - 8, originLeft + dx));
        const top = Math.max(8, Math.min(window.innerHeight - fab.offsetHeight - 8, originTop + dy));
        fab.style.left = `${left}px`;
        fab.style.top = `${top}px`;
        fab.style.right = 'auto';
    });
    fab.addEventListener('pointerup', (event) => {
        if (!fab.hasPointerCapture(event.pointerId)) return;
        fab.releasePointerCapture(event.pointerId);
        if (moved) {
            localStorage.setItem(STORAGE.fab, JSON.stringify({
                left: Number.parseFloat(fab.style.left),
                top: Number.parseFloat(fab.style.top),
            }));
            return;
        }
        openSheet();
    });
}

function buildShell() {
    if (document.querySelector('#tad-fab')) return;

    const fab = document.createElement('button');
    fab.id = 'tad-fab';
    fab.type = 'button';
    fab.textContent = 'TTS';
    fab.title = '语音设置';
    bindFab(fab);

    const overlay = document.createElement('div');
    overlay.id = 'tad-overlay';
    overlay.hidden = true;

    const sheet = document.createElement('div');
    sheet.id = 'tad-sheet';
    sheet.addEventListener('click', (event) => event.stopPropagation());

    const header = document.createElement('div');
    header.className = 'tad-sheet-header';
    const title = document.createElement('h3');
    title.textContent = '语音设置';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tad-close';
    close.textContent = '×';
    close.title = '关闭';
    close.addEventListener('click', closeSheet);
    header.append(title, close);

    const body = document.createElement('div');
    body.className = 'tad-sheet-body';
    appendSettingsFields(body);
    sheet.append(header, body);
    overlay.append(sheet);
    overlay.addEventListener('click', closeSheet);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeSheet();
    });

    document.body.append(fab, overlay);
    refreshStatus();
}

function mountExtensionSettings() {
    if (document.querySelector('#tad-settings')) return;
    const host = document.querySelector('#extensions_settings');
    if (!host) return;

    const drawer = document.createElement('div');
    drawer.id = 'tad-settings';
    drawer.className = 'inline-drawer';

    const toggle = document.createElement('div');
    toggle.className = 'inline-drawer-toggle inline-drawer-header';
    const name = document.createElement('b');
    name.textContent = 'TTS Afterdrought';
    const icon = document.createElement('div');
    icon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
    toggle.append(name, icon);

    const content = document.createElement('div');
    content.className = 'inline-drawer-content';
    const note = document.createElement('div');
    note.className = 'tad-hint';
    note.textContent = '和悬浮按钮打开的是同一组设置。';
    const fields = document.createElement('div');
    fields.className = 'tad-fields';
    appendSettingsFields(fields);
    content.append(note, fields);

    drawer.append(toggle, content);
    host.append(drawer);
    paintControls();
    refreshStatus();
}

function init() {
    applyDialoguePrompt();
    buildShell();
    mountExtensionSettings();
    if (event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, mountExtensionSettings);
    }
    bindBubbleMenu();
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scan();

    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, () => {
            streaming = false;
            speakableGeneration = true;
            const autoplay = autoPlay();
            playNewReply = autoplay;
            scan();
            lastMesText()?.querySelectorAll('.voice-bubble[data-settled="0"]').forEach((btn) => {
                btn.dataset.settled = '1';
            });
            scheduleLast(autoplay);
        });
    }
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, (type) => {
            streaming = type !== 'quiet';
            speakableGeneration = type !== 'quiet';
            applyDialoguePrompt();
        });
    }
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            streaming = false;
            stopPlayback();
            applyDialoguePrompt();
            scheduleScan();
        });
    }
    if (event_types.MESSAGE_DELETED) {
        eventSource.on(event_types.MESSAGE_DELETED, () => {
            stopPlayback();
            scheduleScan();
        });
    }
    console.log('[tts-afterdrought] 已加载');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
