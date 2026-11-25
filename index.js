import { eventSource, event_types, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';

const STORAGE = {
    api: 'tad_api',
    token: 'tad_token',
    auto: 'tad_auto',
    enabled: 'tad_enabled',
    inject: 'tad_inject',
    render: 'tad_render',
    settings: 'tad_settings',
    fab: 'tad_fab',
};

const PROMPT_KEY = 'tts-afterdrought-dialogue';
const LEGACY_API = 'http://127.0.0.1:7860';
const DEFAULT_API = 'http://127.0.0.1:9881';
const FALLBACK_EMOTIONS = ['平静', '日常', '自然', '温柔', '轻松', '开心', '高兴', '喜悦', '兴奋', '狂喜', '不满', '不悦', '恼火', '生气', '愤怒', '暴怒', '恼羞成怒', '气愤', '委屈地生气', '压抑怒火', '冷淡不满', '失落', '难过', '悲伤', '伤心', '低落', '沮丧', '绝望', '心碎', '悲伤地微笑', '强忍悲伤', '哽咽', '哭泣', '痛哭', '紧张', '不安', '担忧', '害怕', '恐惧', '惊恐', '慌张', '焦虑', '忐忑', '如释重负', '嫌弃', '厌恶', '反感', '鄙夷', '嫌弃地吐槽', '无奈', '惊讶', '震惊', '惊喜', '意外', '疑惑', '困惑', '难以置信', '恍然大悟', '害羞', '羞涩', '脸红', '不好意思', '羞恼', '撒娇', '依恋', '宠溺', '暧昧', '温存', '深情', '吃醋', '占有欲', '委屈撒娇', '期待', '眷恋', '调皮', '俏皮', '得意', '自信', '傲娇', '温柔地责备', '无可奈何', '苦笑', '自嘲', '认真', '严肃', '坚定', '疲惫', '困倦', '慵懒', '敷衍', '冷淡', '尴尬', '释然', '感动', '欣慰', '幸福', '温暖', '耳语'];
let emotionNames = FALLBACK_EMOTIONS.slice();
let gatewayCharacters = [];

const BARS_HTML = '<span class="sovits-voice-waves"><span class="sovits-voice-bar"></span><span class="sovits-voice-bar"></span><span class="sovits-voice-bar"></span></span>';
const BUBBLE_ROOTS = '.mes_text, .message-body, .markdown-content, #chat .mes_text, .mes .text';
const VOICE_NODE = '.tad-voice';
const INLINE_TAG = /^<\/?(?:em|strong|b|i|u|q|code|mark|small|sub|sup|font|span|a)\b[^>]*>/i;
const LONG_PRESS_MS = 550;
const SYSTEM_KEYWORDS = /^(?:ONSTAGE|RECALL|ARCHIVE|FLOOR|STATUS|SYS|VAR|STAGE|SYSTEM|CONFIG|DATA|MEMORY|DATABASE|DEBUG|INFO|ERROR|WARN|TAG|SETTING|VALUE|VARIABLE)$/i;

const REQUEST_TIMEOUT_MS = 120000;
const memory = new Map();
const pending = new Set();
const inflightRequests = new Map();
const genQueue = [];
const autoList = [];
let audio = null;
let playToken = 0;
let speechAbort = new AbortController();
let readingMes = null;
let draining = false;
let scanTimer = 0;
let pumping = false;
let playNewReply = false;
let streaming = false;
let refreshing = false;

function apiBase() {
    let stored = (localStorage.getItem(STORAGE.api) || '').trim();
    if (!stored || stored.replace(/\/+$/, '') === LEGACY_API) stored = DEFAULT_API;
    let base = stored.replace(/\/+$/, '').replace(/\/api\/v1$/, '').replace(/\/v1$/, '');
    try {
        const url = new URL(base);
        const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
        let path = url.pathname.replace(/\/+$/, '');
        if (local && path === '/tts') path = '';
        base = url.origin + path;
    } catch { /* 不是绝对地址就用整理过的字符串 */ }
    return base;
}

function apiHeaders(extra) {
    const headers = extra ? { ...extra } : {};
    const token = (localStorage.getItem(STORAGE.token) || '').trim();
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
}

function enabled() {
    return localStorage.getItem(STORAGE.enabled) !== '0';
}

function autoPlay() {
    return localStorage.getItem(STORAGE.auto) === '1';
}

function defaultSettings() {
    return {
        prompt: { enabled: true, depth: 1, role: 'system', content: '', builtin: true },
        playback: { scope: 'dialogue', compat: false, autoInfer: false, progressive: false, bufferSize: 5 },
        notify: { enabled: true, success: false, warning: true, error: true },
        regexFilters: [
            { enabled: true, regex: '/<think>[\\s\\S]*?<\\/think>\\n?/g', replacement: '' },
        ],
    };
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepDefaults(target, source) {
    if (!isPlainObject(target)) return JSON.parse(JSON.stringify(source));
    for (const key of Object.keys(source)) {
        if (!Object.prototype.hasOwnProperty.call(target, key)) {
            target[key] = JSON.parse(JSON.stringify(source[key]));
        } else if (isPlainObject(source[key]) && isPlainObject(target[key])) {
            deepDefaults(target[key], source[key]);
        }
    }
    return target;
}

function loadSettings() {
    const defaults = defaultSettings();
    let saved = {};
    try {
        saved = JSON.parse(localStorage.getItem(STORAGE.settings) || '{}');
    } catch { saved = {}; }
    const settings = deepDefaults(isPlainObject(saved) ? saved : {}, defaults);
    if (!localStorage.getItem(STORAGE.settings) && localStorage.getItem(STORAGE.inject) === '0') {
        settings.prompt.enabled = false;
    }
    settings.playback.bufferSize = Math.max(1, Math.min(20, Number(settings.playback.bufferSize) || 5));
    if (!Array.isArray(settings.regexFilters)) settings.regexFilters = defaults.regexFilters;
    return settings;
}

function saveSettings(settings) {
    localStorage.setItem(STORAGE.settings, JSON.stringify(settings));
}

function injectEnabled() {
    return loadSettings().prompt.enabled !== false;
}

function playbackSettings() {
    return loadSettings().playback;
}

function compatMode() {
    return playbackSettings().compat === true;
}

function fullScope() {
    return playbackSettings().scope === 'full';
}

function skipRewrite() {
    return compatMode();
}

function renderMode() {
    return localStorage.getItem(STORAGE.render) === 'line' ? 'line' : 'bubble';
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
    return emotionNames;
}

async function loadEmotionNames() {
    try {
        const response = await fetch(`${apiBase()}/v1/emotions`, { headers: apiHeaders() });
        if (!response.ok) return;
        const data = await response.json();
        if (Array.isArray(data.names) && data.names.length) {
            emotionNames = data.names;
            applyDialoguePrompt();
            paintControls();
        }
    } catch { /* 网关不在时继续用短列表 */ }
}

function characterRosterText() {
    if (!gatewayCharacters.length) {
        return '（角色表还没有读到。）';
    }
    const lines = gatewayCharacters.map((item) => {
        const name = String(item.display_name || item.character_id || '').trim();
        if (!name) return '';
        const aliases = (Array.isArray(item.aliases) ? item.aliases : [])
            .map((alias) => String(alias || '').trim())
            .filter((alias) => alias && alias !== name);
        return aliases.length ? `${name}（别名：${aliases.join('、')}）` : name;
    }).filter(Boolean);
    if (!lines.length) return '（角色表还没有读到。）';
    return lines.map((line) => `- ${line}`).join('\n');
}

function rosterSignature(list) {
    return list.map((item) => {
        const name = String(item.display_name || item.character_id || '').trim();
        const aliases = (Array.isArray(item.aliases) ? item.aliases : [])
            .map((alias) => String(alias || '').trim())
            .filter(Boolean)
            .join('\u0001');
        return `${name}\u0002${aliases}\u0002${item.version ?? ''}\u0002${item.voice_revision ?? ''}\u0002${item.synthesis_revision ?? ''}`;
    }).join('\n');
}

let characterLoad = null;

async function loadGatewayCharacters() {
    if (characterLoad) return characterLoad;
    characterLoad = (async () => {
        const response = await fetch(`${apiBase()}/v1/characters`, { headers: apiHeaders() });
        if (!response.ok) return false;
        const data = await response.json();
        if (!Array.isArray(data.characters)) return false;
        const next = data.characters.filter((item) => item && typeof item === 'object');
        const changed = rosterSignature(next) !== rosterSignature(gatewayCharacters);
        gatewayCharacters = next;
        releaseUnknownVoices();
        refreshVoiceKeys();
        if (changed) {
            applyDialoguePrompt();
            paintControls();
        }
        return changed;
    })().catch(() => false);
    try {
        return await characterLoad;
    } finally {
        characterLoad = null;
    }
}

function watchGatewayCharacters() {
    const pull = () => {
        if (document.visibilityState !== 'hidden') loadGatewayCharacters();
    };
    setInterval(pull, 3000);
    document.addEventListener('visibilitychange', pull);
}

function dialoguePrompt() {
    return `[对白语音标记]

所有角色真正说出口的对白都必须添加语音标记。旁白、动作、环境、心理活动保持普通正文，不添加标记。不要为了加标记而改剧情、对白或性格。

对白是角色说出口的话。旁白是动作、神态、环境和心理。情绪是这句话的情感。语气是怎么发声，例如轻声、缓慢、犹豫。情绪和语气必须分开写。

已注册角色，标记里必须用显示名：
${characterRosterText()}
1. 表里的人用显示名，不要用别名、昵称、简称或代词当标记里的名字。
2. 不在表里的人，按剧情写全名。不要只写姓、职位、称号或「他」「她」。
3. 同一个人全文只用这一个名字。旁白里可以自然用代词。
4. 角色名不能省略。逗号必须是英文逗号。

只有一种情绪时：
[角色名, 情绪] “对白内容”

[甘雨, 害羞] “你、你怎么突然说这种话……”
[甘雨, 平静] “今天的工作终于结束了。”

标记紧贴这句对白。对白可以单独成行，也可以和旁白写在同一段里，不必为了标记换行。引号用中文双引号，里面只能是说出口的话。不要把动作、心理或旁白放进引号，也不要接在标记后面。不要把多句独立对白并成一条标记。

同一句里情绪变了，整句只放进 segments，标记里不写情绪，外面不要再写对白或引号，也不要把旁白放进 segments：
[角色名] 〖vd:{"segments":[{"text":"第一段对白","emotion":"情绪","pause_after_ms":200},{"text":"第二段对白","emotion":"情绪"}]}〗

[甘雨] 〖vd:{"segments":[{"text":"诶？你怎么突然回来了……","emotion":"惊讶","pause_after_ms":200},{"text":"我、我只是刚好在这里休息而已。","emotion":"害羞"}]}〗

segments 按说话顺序，每段是一段连续对白，并各自写 emotion。只有情绪真的变了才分段。拿不准就保持整句，用普通格式。

情绪只能从这些词里选，不要自造、缩写或改写：${promptEmotionNames().join('、')}。听不出明显情绪时用平静，不要为了表现丰富而硬加情绪。
平静：有意识地保持平稳、克制。
日常：普通生活交流。
自然：轻松，不刻意表现情绪。

语气不是情绪。需要时才写 delivery，放在右引号前面：
[角色名, 情绪] “对白内容〖vd:{"delivery":{"intensity":"whisper","pace":"slow"}}〗”
intensity 是发声方式，不是音量数字。只能是 normal、gentle、soft、whisper、firm、cold、teasing、hesitant、excited、crying、laughing。
pace 只能是 fast、normal、gentle、slow。
没有特殊语气就不要写 delivery。不要把害羞、生气写进 intensity，也不要把 whisper、slow 写进 emotion。不要自造取值。

整句换情绪，又要统一语气时，delivery 写在导演块根上，作为整句默认。某一段要盖过它，才在那个 segment 里再写 delivery：
[甘雨] 〖vd:{"delivery":{"intensity":"soft","pace":"slow"},"segments":[{"text":"诶？你怎么突然回来了……","emotion":"惊讶","pause_after_ms":200},{"text":"我、我只是刚好在这里休息而已。","emotion":"害羞"}]}〗
[甘雨] 〖vd:{"segments":[{"text":"我真的没有生气。","emotion":"不满"},{"text":"只是……你下次不要这样突然离开。","emotion":"委屈","delivery":{"intensity":"hesitant","pace":"slow"}}]}〗
同一层不要写两个 delivery。

pause_after_ms 是这一段说完后的停顿，只在确实需要时写。短暂停顿 100–250，语气转折 250–450，明显停顿 450–800。不要每段都加，不要写负数或超过 800。最后一段通常不写。

JSON 使用双引号，不要尾随逗号。不要输出格式说明，不要用代码块包对白，正文里不要提到标记或导演块。

她把目光挪开，手指不自觉地整理了一下衣袖。
[甘雨, 害羞] “你、你怎么突然说这种话……”
她稍微停顿了一下，随后恢复了平日的语气。
[甘雨, 平静] “今天的工作终于结束了。”
甘雨轻轻点头，声音也放柔了些。
[甘雨, 温柔] “嗯，那我们走吧。”

同一段里也可以夹着旁白。每一句对白各自一个标记，中间的旁白保持普通正文：
[胡桃, 惊喜] “专程来找我的？”胡桃一把将两扇门板推得大敞，红褐色的双马尾随着她大幅度的转身晃晃悠悠。[胡桃] 〖vd:{"segments":[{"text":"快请进快请进！本堂主平时想拉甘雨姐姐喝杯粗茶比登天还难呢。","emotion":"调皮","pause_after_ms":280},{"text":"久旱对吧？能把这位加班狂人从文书堆里拐出来，你面子可真不小。","emotion":"得意"}]}〗`.trim();
}

function promptRole(role) {
    if (role === 'user') return extension_prompt_roles.USER;
    if (role === 'assistant') return extension_prompt_roles.ASSISTANT;
    return extension_prompt_roles.SYSTEM;
}

function activePrompt() {
    const prompt = loadSettings().prompt;
    if (prompt.builtin === false && String(prompt.content || '').trim()) {
        return String(prompt.content)
            .replaceAll('{{CHAR}}', currentCharacterName())
            .replaceAll('{{CHARACTERS}}', characterRosterText())
            .replaceAll('{{EMOTIONS}}', promptEmotionNames().join('、'));
    }
    return dialoguePrompt();
}

function applyDialoguePrompt() {
    const prompt = loadSettings().prompt;
    const text = prompt.enabled === false ? '' : activePrompt();
    const depth = Math.max(0, Number(prompt.depth) || 0);
    setExtensionPrompt(
        PROMPT_KEY,
        text,
        extension_prompt_types.IN_CHAT,
        depth,
        false,
        promptRole(prompt.role),
        () => speakableGeneration,
    );
}

function notify(level, message) {
    const config = loadSettings().notify;
    const category = level === 'info' ? 'success' : level;
    if (config.enabled === false || config[category] === false) return;
    const fn = globalThis.toastr?.[level];
    if (typeof fn === 'function') fn(message);
}

function parseRegexString(regexStr) {
    if (!regexStr || typeof regexStr !== 'string') return null;
    const trimmed = regexStr.trim();
    const match = trimmed.match(/^\/([\s\S]+)\/([gimsuy]*)$/);
    try {
        if (match) return new RegExp(match[1], match[2]);
        return new RegExp(trimmed, 'g');
    } catch {
        return null;
    }
}

function applyRegexFilters(text) {
    if (!text) return text;
    const filters = loadSettings().regexFilters;
    if (!Array.isArray(filters) || !filters.length) return text;
    let result = String(text);
    filters.forEach((filter, index) => {
        if (!filter || filter.enabled === false) return;
        const regex = parseRegexString(filter.regex);
        if (!regex) return;
        try {
            result = result.replace(regex, filter.replacement || '');
        } catch (error) {
            console.warn(`[tts-afterdrought] 正则 #${index + 1} 失败`, error);
        }
    });
    return result;
}

function splitSentences(text) {
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

function directorJson(fragment) {
    return String(fragment || '')
        .replace(/<q\b[^>]*>|<\/q>|<br\s*\/?>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;|&#0*34;/gi, '"')
        .replace(/&amp;/gi, '&');
}

function takeDirector(spoken) {
    const match = String(spoken || '').match(/〖vd:([\s\S]*?)〗/);
    if (!match) return { text: String(spoken || '').trim(), director: null };
    let director = null;
    try {
        const data = JSON.parse(directorJson(match[1]));
        if (data && typeof data === 'object' && !Array.isArray(data)) director = data;
    } catch { /* 导演指令不是合法 JSON 时丢掉，对白照常朗读 */ }
    return { text: String(spoken).replace(match[0], ' ').replace(/\s+/g, ' ').trim(), director };
}

function segmentText(director) {
    if (!director || !Array.isArray(director.segments)) return '';
    return director.segments.map((item) => (item && item.text) || '').join('').trim();
}

function gatewayCharacter(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    return gatewayCharacters.find((entry) => [entry.character_id, entry.display_name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]
        .some((part) => String(part || '').trim().toLowerCase() === key)) || null;
}

// 网关照它实际用的参考音频和推理配置给版本号。网关没给时退回角色配置的修改时间。
function voiceRevision(speaker) {
    const item = gatewayCharacter(speaker);
    if (!item) return '';
    const voice = item.voice_revision ?? item.version ?? '';
    const synthesis = item.synthesis_revision ?? '';
    return `${voice}\u0003${synthesis}`;
}

function bubbleKey(speaker, emotion, text, director = '') {
    return `${speaker}\n${emotion}\n${text}\n${director}\n${voiceRevision(speaker)}`;
}

function voiceAttrs(speaker, emotion, text, settled, director) {
    const directorText = director ? JSON.stringify(director) : '';
    const key = bubbleKey(speaker, emotion, text, directorText);
    const cached = memory.get(key) || '';
    const status = cached ? 'ready' : (pending.has(key) ? 'queued' : 'waiting');
    const loading = status === 'queued' ? ' loading' : '';
    const url = cached ? ` data-audio-url="${escapeHtmlAttr(cached)}"` : '';
    const settledAttr = settled ? '' : ' data-settled="0"';
    const directorAttr = directorText ? ` data-director="${escapeHtmlAttr(directorText)}"` : '';
    const attrs = ` data-status="${status}" data-key="${escapeHtmlAttr(key)}"${url} data-text="${escapeHtmlAttr(text)}" data-voice-name="${escapeHtmlAttr(speaker)}" data-voice-emotion="${escapeHtmlAttr(emotion)}"${settledAttr}${directorAttr}`;
    return { loading, attrs };
}

function buildBubbleHtml(speaker, emotion, text, settled = true, director = null) {
    const state = voiceAttrs(speaker, emotion, text, settled, director);
    const width = Math.min(220, 60 + Math.max(2, Math.ceil(text.length * 0.25)) * 10);
    const seconds = Math.max(2, Math.ceil(text.length * 0.25));
    return `<span class="voice-bubble tad-voice${state.loading}" style="width: ${width}px"${state.attrs}>${BARS_HTML}<span class="sovits-voice-duration">${seconds}&quot;</span></span>`;
}

function spokenColor(html) {
    return `<span class="tad-spoken">${html}</span>`;
}

function presentDialogue(text) {
    const value = String(text || '').trim();
    if (/^[「“"『]/.test(value)) return value;
    return `“${value}”`;
}

function buildLineHtml(speaker, emotion, text, settled = true, director = null) {
    const state = voiceAttrs(speaker, emotion, text, settled, director);
    const title = emotion && emotion !== 'default' ? `${speaker} · ${emotion}` : speaker;
    return `<span class="tad-line tad-voice${state.loading}"${state.attrs} title="${escapeHtmlAttr(title)}"><span class="tad-line-body">${escapeHtmlAttr(presentDialogue(text))}</span><span class="tad-line-mark">${BARS_HTML}</span></span>`;
}

function speakerKnown(name) {
    if (!gatewayCharacters.length) return true;
    return gatewayCharacter(name) !== null;
}

function keptHtml(speaker, text) {
    return `<span class="tad-kept">${escapeHtmlAttr(presentDialogue(text))}</span>`;
}

function keptFromNode(node) {
    if (node.classList.contains('tad-line')) {
        return node.querySelector('.tad-line-body')?.textContent || presentDialogue(node.dataset.text || '');
    }
    return presentDialogue(node.dataset.text || '');
}

function forgetVoice(key) {
    if (!key) return;
    pending.delete(key);
    const queued = genQueue.findIndex((item) => item.key === key);
    if (queued >= 0) genQueue.splice(queued, 1);
    const auto = autoList.indexOf(key);
    if (auto >= 0) autoList.splice(auto, 1);
}

function dropCachedAudio(key) {
    const url = memory.get(key);
    if (url) URL.revokeObjectURL(url);
    memory.delete(key);
    audioStore.delete(key);
    forgetVoice(key);
}

function refreshVoiceKeys() {
    document.querySelectorAll(`#chat ${VOICE_NODE}`).forEach((node) => {
        const next = bubbleKey(
            node.dataset.voiceName,
            node.dataset.voiceEmotion || 'default',
            node.dataset.text || '',
            node.dataset.director || '',
        );
        if (!node.dataset.key || node.dataset.key === next) return;
        dropCachedAudio(node.dataset.key);
        node.dataset.key = next;
        node.dataset.status = 'waiting';
        node.removeAttribute('data-audio-url');
        node.classList.remove('loading', 'playing', 'error');
    });
}

function releaseVoiceNode(node) {
    const plain = document.createElement('span');
    plain.className = 'tad-kept';
    plain.textContent = keptFromNode(node);
    forgetVoice(node.dataset.key);
    node.replaceWith(plain);
}

function releaseVoice(key) {
    bubblesByKey(key).forEach(releaseVoiceNode);
}

function releaseUnknownVoices() {
    if (!gatewayCharacters.length) return;
    document.querySelectorAll(`#chat ${VOICE_NODE}`).forEach((node) => {
        if (!speakerKnown(node.dataset.voiceName)) releaseVoiceNode(node);
    });
}

class SkipVoice extends Error {}

function buildVoiceHtml(speaker, emotion, text, settled = true, director = null) {
    if (gatewayCharacters.length && !speakerKnown(speaker)) return keptHtml(speaker, text);
    if (renderMode() === 'line') return buildLineHtml(speaker, emotion, text, settled, director);
    return buildBubbleHtml(speaker, emotion, text, settled, director);
}

function lineEnded(rest) {
    return /[\n\r]/.test(rest) || /[\[【]/.test(rest) || /<br\b/i.test(rest);
}

function decodeBasicEntities(value) {
    return String(value)
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
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

function extractSpoken(source, tagEnd) {
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
        return { spoken, settled: closed || !replyStreaming(), end: i };
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
    return { spoken, settled: !replyStreaming() || lineEnded(source.slice(i)), end: i };
}

function maskVoiceWidgets(html) {
    const placeholders = [];
    let out = '';
    let i = 0;
    while (i < html.length) {
        const start = html.indexOf('<span', i);
        if (start === -1) {
            out += html.slice(i);
            break;
        }
        const tagEnd = html.indexOf('>', start);
        if (tagEnd === -1) {
            out += html.slice(i);
            break;
        }
        const open = html.slice(start, tagEnd + 1);
        if (!/\bclass="[^"]*\b(?:tad-voice|voice-bubble|tad-line)\b/.test(open)) {
            out += html.slice(i, tagEnd + 1);
            i = tagEnd + 1;
            continue;
        }
        out += html.slice(i, start);
        let depth = 1;
        let j = tagEnd + 1;
        while (j < html.length && depth > 0) {
            const nextOpen = html.indexOf('<span', j);
            const nextClose = html.indexOf('</span>', j);
            if (nextClose === -1) {
                j = html.length;
                break;
            }
            if (nextOpen !== -1 && nextOpen < nextClose) {
                depth += 1;
                const nextEnd = html.indexOf('>', nextOpen);
                j = nextEnd === -1 ? nextOpen + 5 : nextEnd + 1;
            } else {
                depth -= 1;
                j = nextClose + 7;
            }
        }
        placeholders.push(html.slice(start, j));
        out += `\u0000tad${placeholders.length - 1}\u0000`;
        i = j;
    }
    return { html: out, placeholders };
}

function restoreVoiceWidgets(html, placeholders) {
    if (!placeholders.length) return html;
    return html.replace(/\u0000tad(\d+)\u0000/g, (token, index) => placeholders[Number(index)] ?? token);
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

function segmentEmotion(director) {
    const item = director.segments.find((part) => part && part.emotion != null && part.emotion !== '');
    const emotion = item && item.emotion;
    if (typeof emotion === 'string' && emotion.trim()) return emotion.trim();
    if (emotion && typeof emotion === 'object') {
        const preset = emotion.preset || emotion.name;
        if (preset) return String(preset).trim();
    }
    return 'default';
}

function renderDialogueHtml(html) {
    let source = applyRegexFilters(html).replace(/[\[【]([^\],:【】\[\]\n]{1,30})\s*[,，]\s*(?:New|new)[\]】]/g, (match, speaker) => {
        const name = speaker.trim();
        if (!name || /^\d+$/.test(name) || SYSTEM_KEYWORDS.test(name)) return match;
        return `[${name}, default]`;
    });

    const lineMode = renderMode() === 'line';
    let result = '';
    let lastIndex = 0;
    let searchFrom = 0;
    let matched = false;
    while (searchFrom < source.length) {
        const emotionRe = /[\[【]([^\],:【】\[\]\n]{1,30})\s*[,，]\s*([^\]】\n]{1,30})[\]】]/g;
        emotionRe.lastIndex = searchFrom;
        const emotionMatch = emotionRe.exec(source);
        const bareRe = /[\[【]([^\],:【】\[\]\n]{1,30})[\]】]/g;
        bareRe.lastIndex = searchFrom;
        let bareMatch = null;
        let segment = null;
        while ((bareMatch = bareRe.exec(source)) !== null) {
            segment = readSegmentDirector(source, bareMatch.index + bareMatch[0].length);
            if (segment) break;
        }
        const emotionAt = emotionMatch ? emotionMatch.index : Infinity;
        const bareAt = segment && bareMatch ? bareMatch.index : Infinity;
        if (emotionAt === Infinity && bareAt === Infinity) break;

        if (bareAt < emotionAt) {
            const speaker = bareMatch[1].trim();
            const tagEnd = bareMatch.index + bareMatch[0].length;
            if (!speaker || SYSTEM_KEYWORDS.test(speaker) || /^\d+$/.test(speaker) || speaker.toLowerCase().startsWith('tts')) {
                searchFrom = tagEnd;
                continue;
            }
            matched = true;
            result += source.slice(lastIndex, bareMatch.index);
            lastIndex = segment.end;
            searchFrom = segment.end;
            if (lineMode) {
                result += buildVoiceHtml(speaker, segmentEmotion(segment.director), segment.text, segment.settled, segment.director);
            } else {
                result += spokenColor(escapeHtmlAttr(presentDialogue(segment.text)));
                if (!gatewayCharacters.length || speakerKnown(speaker)) {
                    result += ' ' + buildBubbleHtml(speaker, segmentEmotion(segment.director), segment.text, segment.settled, segment.director);
                }
            }
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
            searchFrom = tagEnd;
            continue;
        }
        const spoken = extractSpoken(source, tagEnd);
        if (!spoken) {
            searchFrom = tagEnd;
            continue;
        }
        const directed = takeDirector(spoken.spoken);
        const display = directed.text || segmentText(directed.director);
        if (!display) {
            searchFrom = tagEnd;
            continue;
        }
        matched = true;
        result += source.slice(lastIndex, emotionMatch.index);
        if (lineMode) {
            lastIndex = spoken.end;
            searchFrom = lastIndex;
            result += buildVoiceHtml(speaker, emotion || 'default', display, spoken.settled, directed.director);
        } else {
            const visible = source.slice(tagEnd, spoken.end)
                .replace(/〖vd:[\s\S]*?〗/g, '')
                .replace(/^(?:\s|&nbsp;)*/, '')
                .replace(/^<q\b[^>]*>/i, '')
                .replace(/<\/q\s*>$/i, '');
            result += spokenColor(visible);
            if (!gatewayCharacters.length || speakerKnown(speaker)) {
                result += ' ' + buildBubbleHtml(speaker, emotion || 'default', display, spoken.settled, directed.director);
            }
            lastIndex = spoken.end;
            searchFrom = lastIndex;
        }
    }
    const tagged = matched ? result + source.slice(lastIndex) : source;
    return tagged.replace(/(\s*)\[TTSVoice[:：]\s*([^:：]+)\s*[:：]\s*([^:：]*)\s*[:：]\s*(.*?)\]/gi, (full, space, name, emotion, text) => {
        const directed = takeDirector(visibleText(text));
        const display = directed.text || segmentText(directed.director);
        if (!display) return full;
        return `${space || ''}${buildVoiceHtml(name.trim(), emotion.trim() || 'default', display, true, directed.director)}`;
    });
}

function parseTextToBubbles(html) {
    const masked = maskVoiceWidgets(html);
    const next = restoreVoiceWidgets(renderDialogueHtml(masked.html), masked.placeholders);
    return next === html ? html : next;
}

const audioStore = {
    db: null,
    opening: null,
    open() {
        if (this.db) return Promise.resolve(this.db);
        if (this.opening) return this.opening;
        this.opening = new Promise((resolve) => {
            if (!globalThis.indexedDB) {
                resolve(null);
                return;
            }
            const request = indexedDB.open('AfterDroughtTTS', 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('audios')) db.createObjectStore('audios', { keyPath: 'key' });
                if (!db.objectStoreNames.contains('configs')) db.createObjectStore('configs');
            };
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };
            request.onerror = () => resolve(null);
        });
        return this.opening;
    },
    async run(storeName, mode, fn) {
        const db = await this.open();
        if (!db) return null;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const result = fn(tx.objectStore(storeName));
            tx.oncomplete = () => resolve(result?.result ?? result ?? null);
            tx.onerror = () => reject(tx.error);
        });
    },
    async get(key) {
        const db = await this.open();
        if (!db) return null;
        return new Promise((resolve) => {
            const tx = db.transaction('audios', 'readonly');
            const request = tx.objectStore('audios').get(key);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => resolve(null);
        });
    },
    async put(record) {
        const db = await this.open();
        if (!db) return;
        await new Promise((resolve, reject) => {
            const tx = db.transaction('audios', 'readwrite');
            tx.objectStore('audios').put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },
    async delete(key) {
        const db = await this.open();
        if (!db) return;
        await new Promise((resolve) => {
            const tx = db.transaction('audios', 'readwrite');
            tx.objectStore('audios').delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    },
    async all() {
        const db = await this.open();
        if (!db) return [];
        return new Promise((resolve) => {
            const tx = db.transaction('audios', 'readonly');
            const request = tx.objectStore('audios').getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => resolve([]);
        });
    },
    async clear() {
        const db = await this.open();
        if (!db) return;
        await new Promise((resolve) => {
            const tx = db.transaction('audios', 'readwrite');
            tx.objectStore('audios').clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    },
    async getConfig(key) {
        const db = await this.open();
        if (!db) return null;
        return new Promise((resolve) => {
            const tx = db.transaction('configs', 'readonly');
            const request = tx.objectStore('configs').get(key);
            request.onsuccess = () => resolve(request.result ?? null);
            request.onerror = () => resolve(null);
        });
    },
    async setConfig(key, value) {
        const db = await this.open();
        if (!db) return;
        await new Promise((resolve) => {
            const tx = db.transaction('configs', 'readwrite');
            tx.objectStore('configs').put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    },
};

let folderHandle = null;

// 浏览器断开只是停止等待，网关那边的任务要单独撤回。
function cancelRemote(requestIds) {
    const ids = requestIds.filter(Boolean);
    if (!ids.length) return;
    fetch(`${apiBase()}/v1/tts/cancel`, {
        method: 'POST',
        headers: apiHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ request_ids: ids, session_id: sessionId() }),
        keepalive: true,
    }).catch(() => { /* 旧版网关没有取消接口时忽略 */ });
}

function stopPlayback() {
    const stale = [...inflightRequests.values()];
    inflightRequests.clear();
    playToken += 1;
    readingMes = null;
    speechAbort.abort();
    speechAbort = new AbortController();
    genQueue.splice(0, genQueue.length);
    pending.clear();
    autoList.splice(0, autoList.length);
    if (audio) {
        audio.pause();
        audio = null;
    }
    document.querySelectorAll(VOICE_NODE).forEach((node) => {
        node.classList.remove('playing', 'loading');
        delete node.dataset.autoplay;
        if (node.dataset.status === 'generating' || node.dataset.status === 'queued') {
            node.dataset.status = 'waiting';
        }
    });
    cancelRemote(stale);
}

function sessionId() {
    try {
        const context = globalThis.SillyTavern?.getContext?.() || {};
        return String(context.chatId || context.chat_id || context.groupId || 'st-session');
    } catch {
        return 'st-session';
    }
}

async function fetchAudio(segment) {
    const signal = speechAbort.signal;
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    if (!segment.fresh && memory.has(segment.key)) return memory.get(segment.key);
    const requestId = segment.fresh ? `${segment.key}:${Date.now()}` : `${sessionId()}:${segment.key}`;
    const controller = new AbortController();
    const relay = () => controller.abort();
    let timedOut = false;
    signal.addEventListener('abort', relay);
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, REQUEST_TIMEOUT_MS);
    inflightRequests.set(segment.key, requestId);
    try {
        return await requestAudio(segment, requestId, controller.signal);
    } catch (error) {
        if (timedOut) {
            cancelRemote([requestId]);
            throw new Error(`语音网关 ${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒没有返回`);
        }
        if (error?.name === 'AbortError') throw new DOMException('已取消', 'AbortError');
        throw error;
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', relay);
        if (inflightRequests.get(segment.key) === requestId) inflightRequests.delete(segment.key);
    }
}

async function requestAudio(segment, requestId, signal) {
    const preset = segment.emotion && segment.emotion !== 'default' ? segment.emotion : null;
    const body = {
        request_id: requestId,
        session_id: sessionId(),
        character_id: segment.speaker,
        emotion: { type: 'vector', preset, vector: null, weight: null },
        output: { format: 'wav', sample_rate: 24000, fresh: !!segment.fresh },
    };
    if (segment.director && Array.isArray(segment.director.segments) && segment.director.segments.length) {
        body.segments = segment.director.segments;
    } else {
        body.text = segment.text;
    }
    if (segment.director && segment.director.delivery && typeof segment.director.delivery === 'object') {
        body.delivery = segment.director.delivery;
    }
    if (segment.director && segment.director.emotion && typeof segment.director.emotion === 'object') {
        body.emotion = segment.director.emotion;
    }
    let response;
    try {
        response = await fetch(`${apiBase()}/v1/tts`, {
            method: 'POST',
            headers: apiHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify(body),
            signal,
        });
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw new Error('语音网关未就绪');
    }
    const skipHeader = response.headers.get('x-tts-skip');
    const type = response.headers.get('content-type') || '';
    if (response.ok && (skipHeader === 'missing_character' || type.includes('json'))) {
        const data = await response.json().catch(() => ({}));
        if (data && data.skip === 'missing_character') throw new SkipVoice(data.detail || '未找到角色');
        throw new Error((data && (data.detail || data.error)) || '语音生成失败');
    }
    if (!response.ok) {
        let detail = `语音生成失败 (${response.status})`;
        try {
            const data = await response.json();
            const message = data.detail || data.error;
            if (typeof message === 'string') detail = message;
        } catch { /* 非 JSON 错误体 */ }
        if (response.status === 404 && detail.startsWith('未找到角色')) throw new SkipVoice(detail);
        throw new Error(detail);
    }
    const blob = await response.blob();
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    const url = URL.createObjectURL(blob);
    memory.set(segment.key, url);
    audioStore.put({
        key: segment.key,
        blob,
        speaker: segment.speaker,
        emotion: segment.emotion || 'default',
        text: segment.text,
        timestamp: Date.now(),
    }).catch(() => { /* 缓存写失败不影响这次播放 */ });
    refreshCacheCount();
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
        next.onpause = finish;
        next.onerror = finish;
        next.play().catch(finish);
    });
}

function bubblesByKey(key) {
    return [...document.querySelectorAll(`#chat ${VOICE_NODE}`)].filter((btn) => btn.dataset.key === key);
}

function segmentFromButton(btn, autoplay) {
    let director = null;
    if (btn.dataset.director) {
        try { director = JSON.parse(btn.dataset.director); } catch { director = null; }
    }
    return {
        key: btn.dataset.key,
        speaker: btn.dataset.voiceName,
        emotion: btn.dataset.voiceEmotion || 'default',
        text: btn.dataset.text,
        director,
        fresh: btn.dataset.fresh === '1',
        autoplay: !!autoplay,
    };
}

function markReady(key, url) {
    bubblesByKey(key).forEach((node) => {
        node.dataset.status = 'ready';
        node.dataset.audioUrl = url;
        node.classList.remove('loading', 'error');
        delete node.dataset.fresh;
    });
}

function markQueued(key) {
    bubblesByKey(key).forEach((node) => {
        node.dataset.status = 'queued';
        node.classList.add('loading');
        node.classList.remove('error');
    });
}

function enqueue(btn, { autoplay = false } = {}) {
    if (!btn || (btn.dataset.status !== 'waiting' && btn.dataset.status !== 'error')) return;
    if (autoplay) btn.dataset.autoplay = '1';
    btn.dataset.status = 'waiting';
    enqueueSegment(segmentFromButton(btn, autoplay || btn.dataset.autoplay === '1'));
}

function enqueueSegment(segment) {
    const key = segment?.key;
    if (!key || speechAbort.signal.aborted) return;
    const generation = speechAbort.signal;
    if (segment.autoplay && !autoList.includes(key)) autoList.push(key);
    if (!segment.fresh && memory.has(key)) {
        markReady(key, memory.get(key));
        considerDrain();
        return;
    }
    if (pending.has(key)) {
        markQueued(key);
        return;
    }
    pending.add(key);
    markQueued(key);
    genQueue.push(segment);
    if (!segment.fresh) {
        audioStore.get(key).then((record) => {
            if (generation.aborted || !record?.blob || !pending.has(key)) return;
            const index = genQueue.findIndex((item) => item.key === key);
            if (index >= 0) genQueue.splice(index, 1);
            const url = URL.createObjectURL(record.blob);
            memory.set(key, url);
            pending.delete(key);
            markReady(key, url);
            considerDrain();
        }).catch(() => { /* 没有持久缓存就继续向网关请求 */ });
    }
    pump();
}

async function playBubble(btn) {
    const url = btn?.dataset.audioUrl || memory.get(btn?.dataset.key);
    if (!url) return;
    const token = ++playToken;
    autoList.splice(0, autoList.length);
    const same = bubblesByKey(btn.dataset.key);
    document.querySelectorAll(`${VOICE_NODE}.playing`).forEach((node) => node.classList.remove('playing'));
    same.forEach((node) => node.classList.add('playing'));
    await playUrl(url);
    if (token === playToken) same.forEach((node) => node.classList.remove('playing'));
}

function considerDrain() {
    if (draining) return;
    const playback = playbackSettings();
    const buffer = Math.max(1, Math.min(20, Number(playback.bufferSize) || 1));
    while (autoList.length && !memory.has(autoList[0]) && !pending.has(autoList[0]) && !genQueue.some((item) => item.key === autoList[0])) {
        autoList.shift();
    }
    let ready = 0;
    for (const key of autoList) {
        if (!memory.has(key)) break;
        ready += 1;
    }
    const busy = pumping || genQueue.length > 0 || pending.size > 0;
    if (!ready) return;
    if (playback.progressive) {
        if (ready < buffer && busy) return;
    } else if (busy) {
        return;
    }
    drainAutoplay();
}

async function drainAutoplay() {
    if (draining) return;
    draining = true;
    const token = playToken;
    try {
        while (autoList.length && token === playToken) {
            const key = autoList[0];
            if (!memory.has(key)) {
                if (pending.has(key) || genQueue.some((item) => item.key === key)) {
                    await new Promise((resolve) => setTimeout(resolve, 200));
                    continue;
                }
                autoList.shift();
                continue;
            }
            autoList.shift();
            const same = bubblesByKey(key);
            document.querySelectorAll(`${VOICE_NODE}.playing`).forEach((node) => node.classList.remove('playing'));
            same.forEach((node) => node.classList.add('playing'));
            await playUrl(memory.get(key));
            if (token === playToken) same.forEach((node) => node.classList.remove('playing'));
        }
    } finally {
        draining = false;
        if (autoList.length && token === playToken) considerDrain();
        else if (token === playToken) readingMes = null;
    }
}

async function pump() {
    if (pumping) return;
    pumping = true;
    try {
        while (genQueue.length) {
            const segment = genQueue.shift();
            const key = segment?.key;
            if (!key) continue;
            if (memory.has(key) && !segment.fresh) {
                pending.delete(key);
                markReady(key, memory.get(key));
                continue;
            }
            try {
                bubblesByKey(key).forEach((node) => {
                    node.dataset.status = 'generating';
                    node.classList.add('loading');
                });
                const url = await fetchAudio(segment);
                markReady(key, url);
            } catch (error) {
                if (error?.name === 'AbortError') continue;
                if (error instanceof SkipVoice) {
                    releaseVoice(key);
                    continue;
                }
                const message = error.message || String(error);
                bubblesByKey(key).forEach((node) => {
                    node.dataset.status = 'error';
                    node.classList.remove('loading');
                    node.classList.add('error');
                    node.title = message;
                });
                notify('error', message);
            } finally {
                pending.delete(key);
                considerDrain();
            }
        }
    } finally {
        pumping = false;
        considerDrain();
        if (genQueue.length) pump();
    }
}

function lastMesText() {
    const nodes = document.querySelectorAll('.mes_text');
    return nodes.length ? nodes[nodes.length - 1] : null;
}

function segmentsFromPlain(text) {
    const escaped = applyRegexFilters(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
    const holder = document.createElement('div');
    holder.innerHTML = parseTextToBubbles(escaped);
    return [...holder.querySelectorAll(VOICE_NODE)].map((node) => {
        let director = null;
        if (node.dataset.director) {
            try { director = JSON.parse(node.dataset.director); } catch { director = null; }
        }
        return {
            key: node.dataset.key,
            speaker: node.dataset.voiceName,
            emotion: node.dataset.voiceEmotion || 'default',
            text: node.dataset.text,
            director,
            fresh: false,
            autoplay: false,
        };
    });
}

function markupToSpeech(text) {
    let source = applyRegexFilters(String(text || ''))
        .replace(/<(tucao|advice|think)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    source = source.replace(/[\[【][^\],:【】\[\]\n]{1,30}[\]】]\s*〖vd:([\s\S]*?)〗/g, (_, json) => {
        try {
            return segmentText(JSON.parse(json));
        } catch {
            return '';
        }
    });
    source = source.replace(/[\[【][^\],:【】\[\]\n]{1,30}\s*[,，]\s*[^\]】\n]{1,40}[\]】]\s*([“"「『][^”"」』]*[”"」』])/g, '$1');
    source = source.replace(/〖vd:[\s\S]*?〗/g, '');
    source = source.replace(/[\[【][^\],:【】\[\]\n]{1,30}(?:\s*[,，]\s*[^\]】\n]{1,40})?[\]】]/g, '');
    return source;
}

function fullSegments(text, speaker) {
    return splitSentences(markupToSpeech(text)).map((line) => ({
        key: bubbleKey(speaker, 'default', line, ''),
        speaker,
        emotion: 'default',
        text: line,
        director: null,
        fresh: false,
        autoplay: false,
    }));
}

function queueMessage(mes, autoplay, full = false) {
    if (!mes || mes.getAttribute('is_user') === 'true') return;
    stopPlayback();
    const id = Number(mes.getAttribute('mesid'));
    const entry = chatContext()?.chat?.[id];
    const raw = typeof entry?.mes === 'string' ? entry.mes : (mes.querySelector('.mes_text')?.innerText || '');
    const speaker = String(entry?.name || currentCharacterName() || '').trim();
    if (!speaker || (gatewayCharacters.length && !speakerKnown(speaker))) {
        notify('warning', speaker ? `${speaker} 没有配音` : '没有可朗读的内容');
        return;
    }
    const segments = (full || fullScope()) ? fullSegments(raw, speaker) : segmentsFromPlain(raw);
    if (!segments.length) {
        notify('warning', '没有可朗读的内容');
        return;
    }
    readingMes = mes;
    segments.forEach((segment) => enqueueSegment({ ...segment, autoplay: !!autoplay }));
}

function queueLastMessage(autoplay) {
    const mes = [...document.querySelectorAll('#chat .mes')].pop();
    queueMessage(mes, autoplay, fullScope());
}

function mountFullButtons() {
    document.querySelectorAll('#chat .mes').forEach((mes) => {
        const existing = mes.querySelector('.tad-full-play');
        if (!fullScope() || mes.getAttribute('is_user') === 'true') {
            existing?.remove();
            return;
        }
        const row = mes.querySelector('.mes_buttons');
        if (!row || existing) return;
        const btn = document.createElement('div');
        btn.className = 'mes_button tad-full-play';
        btn.title = '朗读这条消息';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-volume-high';
        btn.append(icon);
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (readingMes === mes) {
                stopPlayback();
                return;
            }
            queueMessage(mes, true, true);
        });
        row.append(btn);
    });
}

function scheduleLast(autoplay) {
    const last = lastMesText();
    if (!last) return;
    last.querySelectorAll(VOICE_NODE).forEach((btn) => {
        if (btn.dataset.settled === '0') return;
        if (autoplay && btn.dataset.status !== 'ready' && btn.dataset.status !== 'error') btn.dataset.autoplay = '1';
        if (btn.dataset.status === 'waiting') enqueue(btn, { autoplay });
    });
    pump();
}

function scan() {
    mountFullButtons();
    if (!enabled() || skipRewrite()) return;
    let changed = false;
    document.querySelectorAll(BUBBLE_ROOTS).forEach((node) => {
        if (!node.isConnected || node.closest(VOICE_NODE) || node.querySelector?.('#curEditTextarea')) return;
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
    const key = btn.dataset.key;
    memory.delete(key);
    audioStore.delete(key);
    bubblesByKey(key).forEach((node) => {
        node.dataset.status = 'waiting';
        node.removeAttribute('data-audio-url');
        node.classList.remove('loading', 'playing', 'error');
    });
    btn.dataset.fresh = '1';
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
        const btn = event.target.closest?.(VOICE_NODE);
        if (!btn) return;
        event.preventDefault();
        openMenu(btn, event.clientX, event.clientY);
    });
    document.addEventListener('pointerdown', (event) => {
        const btn = event.target.closest?.(VOICE_NODE);
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
        const btn = event.target.closest?.(VOICE_NODE);
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

function chatContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch {
        return null;
    }
}

function refreshRenderedMessages() {
    if (refreshing) return;
    refreshing = true;
    try {
        const ctx = chatContext();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : null;
        if (chat && typeof ctx.messageFormatting === 'function') {
            document.querySelectorAll('#chat .mes').forEach((mes) => {
                const text = mes.querySelector('.mes_text');
                const id = Number(mes.getAttribute('mesid'));
                const entry = chat[id];
                if (!text || text.tagName !== 'DIV' || text.querySelector('#curEditTextarea')) return;
                if (!entry || typeof entry.mes !== 'string') return;
                try {
                    text.innerHTML = ctx.messageFormatting(
                        entry.mes,
                        entry.name || '',
                        !!entry.is_system,
                        !!entry.is_user,
                        id,
                        {},
                        false,
                    );
                } catch { /* 这条还原失败就留着现有正文 */ }
            });
        }
        scan();
    } finally {
        refreshing = false;
    }
}

function scheduleScan() {
    if (refreshing) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scan(), 0);
}

function paintControls() {
    const settings = loadSettings();
    const setValue = (name, value) => {
        document.querySelectorAll(`[data-tad="${name}"]`).forEach((node) => {
            if (document.activeElement === node) return;
            if (node.type === 'checkbox') node.checked = !!value;
            else node.value = value;
        });
    };
    setValue('api', apiBase());
    setValue('token', localStorage.getItem(STORAGE.token) || '');
    setValue('enabled', enabled());
    setValue('auto', autoPlay());
    setValue('render', renderMode());
    setValue('prompt-enabled', settings.prompt.enabled !== false);
    setValue('prompt-depth', settings.prompt.depth ?? 1);
    setValue('prompt-role', settings.prompt.role || 'system');
    setValue('prompt-content', settings.prompt.builtin === false ? (settings.prompt.content || '') : dialoguePrompt());
    setValue('scope', settings.playback.scope === 'full' ? 'full' : 'dialogue');
    setValue('compat', settings.playback.compat === true);
    setValue('auto-infer', settings.playback.autoInfer === true);
    setValue('progressive', settings.playback.progressive === true);
    setValue('buffer', settings.playback.bufferSize || 5);
    setValue('notify-enabled', settings.notify.enabled !== false);
    setValue('notify-success', settings.notify.success === true);
    setValue('notify-warning', settings.notify.warning !== false);
    setValue('notify-error', settings.notify.error !== false);
    document.querySelectorAll('[data-tad="buffer"]').forEach((node) => {
        node.disabled = settings.playback.progressive !== true;
    });
    document.querySelectorAll('[data-tad="prompt-state"]').forEach((node) => {
        node.textContent = settings.prompt.builtin === false
            ? '正在使用你改过的提示词。{{CHAR}} 会换成当前角色名，{{CHARACTERS}} 会换成网关角色表，{{EMOTIONS}} 会换成情绪列表。'
            : '正在使用内置对白格式。改动文本后，下一次生成改用你写的版本。';
    });
    document.querySelectorAll('[data-tad="cache-path"]').forEach((node) => {
        node.value = folderHandle?.name || '未选择目录';
    });
}

function commitSettings(patch) {
    const settings = loadSettings();
    let refreshView = false;
    if (patch.api !== undefined) localStorage.setItem(STORAGE.api, patch.api.trim() || DEFAULT_API);
    if (patch.token !== undefined) localStorage.setItem(STORAGE.token, patch.token.trim());
    if (patch.enabled !== undefined) localStorage.setItem(STORAGE.enabled, patch.enabled ? '1' : '0');
    if (patch.auto !== undefined) localStorage.setItem(STORAGE.auto, patch.auto ? '1' : '0');
    if (patch.render !== undefined) localStorage.setItem(STORAGE.render, patch.render === 'line' ? 'line' : 'bubble');
    if (patch.prompt) {
        if (patch.prompt.builtin === true) {
            settings.prompt.builtin = true;
            settings.prompt.content = '';
            delete patch.prompt.content;
            delete patch.prompt.builtin;
        }
        Object.assign(settings.prompt, patch.prompt);
    }
    if (patch.playback) {
        Object.assign(settings.playback, patch.playback);
        settings.playback.bufferSize = Math.max(1, Math.min(20, Number(settings.playback.bufferSize) || 5));
        if (patch.playback.compat !== undefined || patch.playback.scope !== undefined) refreshView = true;
    }
    if (patch.notify) Object.assign(settings.notify, patch.notify);
    if (patch.regexFilters) {
        settings.regexFilters = patch.regexFilters;
        refreshView = true;
    }
    if (patch.prompt || patch.playback || patch.notify || patch.regexFilters) saveSettings(settings);
    applyDialoguePrompt();
    if (patch.enabled === false || patch.render !== undefined || refreshView) stopPlayback();
    if (patch.enabled === true && !skipRewrite()) scan();
    else if (patch.playback) mountFullButtons();
    paintControls();
    if (patch.regexFilters) renderRegexLists();
    if (patch.render !== undefined || refreshView) refreshRenderedMessages();
    if (patch.api !== undefined) loadEmotionNames();
    if (patch.api !== undefined || patch.enabled !== undefined) refreshStatus();
}

function updateFilter(index, patch) {
    const filters = loadSettings().regexFilters.map((item, itemIndex) => (
        itemIndex === index ? { ...item, ...patch } : item
    ));
    commitSettings({ regexFilters: filters });
}

function renderRegexLists(root = document) {
    const filters = loadSettings().regexFilters;
    root.querySelectorAll('[data-tad="regex-list"]').forEach((list) => {
        list.replaceChildren();
        if (!filters.length) {
            const empty = document.createElement('div');
            empty.className = 'tad-hint';
            empty.textContent = '暂无过滤规则';
            list.append(empty);
            return;
        }
        filters.forEach((filter, index) => {
            const row = document.createElement('div');
            row.className = 'tad-regex';
            const head = document.createElement('div');
            head.className = 'tad-regex-head';
            const label = document.createElement('label');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = filter.enabled !== false;
            label.append(box, document.createTextNode(` 启用 #${index + 1}`));
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'tad-mini';
            del.textContent = '删除';
            head.append(label, del);
            const pattern = document.createElement('input');
            pattern.className = 'text_pole';
            pattern.value = filter.regex || '';
            pattern.placeholder = '/<think>[\\s\\S]*?<\\/think>/g';
            const replacement = document.createElement('input');
            replacement.className = 'text_pole';
            replacement.value = filter.replacement || '';
            replacement.placeholder = '留空表示删掉匹配内容';
            row.append(head, pattern, replacement);
            box.addEventListener('change', () => updateFilter(index, { enabled: box.checked }));
            pattern.addEventListener('change', () => updateFilter(index, { regex: pattern.value }));
            replacement.addEventListener('change', () => updateFilter(index, { replacement: replacement.value }));
            del.addEventListener('click', () => {
                commitSettings({ regexFilters: loadSettings().regexFilters.filter((_, itemIndex) => itemIndex !== index) });
            });
            list.append(row);
        });
    });
}

function cacheNote(text, level = 'success') {
    document.querySelectorAll('[data-tad="cache-note"]').forEach((node) => {
        node.textContent = text;
    });
    notify(level, text);
}

async function refreshCacheCount() {
    const list = await audioStore.all();
    document.querySelectorAll('[data-tad="cache-count"]').forEach((node) => {
        node.textContent = String(list.length);
    });
}

async function restoreFolder() {
    folderHandle = await audioStore.getConfig('folder');
    paintControls();
}

async function chooseFolder() {
    if (typeof window.showDirectoryPicker !== 'function') {
        cacheNote('当前浏览器不能选择本地目录', 'error');
        return;
    }
    try {
        folderHandle = await window.showDirectoryPicker();
        await audioStore.setConfig('folder', folderHandle);
        paintControls();
        cacheNote(`已选定目录 ${folderHandle.name}`);
    } catch (error) {
        if (error?.name !== 'AbortError') cacheNote('没有选到目录', 'error');
    }
}

async function ensureFolderPermission() {
    if (!folderHandle?.queryPermission) return false;
    const mode = { mode: 'readwrite' };
    if (await folderHandle.queryPermission(mode) === 'granted') return true;
    return await folderHandle.requestPermission(mode) === 'granted';
}

function safeFilePart(value) {
    return String(value || 'voice').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 40) || 'voice';
}

async function shortHash(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return [...new Uint8Array(digest)].slice(0, 4).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function exportCache() {
    if (!folderHandle) {
        cacheNote('先选择一个本地目录', 'warning');
        return;
    }
    if (!await ensureFolderPermission()) {
        cacheNote('没有读写这个目录的权限', 'error');
        return;
    }
    try {
    const items = await audioStore.all();
    const manifest = [];
    for (const item of items) {
        if (!item?.blob || !item.key) continue;
        const file = `${safeFilePart(item.speaker)}_${safeFilePart(item.text)}_${await shortHash(item.key)}.wav`;
        const handle = await folderHandle.getFileHandle(file, { create: true });
        const writable = await handle.createWritable();
        await writable.write(item.blob);
        await writable.close();
        manifest.push({
            key: item.key,
            speaker: item.speaker,
            emotion: item.emotion,
            text: item.text,
            file,
        });
    }
    const manifestHandle = await folderHandle.getFileHandle('afterdrought-tts.json', { create: true });
    const writable = await manifestHandle.createWritable();
    await writable.write(JSON.stringify({ version: 1, items: manifest }, null, 2));
    await writable.close();
    cacheNote(`已导出 ${manifest.length} 条语音`);
    } catch (error) {
        cacheNote(error?.message || '导出失败', 'error');
    }
}

async function importCache() {
    if (!folderHandle) {
        cacheNote('先选择一个本地目录', 'warning');
        return;
    }
    if (!await ensureFolderPermission()) {
        cacheNote('没有读写这个目录的权限', 'error');
        return;
    }
    try {
    let imported = 0;
    const seen = new Set();
    try {
        const manifestHandle = await folderHandle.getFileHandle('afterdrought-tts.json');
        const manifestFile = await manifestHandle.getFile();
        const manifest = JSON.parse(await manifestFile.text());
        for (const item of manifest.items || []) {
            if (!item?.file || !item.key) continue;
            const handle = await folderHandle.getFileHandle(item.file);
            const file = await handle.getFile();
            await audioStore.put({
                key: item.key,
                blob: file,
                speaker: item.speaker,
                emotion: item.emotion || 'default',
                text: item.text,
                timestamp: Date.now(),
            });
            seen.add(item.file);
            imported += 1;
        }
    } catch { /* 没有清单时继续按文件名导入 */ }
    const nameRe = /^\[(.*?)\]_(.+)_([a-f0-9]{6,})\.(wav|mp3|ogg)$/i;
    for await (const [name, handle] of folderHandle.entries()) {
        if (handle.kind !== 'file' || seen.has(name) || !nameRe.test(name)) continue;
        const match = name.match(nameRe);
        const speaker = match[1].trim() || 'Imported';
        const text = match[2].trim();
        const file = await handle.getFile();
        await audioStore.put({
            key: bubbleKey(speaker, 'default', text, ''),
            blob: file,
            speaker,
            emotion: 'default',
            text,
            timestamp: Date.now(),
        });
        imported += 1;
    }
    await refreshCacheCount();
    cacheNote(imported ? `已导入 ${imported} 条语音` : '目录里没有可导入的语音', imported ? 'success' : 'warning');
    } catch (error) {
        cacheNote(error?.message || '导入失败', 'error');
    }
}

async function clearAudioCache() {
    if (!window.confirm('确定清空本机缓存的语音吗？')) return;
    await audioStore.clear();
    for (const url of memory.values()) URL.revokeObjectURL(url);
    memory.clear();
    await refreshCacheCount();
    cacheNote('语音缓存已清空');
}

async function refreshStatus() {
    const nodes = [...document.querySelectorAll('[data-tad="status"]')];
    nodes.forEach((node) => {
        node.className = 'tad-status';
        node.textContent = '检查中…';
    });
    let text = '语音网关未就绪';
    let ok = false;
    try {
        const response = await fetch(`${apiBase()}/health`, { headers: apiHeaders() });
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.json().catch(() => ({}));
        if (data.studio && data.studio.online === false) {
            text = '网关在线，7860 未就绪';
        } else {
            text = '语音网关在线';
            ok = true;
        }
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
    apiLabel.append(document.createTextNode('语音网关'));
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

    const hint = document.createElement('div');
    hint.className = 'tad-hint';
    hint.textContent = '音色在网关的角色配置里。对白标记里的角色名用来选择音色，这里不再上传参考音频。';

    const tokenLabel = document.createElement('label');
    tokenLabel.className = 'tad-field';
    tokenLabel.append(document.createTextNode('口令'));
    const tokenInput = document.createElement('input');
    tokenInput.type = 'password';
    tokenInput.className = 'text_pole';
    tokenInput.dataset.tad = 'token';
    tokenInput.autocomplete = 'off';
    tokenLabel.append(tokenInput);

    apiInput.addEventListener('change', () => commitSettings({ api: apiInput.value }));
    tokenInput.addEventListener('change', () => commitSettings({ token: tokenInput.value }));
    check.addEventListener('click', () => refreshStatus());

    hint.textContent = '本机填 http://127.0.0.1:9881，口令留空。公网填 https://zzzbzhang.top/tts，口令填代理的 PROXY_TOKEN。';
    check.classList.add('tad-primary');

    const booth = document.createElement('div');
    booth.className = 'tad-booth';
    booth.append(status, apiLabel, tokenLabel, check, hint);

    const desk = document.createElement('div');
    desk.className = 'tad-desk';
    const index = document.createElement('div');
    index.className = 'tad-index';
    index.setAttribute('role', 'tablist');
    index.setAttribute('aria-label', '设置分类');
    for (const [id, label] of SETTINGS_TABS) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'tad-index-btn';
        tab.dataset.tadTab = id;
        tab.setAttribute('role', 'tab');
        tab.textContent = label;
        tab.addEventListener('click', () => showSettingsTab(id));
        index.append(tab);
    }
    index.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowDown' || event.key === 'ArrowRight'
            ? 1
            : (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0);
        if (!step) return;
        event.preventDefault();
        const ids = SETTINGS_TABS.map(([id]) => id);
        const next = ids[(ids.indexOf(settingsTab) + step + ids.length) % ids.length];
        showSettingsTab(next);
        index.querySelector(`[data-tad-tab="${next}"]`)?.focus();
    });
    const panels = document.createElement('div');
    panels.className = 'tad-panels';
    panels.append(playbackModule(), promptModule(), notifyModule(), cacheModule(), regexModule());
    desk.append(index, panels);

    parent.append(booth, desk);
    paintControls();
    renderRegexLists(parent);
    showSettingsTab(settingsTab);
}

const SETTINGS_TABS = [
    ['play', '播放'],
    ['prompt', '提示词'],
    ['notify', '通知'],
    ['cache', '缓存'],
    ['filter', '过滤'],
];
let settingsTab = 'play';

function showSettingsTab(tab) {
    settingsTab = SETTINGS_TABS.some(([id]) => id === tab) ? tab : 'play';
    document.querySelectorAll('[data-tad-tab]').forEach((node) => {
        const on = node.dataset.tadTab === settingsTab;
        node.classList.toggle('is-on', on);
        node.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('[data-tad-panel]').forEach((node) => {
        node.classList.toggle('is-on', node.dataset.tadPanel === settingsTab);
    });
}

function moduleBox(title, tab) {
    const box = document.createElement('section');
    box.className = 'tad-module';
    box.dataset.tadPanel = tab;
    const heading = document.createElement('h4');
    heading.className = 'tad-module-title';
    heading.textContent = title;
    box.append(heading);
    return box;
}

function switchRow(label, name) {
    const row = document.createElement('label');
    row.className = 'tad-switch';
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.tad = name;
    row.append(text, input);
    return row;
}

function selectField(label, name, options) {
    const field = document.createElement('label');
    field.className = 'tad-field';
    field.append(document.createTextNode(label));
    const select = document.createElement('select');
    select.className = 'text_pole';
    select.dataset.tad = name;
    for (const [value, text] of options) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        select.append(option);
    }
    field.append(select);
    return field;
}

function playbackModule() {
    const box = moduleBox('播放与自动化', 'play');
    const switches = document.createElement('div');
    switches.className = 'tad-switches';
    switches.append(
        switchRow('启用', 'enabled'),
        switchRow('新回复自动朗读', 'auto'),
        switchRow('回复后自动合成', 'auto-infer'),
        switchRow('边生成边播放', 'progressive'),
        switchRow('前端卡兼容', 'compat'),
    );
    const render = selectField('渲染', 'render', [['bubble', '气泡'], ['line', '台词']]);
    const scope = selectField('朗读范围', 'scope', [['dialogue', '对白'], ['full', '全文']]);
    const bufferLabel = document.createElement('label');
    bufferLabel.className = 'tad-field';
    bufferLabel.append(document.createTextNode('起播缓冲句数'));
    const buffer = document.createElement('input');
    buffer.type = 'number';
    buffer.min = '1';
    buffer.max = '20';
    buffer.className = 'text_pole';
    buffer.dataset.tad = 'buffer';
    bufferLabel.append(buffer);
    const note = document.createElement('div');
    note.className = 'tad-hint';
    note.textContent = '全文同样渲染对白，朗读时按整条消息逐句读，用消息上的喇叭重听。前端卡兼容不改写正文。自动合成只生成，自动朗读会按缓冲句数开播。';
    switches.addEventListener('change', (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement)) return;
        const map = {
            enabled: () => commitSettings({ enabled: input.checked }),
            auto: () => commitSettings({ auto: input.checked }),
            'auto-infer': () => commitSettings({ playback: { autoInfer: input.checked } }),
            progressive: () => commitSettings({ playback: { progressive: input.checked } }),
            compat: () => commitSettings({ playback: { compat: input.checked } }),
        };
        map[input.dataset.tad]?.();
    });
    render.querySelector('select').addEventListener('change', (event) => commitSettings({ render: event.target.value }));
    scope.querySelector('select').addEventListener('change', (event) => commitSettings({ playback: { scope: event.target.value } }));
    buffer.addEventListener('change', () => commitSettings({ playback: { bufferSize: Number(buffer.value) || 5 } }));
    box.append(switches, render, scope, bufferLabel, note);
    return box;
}

function promptModule() {
    const box = moduleBox('提示词管理', 'prompt');
    const switches = document.createElement('div');
    switches.className = 'tad-switches';
    switches.append(switchRow('启用提示词', 'prompt-enabled'));
    const depthLabel = document.createElement('label');
    depthLabel.className = 'tad-field';
    depthLabel.append(document.createTextNode('注入深度'));
    const depth = document.createElement('input');
    depth.type = 'number';
    depth.min = '0';
    depth.className = 'text_pole';
    depth.dataset.tad = 'prompt-depth';
    depthLabel.append(depth);
    const role = selectField('注入角色', 'prompt-role', [['system', 'System'], ['user', 'User'], ['assistant', 'Assistant']]);
    const content = document.createElement('textarea');
    content.className = 'text_pole tad-prompt';
    content.rows = 8;
    content.dataset.tad = 'prompt-content';
    const state = document.createElement('div');
    state.className = 'tad-hint';
    state.dataset.tad = 'prompt-state';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'tad-check tad-primary';
    reset.textContent = '恢复默认提示词';
    switches.addEventListener('change', (event) => {
        if (event.target instanceof HTMLInputElement) commitSettings({ prompt: { enabled: event.target.checked } });
    });
    depth.addEventListener('change', () => commitSettings({ prompt: { depth: Math.max(0, Number(depth.value) || 0) } }));
    role.querySelector('select').addEventListener('change', (event) => commitSettings({ prompt: { role: event.target.value } }));
    content.addEventListener('change', () => {
        const builtin = content.value.trim() === dialoguePrompt().trim();
        commitSettings({ prompt: builtin ? { builtin: true, content: '' } : { builtin: false, content: content.value } });
    });
    reset.addEventListener('click', () => commitSettings({ prompt: { builtin: true, content: '' } }));
    box.append(switches, depthLabel, role, content, state, reset);
    return box;
}

function notifyModule() {
    const box = moduleBox('酒馆通知', 'notify');
    const switches = document.createElement('div');
    switches.className = 'tad-switches';
    switches.append(
        switchRow('启用本扩展通知', 'notify-enabled'),
        switchRow('绿色成功与普通信息', 'notify-success'),
        switchRow('黄色警告', 'notify-warning'),
        switchRow('红色错误', 'notify-error'),
    );
    const note = document.createElement('div');
    note.className = 'tad-hint';
    note.textContent = '只影响这个扩展弹出的酒馆通知。';
    switches.addEventListener('change', (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement)) return;
        const field = {
            'notify-enabled': 'enabled',
            'notify-success': 'success',
            'notify-warning': 'warning',
            'notify-error': 'error',
        }[input.dataset.tad];
        if (field) commitSettings({ notify: { [field]: input.checked } });
    });
    box.append(switches, note);
    return box;
}

function cacheModule() {
    const box = moduleBox('音频缓存', 'cache');
    const count = document.createElement('div');
    count.className = 'tad-hint';
    const countValue = document.createElement('span');
    countValue.dataset.tad = 'cache-count';
    countValue.textContent = '0';
    count.append(document.createTextNode('已缓存 '), countValue, document.createTextNode(' 条'));
    const path = document.createElement('input');
    path.className = 'text_pole';
    path.readOnly = true;
    path.dataset.tad = 'cache-path';
    const row = document.createElement('div');
    row.className = 'tad-actions';
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'tad-check';
    choose.textContent = '选择目录';
    const scan = document.createElement('button');
    scan.type = 'button';
    scan.className = 'tad-check';
    scan.textContent = '扫描导入';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'tad-check';
    save.textContent = '导出备份';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'tad-check';
    clear.textContent = '清空缓存';
    row.append(choose, scan, save, clear);
    const note = document.createElement('div');
    note.className = 'tad-hint';
    note.dataset.tad = 'cache-note';
    note.textContent = '同一句对白会先用这里的缓存，没有再向网关请求。';
    choose.addEventListener('click', () => chooseFolder());
    scan.addEventListener('click', () => importCache());
    save.addEventListener('click', () => exportCache());
    clear.addEventListener('click', () => clearAudioCache());
    box.append(count, path, row, note);
    return box;
}

function regexModule() {
    const box = moduleBox('正则过滤', 'filter');
    const note = document.createElement('div');
    note.className = 'tad-hint';
    note.textContent = '抽对白之前按顺序替换。默认会去掉 think 块。';
    const list = document.createElement('div');
    list.dataset.tad = 'regex-list';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'tad-check';
    add.textContent = '新建规则';
    add.addEventListener('click', () => {
        const filters = loadSettings().regexFilters.slice();
        filters.push({ enabled: true, regex: '', replacement: '' });
        commitSettings({ regexFilters: filters });
    });
    box.append(note, list, add);
    return box;
}

function openSheet() {
    const overlay = document.querySelector('#tad-overlay');
    if (!overlay) return;
    overlay.hidden = false;
    refreshStatus();
    refreshCacheCount();
    renderRegexLists();
    loadGatewayCharacters();
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
    if ((localStorage.getItem(STORAGE.api) || '').replace(/\/+$/, '') === LEGACY_API) {
        localStorage.setItem(STORAGE.api, DEFAULT_API);
    }
    applyDialoguePrompt();
    loadEmotionNames();
    loadGatewayCharacters();
    watchGatewayCharacters();
    restoreFolder();
    refreshCacheCount();
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
            if (compatMode()) {
                if (autoplay || playbackSettings().autoInfer) queueLastMessage(autoplay);
            } else {
                playNewReply = fullScope() ? false : autoplay;
                scan();
                lastMesText()?.querySelectorAll(`${VOICE_NODE}[data-settled="0"]`).forEach((btn) => {
                    btn.dataset.settled = '1';
                });
                if (fullScope()) {
                    if (autoplay || playbackSettings().autoInfer) queueLastMessage(autoplay);
                } else {
                    scheduleLast(autoplay);
                }
            }
        });
    }
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, async (type) => {
            streaming = type !== 'quiet';
            speakableGeneration = type !== 'quiet';
            await loadGatewayCharacters();
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
