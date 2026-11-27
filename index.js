import { eventSource, event_types, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';
import { compileFormat, DEFAULT_VOICE_FORMAT, formatProblem, parseDialogueLines, splitSentences, voiceEffect } from './tad/parse.js';
import { markLine, unmark, waveMarks } from './tad/mark.js';
import { VoiceEngine, joinBlobs } from './tad/audio.js';
import { audioStore } from './tad/store.js';

const STORAGE = {
    api: 'tad_api',
    token: 'tad_token',
    auto: 'tad_auto',
    enabled: 'tad_enabled',
    inject: 'tad_inject',
    render: 'tad_render',
    settings: 'tad_settings',
    fab: 'tad_fab',
    fabShow: 'tad_fab_show',
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
const LONG_PRESS_MS = 550;

const REQUEST_TIMEOUT_MS = 120000;
const memory = new Map();
const pending = new Set();
const inflightRequests = new Map();
const genQueue = [];
const autoList = [];
const playedKeys = new Set();
const voiceEngine = new VoiceEngine();
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
let queueWaiters = [];

// 合成队列以前靠每 200ms 轮询等下一句。改成「状态变了就唤醒」，省掉白等。
function notifyQueueChange() {
    const waiters = queueWaiters;
    queueWaiters = [];
    waiters.forEach((resolve) => resolve());
}

function waitQueueChange() {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            resolve();
        };
        queueWaiters.push(finish);
        setTimeout(finish, 1500);
    });
}

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

function fabEnabled() {
    return localStorage.getItem(STORAGE.fabShow) !== '0';
}

// 悬浮窗只是入口，关掉之后设置还能从酒馆的扩展面板打开。
function applyFabVisibility() {
    const fab = document.querySelector('#tad-fab');
    if (fab) fab.hidden = !fabEnabled();
}

function autoPlay() {
    return localStorage.getItem(STORAGE.auto) === '1';
}

function defaultSettings() {
    return {
        version: 2,
        prompt: { enabled: true, depth: 1, role: 'system', content: '', builtin: true, format: DEFAULT_VOICE_FORMAT },
        playback: { scope: 'dialogue', compat: false, autoInfer: false, progressive: false, bufferSize: 5, volume: 1, rate: 1, follow: true, sfx: true },
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

// 设置以前每次调用都 JSON.parse 一遍，被正则、渲染、播放的热路径反复调用。
// 现在只在内存里留一份，写入时同步失效，读到的永远是同一个对象。
let settingsCache = null;

function loadSettings() {
    if (settingsCache) return settingsCache;
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
    settings.playback.volume = Math.max(0, Math.min(1, Number(settings.playback.volume)));
    if (Number.isNaN(settings.playback.volume)) settings.playback.volume = 1;
    settings.playback.rate = Math.max(0.5, Math.min(2, Number(settings.playback.rate) || 1));
    settings.playback.follow = settings.playback.follow !== false;
    settings.playback.sfx = settings.playback.sfx !== false;
    if (!Array.isArray(settings.regexFilters)) settings.regexFilters = defaults.regexFilters;
    // 存坏了就退回默认模板，不然提示词、解析、渲染三边对不上。
    const storedFormat = String(settings.prompt.format || '').trim();
    settings.prompt.format = storedFormat && !formatProblem(storedFormat) ? storedFormat : DEFAULT_VOICE_FORMAT;
    settings.version = 2;
    settingsCache = settings;
    return settings;
}

function saveSettings(settings) {
    settings.version = 2;
    settingsCache = settings;
    localStorage.setItem(STORAGE.settings, JSON.stringify(settings));
}

function resetSettingsCache() {
    settingsCache = null;
}

function playbackSettings() {
    return loadSettings().playback;
}

function compatMode() {
    return playbackSettings().compat === true;
}

function effectsEnabled() {
    return playbackSettings().sfx !== false;
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

const EMOTION_CACHE_KEY = 'tad_emotions_v1';

async function loadEmotionNames() {
    // 情绪表很少变，本地存一小时，省掉每次进酒馆的一次请求。
    try {
        const cached = JSON.parse(localStorage.getItem(EMOTION_CACHE_KEY) || 'null');
        if (cached && Array.isArray(cached.names) && cached.names.length && Date.now() - cached.at < 3600000) {
            emotionNames = cached.names;
            return;
        }
    } catch { /* 缓存坏了就当没有 */ }
    try {
        const response = await fetch(`${apiBase()}/v1/emotions`, { headers: apiHeaders() });
        if (!response.ok) return;
        const data = await response.json();
        if (Array.isArray(data.names) && data.names.length) {
            emotionNames = data.names;
            try {
                localStorage.setItem(EMOTION_CACHE_KEY, JSON.stringify({ at: Date.now(), names: data.names }));
            } catch { /* 存不下就每次重新取 */ }
            applyDialoguePrompt();
            paintControls();
        }
    } catch { /* 网关不在时继续用短列表 */ }
}

function rosterNames(item) {
    // 第三方网关只回 name 也认，不然整个角色表读出来是空的，气泡全被判成陌生角色。
    const name = String(item.display_name || item.character_id || item.name || '').trim();
    const aliases = (Array.isArray(item.aliases) ? item.aliases : [])
        .map((alias) => String(alias || '').trim())
        .filter((alias) => alias && alias !== name);
    return { name, aliases };
}

function rosterLabel(item) {
    const { name, aliases } = rosterNames(item);
    if (!name) return '';
    return aliases.length ? `${name}（${aliases.join('、')}）` : name;
}

// 最近几条消息的正文和说话人，用来判断谁在这段剧情里露过面。
function sceneChatText() {
    const ctx = chatContext();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    if (!chat.length) return '';
    return chat.slice(-6).map((entry) => `${entry?.name || ''}\n${entry?.mes || ''}`).join('\n');
}

function characterRosterText() {
    if (!gatewayCharacters.length) {
        return '（角色表还没有读到。）';
    }
    const labels = gatewayCharacters.map(rosterLabel).filter(Boolean);
    if (!labels.length) return '（角色表还没有读到。）';
    // 只发这段剧情里露过面的人：大世界卡的角色表很长，没出场的人写进去既费 token，
    // 又会让模型以为他们就在场。一个都认不出来（新聊天、或还叫别的名字）就退回完整表。
    const scene = sceneChatText();
    let names = labels;
    if (scene) {
        const seen = gatewayCharacters.filter((item) => {
            const { name, aliases } = rosterNames(item);
            if (name && scene.includes(name)) return true;
            return aliases.some((alias) => scene.includes(alias));
        }).map(rosterLabel).filter(Boolean);
        if (seen.length) {
            // 当前角色这几条里可能只用了代词，也一并列上。
            const active = canonicalSpeaker(currentCharacterName());
            const entry = gatewayCharacters.find((item) => rosterNames(item).name === active);
            const label = entry ? rosterLabel(entry) : '';
            if (label && !seen.includes(label)) seen.push(label);
            names = seen;
        }
    }
    // 逐条 "- 名字" 换成一行分号分隔，语义不变，注入长度大约省一半。
    return names.join('；');
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

let characterLoadError = false;
let characterPollTimer = 0;

async function loadGatewayCharacters() {
    if (characterLoad) return characterLoad;
    characterLoad = (async () => {
        const response = await fetch(`${apiBase()}/v1/characters`, {
            headers: apiHeaders(),
            cache: 'no-store',
        });
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.json();
        if (!Array.isArray(data.characters)) throw new Error('bad roster');
        characterLoadError = false;
        const next = data.characters.filter((item) => item && typeof item === 'object');
        const changed = rosterSignature(next) !== rosterSignature(gatewayCharacters);
        gatewayCharacters = next;
        // 角色表没变就别碰 DOM。以前轮询每 3 秒把所有气泡重新算一遍缓存键。
        if (changed) {
            refreshVoiceKeys();
            applyDialoguePrompt();
            paintControls();
        }
        return changed;
    })().catch(() => {
        characterLoadError = true;
        return false;
    });
    try {
        return await characterLoad;
    } finally {
        characterLoad = null;
    }
}

function watchGatewayCharacters() {
    let delay = 3000;
    const schedule = (wait) => {
        clearTimeout(characterPollTimer);
        characterPollTimer = setTimeout(pull, wait);
    };
    async function pull() {
        if (!enabled() || document.visibilityState === 'hidden') {
            schedule(3000);
            return;
        }
        await loadGatewayCharacters();
        // 网关没响应就逐步退到 30 秒，恢复后回到 3 秒，别在白屏/断网时空转。
        delay = characterLoadError ? Math.min(30000, Math.max(3000, delay * 2)) : 3000;
        schedule(delay);
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            delay = 3000;
            schedule(0);
        }
    });
    schedule(delay);
}

// 台词格式：提示词、解析、渲染共用同一条模板（见 tad/parse.js 的 compileFormat）。
function voiceFormat() {
    const stored = String(loadSettings().prompt.format || '').trim();
    return stored && !formatProblem(stored) ? stored : DEFAULT_VOICE_FORMAT;
}

/** 把占位符换成示例值，提示词里的例子就不用手写三遍格式。 */
function formatExample(format, values) {
    return format.replace(/\{(译文|角色|情绪|文本)\}/g, (match, field) => (
        values[field] === undefined ? match : String(values[field])
    ));
}

function dialoguePrompt() {
    const format = compileFormat(voiceFormat());
    if (format.free) return freeDialoguePrompt(format);
    const say = (role, emotion, text, translation = text) => formatExample(format.source, {
        译文: translation, 角色: role, 情绪: emotion, 文本: text,
    });
    // 四种写错的例子是按默认模板写的，换了模板就不再举例，免得教错。
    const mistakes = format.standard ? `
最常见的四种写错，照右边的样子改：
错误：“我其实一直……”<tts>甘雨|平静|……想跟你说。</tts>前半句只放译文、后半句只放标签，读者看不到全句，念出来也是断的；正确：“我其实一直……想跟你说。”<tts>甘雨|难过|我其实一直……想跟你说。</tts>
错误：“嗯。”“好的。”<tts>甘雨|温柔|嗯。好的。</tts>两句独立对白并成一组；正确：“嗯。”<tts>甘雨|平静|嗯。</tts>“好的。”<tts>甘雨|温柔|好的。</tts>
错误：她低下头。<tts>甘雨|害羞|“你回来了。”她低下头，把杯子往前推了推。</tts>旁白进了标签会被当成台词念；正确：“你回来了。”<tts>甘雨|害羞|你回来了。</tts>她低下头，把杯子往前推了推。
错误：“你回来了。<tts>甘雨|害羞|你回来了。</tts>译文的引号没闭合，标签前后对不上；正确：“你回来了。”<tts>甘雨|害羞|你回来了。</tts>
` : '';
    return `[对白语音标记]

所有角色真正说出口的对白都必须写成这一完整格式：
${format.source}

「译文」是正文里读者看到的那句，紧贴在标签前面；标签里依次写角色、情绪、文本，字段之间用英文竖线 | 分隔，必须完整闭合。旁白、动作、环境、未说出口的心理活动保持普通正文，不加标签。不要为了加标签而改剧情、对白或性格。

中文台词（最容易出错）：译文和文本是同一整句话，把整句完整写两遍，两边一字不差。绝不能把一句话拆成两半——前半句放译文里、后半句只放标签里——那样读者只看得到前半句，念出来也是断的。以前那种 [角色, 情绪] “台词” 不用了。

下面这些最容易漏，也都算说出口的对白：一两个字的短答（“嗯。”“好。”）、感叹和喊叫、打断别人、一口气连着说的几句、被旁白隔开的后半截。一段回复里，一句说出口的话都不能漏。

对白是角色说出口的话。旁白是动作、神态、环境和心理。情绪是这句话的情感，只能从下面的词表里挑一个。

已注册角色，标签里必须用显示名：
${characterRosterText()}
1. 表里的人用显示名，不要用别名、昵称、简称或代词当名字。
2. 不在表里的人，按剧情写全名。不要只写姓、职位、称号或「他」「她」。
3. 同一个人全文只用这一个名字。旁白里可以自然用代词。
4. 角色名不能省略，也不能写成 {角色} 之类的占位符。字段之间只用英文竖线 |。

一条标签只对应一个说话者的同一段连续发言、一个情绪。换说话者、中间插进旁白、或者情绪变了，就另起一组（再写一条译文加一个标签）。不要把多个人的发言塞进同一个标签，也不要把两句独立对白并成一组：

${say('甘雨', '惊讶', '诶？你怎么突然回来了……')}${say('甘雨', '害羞', '我、我只是刚好在这里休息而已。')}

一组里译文和文本都写完整，标签两侧各留空一格也不影响，但不要在标签外面再重复一遍这句台词。

长台词要拆开写：一口气超过四十来字，就按句号、问号、感叹号或逗号拆成两三组，每组各自写完整译文和标签，念的时候会自然接上。例如：
“我知道你现在很难受，可是我们总得想个办法，不能一直这样拖下去，再拖下去村子里的水源真的撑不住了。”拆成：
${say('甘雨', '担忧', '我知道你现在很难受，可是我们总得想个办法。')}${say('甘雨', '焦急', '不能一直这样拖下去，再拖下去村子里的水源真的撑不住了。')}
${mistakes}
同一句里的情绪真的变了，就另起一组，两组各自写完整译文：
${say('甘雨', '不满', '我真的没有生气。')}${say('甘雨', '委屈', '只是……你下次不要这样突然离开。')}

情绪只能从这些词里选，不要自造、缩写或改写：${promptEmotionNames().join('、')}。听不出明显情绪时用平静，不要为了表现丰富而硬加情绪。
平静：有意识地保持平稳、克制。
日常：普通生活交流。
自然：轻松，不刻意表现情绪。
害羞、生气这类词只写进情绪字段，不要写进角色名，也不要在台词里用括号标注。

正文里不要解释标签怎么用，也不要为了举例把台词放进代码块。

写完后在心里核对一遍：每句说出口的话是否都有完整的一组（译文 + 角色|情绪|文本）；译文与文本是否逐句对应、两边一字不差；所有标签是否都闭合了。核对过程不要写出来。

这些规则只管台词怎么写。预设、角色卡、状态栏、选项、思考过程、变量更新该输出的照常完整输出，不要因为加标签而省略或改写。

她把目光挪开，手指不自觉地整理了一下衣袖。
${say('甘雨', '害羞', '你、你怎么突然说这种话……')}
她稍微停顿了一下，随后恢复了平日的语气。
${say('甘雨', '平静', '今天的工作终于结束了。')}
甘雨轻轻点头，声音也放柔了些。
${say('甘雨', '温柔', '嗯，那我们走吧。')}

同一段里也可以夹着旁白。每一句对白各写一组，中间的旁白保持普通正文：
${say('胡桃', '惊喜', '专程来找我的？')}胡桃一把将两扇门板推得大敞，红褐色的双马尾随着她大幅度的转身晃晃悠悠。${say('胡桃', '调皮', '快请进快请进！')}`.trim();
}

// 自由格式：正文照常写，标签只补充「谁、什么情绪、念哪句」。
// 显示文本取自标签前面紧贴的那句话，所以正文一个字都不用改，也不会重复。
function freeDialoguePrompt(format) {
    const say = (role, emotion, text) => formatExample(format.source, { 角色: role, 情绪: emotion, 文本: text });
    return `[对白语音标记]

角色的对白照常写在正文里，原来的引号、旁白、动作都保持不动；在每句说出口的话后面紧跟一个语音标签：
${format.source}

标签里依次写角色、情绪、文本：角色必须是显示名，情绪从下面的词表里挑一个，文本是真正要念出来的那句。读者看到的是正文里那句，听到的是标签里的文本，两边可以略有出入（比如补上语气词），但不要改成另一句话。

正文里那句要用引号包住，标签紧跟在引号后面（引号 “” 或「」都行）：这句话就是显示出来的文本，标签只负责发音。

已注册角色，标签里必须用显示名：
${characterRosterText()}
1. 表里的人用显示名，不要用别名、昵称、简称或代词当名字。
2. 不在表里的人，按剧情写全名。不要只写姓、职位、称号或「他」「她」。
3. 同一个人全文只用这一个名字。
4. 角色名不能省略，也不能写成 {角色} 之类的占位符。字段之间只用英文竖线 |。

一句说出口的话只配一个标签，换说话者、中间插进旁白、或者情绪变了，就另起一个。一两个字的短答、感叹、喊叫、被打断的半句，都要配标签。

示例：
她稍微停顿了一下，随后恢复了平日的语气。
“今天的工作终于结束了。”${say('甘雨', '平静', '今天的工作终于结束了。')}
甘雨轻轻点头，声音也放柔了些。
“嗯，那我们走吧。”${say('甘雨', '温柔', '嗯，那我们走吧。')}

长台词要拆开写：一口气超过四十来字，就按句号、问号、感叹号或逗号拆成两三句，每句后面各配一个标签，念的时候会自然接上。

情绪只能从这些词里选，不要自造、缩写或改写：${promptEmotionNames().join('、')}。听不出明显情绪时用平静。
害羞、生气这类词只写进情绪字段，不要写进角色名，也不要在台词里用括号标注。

正文里不要解释标签怎么用，也不要为了举例把台词放进代码块。

写完后在心里核对一遍：每句说出口的话后面是否都有一个完整闭合的标签；角色名是否都是显示名。核对过程不要写出来。

这些规则只管标签怎么写。预设、角色卡、状态栏、选项、思考过程、变量更新该输出的照常完整输出，不要因为加标签而省略或改写。`.trim();
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
            .replaceAll('{{EMOTIONS}}', promptEmotionNames().join('、'))
            .replaceAll('{{格式}}', voiceFormat())
            .replaceAll('{{FORMAT}}', voiceFormat());
    }
    return dialoguePrompt();
}

function applyDialoguePrompt() {
    const prompt = loadSettings().prompt;
    const on = enabled() && prompt.enabled !== false;
    const text = on ? activePrompt() : '';
    const depth = Math.max(0, Number(prompt.depth) || 0);
    setExtensionPrompt(
        PROMPT_KEY,
        text,
        extension_prompt_types.IN_CHAT,
        depth,
        false,
        promptRole(prompt.role),
        () => speakableGeneration && enabled(),
    );
}

function notify(level, message) {
    notifyAction(level, message);
}

function notifyAction(level, message, action) {
    const config = loadSettings().notify;
    const category = level === 'info' ? 'success' : level;
    if (config.enabled === false || config[category] === false) return;
    const fn = globalThis.toastr?.[level];
    if (typeof fn !== 'function') return;
    // 带动作的提示加个点击重试，比只弹一行字有用。
    if (action) fn(message, '', { onclick: action, timeOut: 12000, extendedTimeOut: 5000, closeButton: true });
    else fn(message);
}

// 长消息里一句一句失败会刷屏。攒 400ms 合成一条，点一下整批重试。
const failedNotifications = new Map();
let failureTimer = 0;

function flushFailures() {
    failureTimer = 0;
    const entries = [...failedNotifications.entries()];
    failedNotifications.clear();
    if (!entries.length) return;
    const keys = entries.map(([key]) => key);
    const retry = () => {
        keys.forEach((key) => {
            bubblesByKey(key).forEach((node) => {
                if (node.dataset.status !== 'error') return;
                node.dataset.status = 'waiting';
                node.classList.remove('error');
                delete node.title;
                enqueue(node, { autoplay: node.dataset.autoplay === '1' });
            });
        });
    };
    const text = entries.length === 1
        ? `${entries[0][1] || '配音失败'}（点击重试）`
        : `${entries.length} 句配音失败（点击重试）`;
    notifyAction('error', text, retry);
}

function reportFailure(key, message) {
    const text = message || '配音失败';
    if (!key) {
        notify('error', text);
        return;
    }
    failedNotifications.set(key, text);
    clearTimeout(failureTimer);
    failureTimer = setTimeout(flushFailures, 400);
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

function gatewayCharacter(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    const fields = (entry) => [entry.character_id, entry.display_name, entry.name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]
        .map((part) => String(part || '').trim())
        .filter(Boolean);
    const exact = gatewayCharacters.find((entry) => fields(entry).some((part) => part.toLowerCase() === key));
    if (exact) return exact;
    // 角色表里叫「胡桃｜HuTao」、正文里写「胡桃」，或者反过来带空格/标点，都算同一个人。
    // 只认全等的话，这些楼会被当成陌生角色整句退成纯文本——气泡不出现，自然也不会有语音请求。
    const fuzzy = normalizeName(name);
    if (!fuzzy) return null;
    return gatewayCharacters.find((entry) => fields(entry).some((part) => normalizeName(part) === fuzzy)) || null;
}

// 名字比较用：去空格、去包装标点，大小写不敏感。
function normalizeName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[\s\u3000]+/g, '')
        .replace(/[·・•‧∙⋅/／\\|｜_\-—–~～.,，。:：;；!！?？'"“”‘’()（）\[\]【】<>《》]/g, '');
}

// 同一个角色的不同写法归到一个显示名：模型有时写别名（甘雨/王小美），有时只写全名的一段。
// 不归并的话，缓存键、data-voice-name、播放条会各算一份。
const ROLE_SEP = /[·・•‧∙⋅/／\\\s]+/u;

function canonicalSpeaker(name) {
    const raw = String(name || '').trim();
    if (!raw || !gatewayCharacters.length) return raw;
    const exact = gatewayCharacter(raw);
    if (exact) return rosterNames(exact).name || raw;
    const parts = raw.split(ROLE_SEP).filter(Boolean);
    if (parts.length < 2) return raw;
    const hits = gatewayCharacters.filter((item) => {
        const { name: full, aliases } = rosterNames(item);
        return [full, ...aliases].filter(Boolean).some((candidate) => {
            if (candidate === raw) return true;
            const own = candidate.split(ROLE_SEP).filter(Boolean);
            // 卡里写全名、模型只写其中一段（或反过来）都算同一个人。
            if (own.length > 1) return parts.every((part) => own.includes(part));
            return parts.includes(candidate);
        });
    });
    const names = [...new Set(hits.map((item) => rosterNames(item).name).filter(Boolean))];
    return names.length === 1 ? names[0] : raw;
}

// 网关照它实际用的参考音频和推理配置给版本号。网关没给时退回角色配置的修改时间。
function voiceRevision(speaker) {
    const item = gatewayCharacter(speaker);
    if (!item) return '';
    const voice = item.voice_revision ?? item.version ?? '';
    const synthesis = item.synthesis_revision ?? '';
    return `${voice}\u0003${synthesis}`;
}

function bubbleKey(speaker, emotion, text) {
    const who = canonicalSpeaker(speaker);
    return `${who}\n${emotion}\n${text}\n${voiceRevision(who)}`;
}

function voiceAttrs(speaker, emotion, text, settled) {
    // 别名先归并到显示名，缓存键和播放条才不会同一个角色出现两份。
    speaker = canonicalSpeaker(speaker);
    // 「电话·开心」：标记词只决定播放音效，送给网关的情绪是后面的「开心」。
    const spoken = voiceEffect(emotion);
    const key = bubbleKey(speaker, spoken.emotion, text);
    const cached = memory.get(key) || '';
    const status = cached ? 'ready' : (pending.has(key) ? 'queued' : 'waiting');
    const loading = status === 'queued' ? ' loading' : '';
    const url = cached ? ` data-audio-url="${escapeHtmlAttr(cached)}"` : '';
    const settledAttr = settled ? '' : ' data-settled="0"';
    const effectAttr = spoken.effect ? ` data-effect="${spoken.effect}"` : '';
    const effectName = spoken.effect === 'phone' ? '电话' : (spoken.effect === 'inner' ? '心声' : '');
    const shownEmotion = spoken.emotion && spoken.emotion !== 'default' ? ` · ${spoken.emotion}` : '';
    const label = `播放 ${speaker}${shownEmotion}${effectName ? `（${effectName}音效）` : ''}`;
    // 声波是 span，键盘和读屏都够不着。补上按钮语义和标签。
    const attrs = ` role="button" tabindex="0" aria-label="${escapeHtmlAttr(label)}" data-status="${status}" data-key="${escapeHtmlAttr(key)}"${url} data-text="${escapeHtmlAttr(text)}" data-voice-name="${escapeHtmlAttr(speaker)}" data-voice-emotion="${escapeHtmlAttr(spoken.emotion)}"${effectAttr}${settledAttr}`;
    return { loading, attrs };
}

function buildBubbleHtml(speaker, emotion, text, settled = true, inner = false) {
    const state = voiceAttrs(speaker, emotion, text, settled);
    const width = Math.min(220, 60 + Math.max(2, Math.ceil(text.length * 0.25)) * 10);
    const seconds = Math.max(2, Math.ceil(text.length * 0.25));
    // 气泡只显示声波和大致时长，长句不好分辨，用 title 补上说话人和台词开头。
    const excerpt = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    const spoken = voiceEffect(emotion);
    const effectName = spoken.effect === 'phone' ? '电话' : (spoken.effect === 'inner' ? '心声' : '');
    const shown = spoken.emotion && spoken.emotion !== 'default' ? ` · ${spoken.emotion}` : '';
    const tip = `${speaker}${shown}${effectName ? `（${effectName}）` : ''}：${excerpt}`;
    return `<span class="voice-bubble tad-voice${state.loading}" style="width: ${width}px"${state.attrs}${inner ? ' data-inner="1"' : ''} title="${escapeHtmlAttr(tip)}">${BARS_HTML}<span class="sovits-voice-duration">${seconds}&quot;</span></span>`;
}

function spokenColor(html, inner = false) {
    return `<span class="tad-spoken${inner ? ' tad-inner' : ''}">${html}</span>`;
}

function presentDialogue(text, inner = false) {
    const value = String(text || '').trim();
    // 心声本来就不带引号（斜体显示），和 ST 的 data-sttts-inner 一致。
    if (inner) return value;
    if (/^[「“"『]/.test(value)) return value;
    return `“${value}”`;
}

// 情绪字段里写着心声就算心声：这类台词在正文里不带引号，斜体显示。
function innerVoice(emotion) {
    return /心声|内心|独白|inner/i.test(emotion || '');
}

// 扩展关掉时正文不再改写，把「译文<tts>角色|情绪|文本</tts>」收成读者该看的样子。
// 顺带清掉可能残留的标记字符，免得私用区字符留在正文里。
function humanizeTtsTags(html) {
    return unmark(String(html || ''))
        .replace(/([”」』"])\s*<(?:i-)?tts>[\s\S]*?<\/(?:i-)?tts>/gi, '$1')
        .replace(/<(?:i-)?tts>([\s\S]*?)<\/(?:i-)?tts>/gi, (match, inner) => {
            const parts = String(inner).replace(/｜/g, '|').split('|');
            const spoken = parts.length >= 2 ? parts[parts.length - 1].trim() : '';
            if (!spoken) return '';
            const emotion = parts.length === 3 ? parts[1].trim() : '';
            return escapeHtmlAttr(presentDialogue(spoken, innerVoice(emotion)));
        });
}

function buildLineHtml(speaker, emotion, text, settled = true, options = {}) {
    const state = voiceAttrs(speaker, emotion, text, settled);
    const spoken = voiceEffect(emotion);
    const effectName = spoken.effect === 'phone' ? '电话' : (spoken.effect === 'inner' ? '心声' : '');
    const title = `${speaker}${spoken.emotion && spoken.emotion !== 'default' ? ` · ${spoken.emotion}` : ''}${effectName ? `（${effectName}）` : ''}`;
    const display = options.display ?? presentDialogue(text, options.inner);
    const innerAttr = options.inner ? ' data-inner="1"' : '';
    const innerClass = options.inner ? ' tad-inner' : '';
    return `<span class="tad-line tad-voice${state.loading}${innerClass}"${state.attrs}${innerAttr} title="${escapeHtmlAttr(title)}"><span class="tad-line-body">${escapeHtmlAttr(display)}</span><span class="tad-line-mark">${BARS_HTML}</span></span>`;
}

function speakerKnown(name) {
    if (!gatewayCharacters.length) return true;
    return gatewayCharacter(name) !== null;
}

// 同一个名字只提示一次：每楼每句都弹一遍反而看不清。
const warnedSpeakers = new Set();
function warnUnknownSpeaker(name) {
    const key = normalizeName(name) || String(name || '');
    if (warnedSpeakers.has(key)) return;
    warnedSpeakers.add(key);
    const roster = gatewayCharacters.map((item) => rosterNames(item).name).filter(Boolean).slice(0, 8).join('、');
    console.warn(`[tts-afterdrought] 网关角色表里没有「${name}」，这句可能合不出来。表里有：${roster || '（空）'}`);
    notify('warning', `网关角色表里没有「${name}」，这句可能合不出来。表里有：${roster || '（空）'}`);
}

function keptFromNode(node) {
    const inner = node.dataset.inner === '1';
    if (node.classList.contains('tad-line')) {
        return node.querySelector('.tad-line-body')?.textContent || presentDialogue(node.dataset.text || '', inner);
    }
    return presentDialogue(node.dataset.text || '', inner);
}

// 自动连播队列也存 { key, node }：同一楼里重复的台词会被当成两句，各自高亮、各自记已播。
function pushAuto(track) {
    if (!track?.key) return;
    if (autoList.some((item) => item.key === track.key && (item.node || null) === (track.node || null))) return;
    autoList.push(track);
}

function forgetVoice(key) {
    if (!key) return;
    pending.delete(key);
    const queued = genQueue.findIndex((item) => item.key === key);
    if (queued >= 0) genQueue.splice(queued, 1);
    for (let i = autoList.length - 1; i >= 0; i -= 1) {
        if (autoList[i].key === key) autoList.splice(i, 1);
    }
}

function dropCachedAudio(key) {
    const url = memory.get(key);
    if (url) URL.revokeObjectURL(url);
    memory.delete(key);
    audioStore.delete(key);
    voiceEngine.dropBlob(key);
    forgetVoice(key);
}

function refreshVoiceKeys() {
    document.querySelectorAll(`#chat ${VOICE_NODE}`).forEach((node) => {
        const next = bubbleKey(
            node.dataset.voiceName,
            node.dataset.voiceEmotion || 'default',
            node.dataset.text || '',
        );
        if (!node.dataset.key || node.dataset.key === next) return;
        dropCachedAudio(node.dataset.key);
        node.dataset.key = next;
        node.dataset.status = 'waiting';
        node.removeAttribute('data-audio-url');
        node.classList.remove('loading', 'playing', 'error', 'paused', 'played');
    });
}

function releaseVoiceNode(node) {
    const plain = document.createElement('span');
    plain.className = 'tad-kept';
    plain.textContent = keptFromNode(node);
    // 心声退回纯文本时也保留斜体、不带引号。
    if (node.dataset.inner === '1') {
        plain.classList.add('tad-inner');
        plain.dataset.inner = '1';
    }
    forgetVoice(node.dataset.key);
    node.replaceWith(plain);
}

function releaseVoice(key) {
    bubblesByKey(key).forEach(releaseVoiceNode);
}

class SkipVoice extends Error {}

// 一组语音标记：正文按行切成「旁白 + 标记 + 旁白 …」，控件 HTML 单独留在 controls 里，
// 等酒馆格式化完再由 waveMarks 换回去。
function markSpeech(source, streaming = false) {
    const { lines, problems } = parseDialogueLines(source, { streaming, format: voiceFormat() });
    reportDialogueProblems(problems);
    if (!lines.length) return null;
    const controls = [];
    let marked = '';
    let at = 0;
    for (const line of lines) {
        marked += source.slice(at, line.start);
        controls.push(lineVoiceHtml(line));
        const inner = line.inner === true || innerVoice(line.emotion);
        // 自由格式且正文里没有可取的显示句时不重复写一遍，只挂控件。
        const display = line.tagOnly ? '' : presentDialogue(line.translation || line.text, inner);
        marked += markLine(controls.length - 1, escapeHtmlAttr(display));
        at = line.end;
    }
    return { text: marked + source.slice(at), controls };
}

// 标签没认出来时给一次提示，别让用户对着一堆原始括号猜。60 秒内不重复。
let lastProblemAt = 0;
let lastProblemText = '';

function reportDialogueProblems(problems) {
    if (!problems.length) return;
    const unique = [...new Set(problems)];
    const text = unique.slice(0, 3).join('；');
    if (text === lastProblemText && Date.now() - lastProblemAt < 60000) return;
    lastProblemAt = Date.now();
    lastProblemText = text;
    console.info('[AfterDrought TTS] 未识别的语音标记：', unique);
    notify('warning', `有语音标记没认出来：${text}`);
}

function lineVoiceHtml(line) {
    const speaker = canonicalSpeaker(line.speaker);
    const inner = line.inner === true || innerVoice(line.emotion);
    const shown = line.tagOnly ? '' : (line.translation || line.text);
    // 角色表里查不到这个人时，以前整句退成纯文本——读者只会看到「没有气泡也没有请求」。
    // 现在照挂气泡，点下去让网关自己报错，同时提示一次是哪个名字对不上。
    if (gatewayCharacters.length && !speakerKnown(speaker)) warnUnknownSpeaker(speaker);
    if (renderMode() === 'line') {
        const display = shown ? presentDialogue(shown, inner) : '';
        return buildLineHtml(speaker, line.emotion, line.text, line.settled, { display, inner });
    }
    // 气泡模式：先显示那句译文（没有译文就显示念的那句），气泡跟在后面。
    return `${spokenColor(escapeHtmlAttr(presentDialogue(shown, inner)), inner)} ${buildBubbleHtml(speaker, line.emotion, line.text, line.settled, inner)}`;
}

// <tts> 不是标准标签，酒馆格式化正文时会把它剥掉，DOM 里只剩「角色|情绪|文本」这串裸文字。
// 所以带标签的楼层从原始消息重画：先换成标记，过一遍酒馆的格式化，再把标记换回语音控件。
// 重画失败的两种原因只报一次：正文停在剥完标签的样子最难看出问题出在哪。
let warnedRenderGap = false;
function warnRenderGap(reason) {
    if (warnedRenderGap) return;
    warnedRenderGap = true;
    console.warn(`[tts-afterdrought] 带 <tts> 的楼层没能重画：${reason}`);
    // 只写控制台等于没说：用户看到的就是「没气泡、也没请求」，不知道该改哪儿。
    notify('warning', `这句没能渲染成语音：${reason}`);
}

// 标记换控件时被丢掉（格式化的标签不配对，多半是正则过滤把一句话切开）——
// 以前只留译文、什么都不说，看着就是「气泡凭空没了」。
function reportDroppedBubble() {
    warnRenderGap('这句的格式化结果里有没配对的标签，控件没挂上（检查正则过滤是不是切断了这句）');
}

function rawTtsHtml(raw, entry, id) {
    // 边生成边显示时，还没闭合的标签先整段砍掉，译文已经写在前面，读者照样能看。
    const streaming = replyStreaming();
    const text = streaming ? raw.replace(/<(?:i-)?tts>(?:(?!<\/(?:i-)?tts>)[\s\S])*$/i, '') : raw;
    const marked = markSpeech(text, streaming);
    if (!marked) {
        if (!streaming) warnRenderGap(`按当前台词格式（${voiceFormat()}）一句都没匹配上，模型写的是另一种写法`);
        return null;
    }
    const ctx = chatContext();
    if (!ctx || typeof ctx.messageFormatting !== 'function') {
        warnRenderGap('拿不到 SillyTavern 的 messageFormatting');
        return null;
    }
    let formatted;
    try {
        formatted = ctx.messageFormatting(marked.text, entry.name || '', !!entry.is_system, !!entry.is_user, id, {}, false);
    } catch (err) {
        warnRenderGap(`messageFormatting 抛错：${err?.message || err}`);
        return null;
    }
    return waveMarks(String(formatted), marked.controls, reportDroppedBubble);
}

// 酒馆显示的是 extra.display_text（有的话），读原始正文时跟着取那一份，才算和页面上是同一段字。
function rawOf(entry) {
    const shown = entry?.extra?.display_text;
    if (typeof shown === 'string' && shown) return shown;
    return typeof entry?.mes === 'string' ? entry.mes : '';
}

// 上面这条路只在酒馆没有格式化钩子时才走。新版酒馆在正文渲染的每一步都留了钩子，
// ST-iPhonie 用的就是它：标记插在酒馆自己那遍正则/Markdown 之前，控件在 Markdown 之后换回来。
// 这样气泡是酒馆渲染结果的一部分；渲染完再去改 innerHTML，酒馆一重画楼层（刷新、切 swipe、
// 滚回历史都算）就把控件冲掉，正文只剩下被剥掉标签的那串「角色|情绪|文本」。
const hookControls = new Map();
let formatterHooked = false;

function hookApplies(meta) {
    return enabled()
        && Number(meta?.messageId) >= 0
        && !meta?.isUser
        && !meta?.isSystem
        && !meta?.isReasoning;
}

/** 装上钩子；酒馆太老没有钩子时返回 false，让上面那条改 DOM 的路兜底。 */
function installFormatterHooks() {
    if (formatterHooked) return true;
    const formatter = chatContext()?.messageFormatter;
    if (typeof formatter?.addHook !== 'function') return false;
    const stage = formatter.stage || {};
    const before = stage.BEFORE_REGEX || 'BEFORE_REGEX';
    const after = stage.AFTER_MARKDOWN || null;
    formatter.addHook((text, meta) => {
        if (typeof text !== 'string' || !hookApplies(meta) || !looksLikeVoice(text)) return text;
        const marked = markSpeech(text, replyStreaming());
        if (!marked) return text;
        hookControls.set(Number(meta.messageId), marked.controls);
        // 没有 Markdown 之后的阶段就把控件直接插在这里，标记等不到换回来的时机。
        return after ? marked.text : waveMarks(marked.text, marked.controls, reportDroppedBubble);
    }, { stage: before, order: 100 });
    if (after) {
        formatter.addHook((text, meta) => {
            const controls = hookControls.get(Number(meta?.messageId));
            if (typeof text !== 'string' || !controls || !hookApplies(meta)) return text;
            return waveMarks(text, controls, reportDroppedBubble);
        }, { stage: after, order: 100 });
    }
    formatterHooked = true;
    return true;
}

// 缓存以前只进不出，用久了 IndexedDB 会一路涨到配额。按条数和总字节做 LRU 淘汰。
const CACHE_MAX_ITEMS = 2000;
const CACHE_MAX_BYTES = 400 * 1024 * 1024;
let cachePruneAt = 0;

async function pruneAudioStore(force = false) {
    const now = Date.now();
    if (!force && now - cachePruneAt < 30000) return 0;
    cachePruneAt = now;
    const items = await audioStore.all();
    let total = items.reduce((sum, item) => sum + (item?.blob?.size || 0), 0);
    if (items.length <= CACHE_MAX_ITEMS && total <= CACHE_MAX_BYTES) return 0;
    items.sort((a, b) => (a?.timestamp || 0) - (b?.timestamp || 0));
    let removed = 0;
    for (const item of items) {
        if (items.length - removed <= CACHE_MAX_ITEMS && total <= CACHE_MAX_BYTES) break;
        if (!item?.key || memory.has(item.key)) continue;
        total -= item?.blob?.size || 0;
        removed += 1;
        await audioStore.delete(item.key);
    }
    if (removed) refreshCacheCount();
    return removed;
}

let folderHandle = null;

// 浏览器断开只是停止等待，网关那边的任务要单独撤回。按提交时的会话分组，切了聊天也不会拿错 session。
function cancelRemote(requests) {
    const groups = new Map();
    for (const item of requests) {
        const requestId = item && item.requestId;
        if (!requestId) continue;
        const key = item.sessionId || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(requestId);
    }
    for (const [session, ids] of groups) {
        fetch(`${apiBase()}/v1/tts/cancel`, {
            method: 'POST',
            headers: apiHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ request_ids: ids, session_id: session }),
            keepalive: true,
        }).catch(() => { /* 旧版网关没有取消接口时忽略 */ });
    }
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
    voiceEngine.stop();
    if (audio) {
        audio.pause();
        audio = null;
    }
    notifyQueueChange();
    hidePlayer();
    document.querySelectorAll(VOICE_NODE).forEach((node) => {
        node.classList.remove('playing', 'loading', 'paused');
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

// 每次真正提交都换一个 ID。缓存键只用来找音频，不用来标识请求。
function newRequestId() {
    try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch { /* 老浏览器没有 randomUUID */ }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

// ---------- 长句兜底 ----------
// 网关嫌文本太长时按标点切成两半，各自请求，再把音频拼回一整句。
const SPLIT_MARKS = /[，,；;。！？!?…、：:\s]/g;
const TOO_LONG_CODES = new Set(['input_too_long', 'text_too_long', 'max_character_limit_exceeded', 'too_long']);
const TOO_LONG_WORDS = /(?:too (?:long|large)|exceed\w*\s+(?:the\s+)?(?:max\w*|length|limit)|长度超|太长|过长|字数超|超过.{0,6}(?:字|字符|长度))/i;

function halves(text) {
    const value = String(text || '').trim();
    if (value.length < 12) return null;
    const middle = value.length / 2;
    const marks = [...value.matchAll(SPLIT_MARKS)].map((match) => match.index + 1);
    if (!marks.length) return null;
    const cut = marks.reduce((best, pos) => (Math.abs(pos - middle) < Math.abs(best - middle) ? pos : best), marks[0]);
    const head = value.slice(0, cut).trim();
    const tail = value.slice(cut).trim();
    if (head.length < 4 || tail.length < 4) return null;
    return [head, tail];
}

function tooLongError(error) {
    const status = Number(error?.status) || 0;
    if (status && status !== 400 && status !== 413 && status !== 422) return false;
    if (TOO_LONG_CODES.has(String(error?.code || '').toLowerCase())) return true;
    return TOO_LONG_WORDS.test(String(error?.message || ''));
}

async function fetchAudio(segment) {
    const signal = speechAbort.signal;
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    if (!segment.fresh && memory.has(segment.key)) return memory.get(segment.key);
    let lastError = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        if (signal.aborted) throw new DOMException('已取消', 'AbortError');
        try {
            return await fetchAudioOnce(segment, signal);
        } catch (error) {
            if (error?.name === 'AbortError' || error instanceof SkipVoice) throw error;
            lastError = error;
            // 网关嫌太长：按标点切两半重来，拼好的整句照样按原 key 进缓存。
            const parts = tooLongError(error) && !segment.split ? halves(segment.text) : null;
            if (parts) return fetchSplitAudio(segment, parts);
            // 只对网关抖动/排队类状态码退避重试，参数错误重试也没用。
            if (!RETRY_STATUS.has(error?.status) || attempt === MAX_ATTEMPTS - 1) throw error;
            await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** attempt));
        }
    }
    throw lastError || new Error('语音生成失败');
}

// 半句请求不进缓存（cache:false），拼好之后只留整句那一条。
async function fetchSplitAudio(segment, parts) {
    const blobs = [];
    for (const [index, part] of parts.entries()) {
        const url = await fetchAudio({
            ...segment,
            key: `${segment.key}#${index}`,
            text: part,
            fresh: true,
            cache: false,
            split: true,
            autoplay: false,
            track: null,
        });
        blobs.push(await (await fetch(url)).blob());
        URL.revokeObjectURL(url);
    }
    const joined = await joinBlobs(blobs);
    if (!joined) throw new Error('长台词切段后没能拼回一整句');
    return storeAudio(segment, joined);
}

async function fetchAudioOnce(segment, signal) {
    // 边生成边播时用户在等声音，超时给短一点；整段预生成可以多等。
    const timeout = playbackSettings().progressive ? 60000 : REQUEST_TIMEOUT_MS;
    const request = { requestId: newRequestId(), sessionId: sessionId() };
    const controller = new AbortController();
    const relay = () => controller.abort();
    let timedOut = false;
    signal.addEventListener('abort', relay);
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeout);
    inflightRequests.set(segment.key, request);
    try {
        return await requestAudio(segment, request.requestId, controller.signal);
    } catch (error) {
        if (timedOut) {
            cancelRemote([request]);
            throw new Error(`语音网关 ${Math.round(timeout / 1000)} 秒没有返回`);
        }
        if (error?.name === 'AbortError') throw new DOMException('已取消', 'AbortError');
        throw error;
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', relay);
        if (inflightRequests.get(segment.key)?.requestId === request.requestId) inflightRequests.delete(segment.key);
    }
}

async function requestAudio(segment, requestId, signal) {
    const preset = segment.emotion && segment.emotion !== 'default' ? segment.emotion : null;
    const body = {
        request_id: requestId,
        session_id: sessionId(),
        character_id: segment.speaker,
        emotion: { type: 'vector', preset, vector: null, weight: null },
        text: segment.text,
        output: { format: 'wav', sample_rate: 24000, fresh: !!segment.fresh },
    };
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
        const failure = new Error((data && (data.detail || data.error)) || '语音生成失败');
        failure.status = response.status;
        failure.code = String(data?.code || data?.error_code || '');
        throw failure;
    }
    if (!response.ok) {
        let detail = `语音生成失败 (${response.status})`;
        let code = '';
        try {
            const data = await response.json();
            const message = data.detail || data.error;
            if (typeof message === 'string') detail = message;
            code = String(data.code || data.error_code || '');
        } catch { /* 非 JSON 错误体 */ }
        if (response.status === 404 && detail.startsWith('未找到角色')) throw new SkipVoice(detail);
        const failure = new Error(detail);
        failure.status = response.status;
        failure.code = code;
        throw failure;
    }
    const blob = await response.blob();
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    if (!blob.size) throw new Error('语音网关返回了空音频');
    if (/^text\/|html/i.test(type)) throw new Error('语音网关返回的不是音频');
    // 能不能播交给浏览器判断：wav/mp3/ogg/flac/m4a/webm 都认，只挡住明显不是音频的响应体。
    if (!(await sniffAudioExt(blob))) throw new Error('语音网关返回了无法识别的音频');
    return storeAudio(segment, blob);
}

// 生成好的音频统一落缓存、存盘、通知界面；切段拼接的结果也走这里。
async function storeAudio(segment, blob) {
    const url = URL.createObjectURL(blob);
    // 切段请求出来的半句只用来拼整句，不进缓存也不占存储。
    if (segment.cache === false) return url;
    const previous = memory.get(segment.key);
    if (previous && previous !== url) URL.revokeObjectURL(previous);
    memory.set(segment.key, url);
    voiceEngine.setBlob(segment.key, blob);
    audioStore.put({
        key: segment.key,
        blob,
        speaker: segment.speaker,
        emotion: segment.emotion || 'default',
        effect: segment.effect || '',
        text: segment.text,
        timestamp: Date.now(),
    }).then(() => pruneAudioStore()).catch(async (error) => {
        if (error?.name === 'QuotaExceededError') {
            const removed = await pruneAudioStore(true);
            notify('warning', removed
                ? `缓存已满，清理了 ${removed} 条旧语音`
                : '浏览器存储已满，本次语音没有写入缓存');
        }
    });
    refreshCacheCount();
    return url;
}

async function playUrl(url, key = '', effect = '') {
    if (!url) return;
    let handled = false;
    try {
        handled = await voiceEngine.play(url, key || url, { effect: effectsEnabled() ? effect : '' });
    } catch {
        handled = false;
    }
    if (handled) return;
    // 没有 WebAudio 或解码失败时退回原来的 <audio>。音效链依赖 WebAudio，这里只保底出声。
    if (audio) audio.pause();
    const next = new Audio(url);
    next.playbackRate = voiceEngine.rate;
    next.addEventListener('timeupdate', () => {
        const duration = Number.isFinite(next.duration) ? next.duration : 0;
        paintProgress({
            key,
            time: next.currentTime,
            duration,
            progress: duration ? Math.min(1, next.currentTime / duration) : 0,
        });
    });
    audio = next;
    await new Promise((resolve) => {
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

function effectOfKey(key) {
    return bubblesByKey(key)[0]?.dataset.effect || '';
}

// ---------- 迷你播放条：当前句字幕 + 逐句进度 ----------
// playList 是「这次朗读的句子顺序」，每条是 { key, node }：node 是这一句对应的那个气泡。
// 同一楼里重复的台词（两次「嗯。」）各有各的 node，上一句/下一句不会都指回第一处。
const playList = [];
let playPos = -1;
let liveTrack = null;
// 进度每 200ms 刷一次，别每次都全页扫一遍气泡，只记住当前这句的节点。
let progressNodes = [];

function playerBarNode() {
    return document.querySelector('#tad-player');
}

function trackOf(node) {
    return node?.dataset?.key ? { key: node.dataset.key, node } : null;
}

function trackOfKey(key) {
    return key ? { key, node: null } : null;
}

// 这句要亮哪些节点：点出来的句子只亮自己；全文朗读没有节点，才按 key 找。
function trackNodes(track) {
    if (track?.node) return [track.node];
    return bubblesByKey(track?.key || '');
}

function tracksOfMessage(node) {
    const holder = node?.closest('.mes_text') || node?.closest('.mes');
    const single = trackOf(node);
    if (!holder) return single ? [single] : [];
    const tracks = [...holder.querySelectorAll(VOICE_NODE)].map(trackOf).filter(Boolean);
    return tracks.length ? tracks : (single ? [single] : []);
}

function setPlayList(tracks) {
    const list = (Array.isArray(tracks) ? tracks : []).filter((track) => !!track?.key);
    playList.splice(0, playList.length, ...list);
    playPos = -1;
}

function clockText(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function playerLabel(node) {
    if (!node) return '';
    const speaker = node.dataset.voiceName || '';
    const emotion = node.dataset.voiceEmotion && node.dataset.voiceEmotion !== 'default' ? ` · ${node.dataset.voiceEmotion}` : '';
    const effect = node.dataset.effect === 'phone' ? '（电话）' : (node.dataset.effect === 'inner' ? '（心声）' : '');
    return `${speaker}${emotion}${effect}`;
}

function queueNote() {
    if (!playList.length || playPos < 0) return '';
    const left = playList.length - playPos - 1;
    return left > 0 ? `还有 ${left} 句` : '最后一句';
}

function syncPlayerPause() {
    const bar = playerBarNode();
    if (!bar) return;
    const button = bar.querySelector('[data-tad-player="pause"]');
    if (!button) return;
    const playing = !!voiceEngine.current && !voiceEngine.paused;
    button.textContent = playing ? '暂停' : '继续';
    // <audio> 兜底没有暂停点，别给一个点了会跳句的按钮。
    button.hidden = !voiceEngine.current;
}

function paintPlayerInfo(track) {
    const bar = playerBarNode();
    if (!bar) return;
    const node = track?.node || bubblesByKey(track?.key || '')[0];
    bar.querySelector('.tad-player-who').textContent = playerLabel(node);
    bar.querySelector('.tad-player-text').textContent = node?.dataset.text || '';
    bar.querySelector('[data-tad-player="queue"]').textContent = queueNote();
    syncPlayerPause();
}

function showPlayer(track) {
    if (track) liveTrack = track;
    if (!liveTrack) return;
    const index = playList.indexOf(liveTrack);
    playPos = index >= 0 ? index : playList.findIndex((item) => item.key === liveTrack.key);
    progressNodes = trackNodes(liveTrack);
    const bar = playerBarNode();
    if (bar) bar.hidden = false;
    paintPlayerInfo(liveTrack);
    paintProgress({ progress: 0 });
}

function hidePlayer() {
    liveTrack = null;
    progressNodes.forEach((node) => node.style.removeProperty('--tad-progress'));
    progressNodes = [];
    const bar = playerBarNode();
    if (bar) {
        bar.hidden = true;
        bar.style.setProperty('--tad-progress', '0%');
    }
}

// 进度：播放条上一条线，当前句上也跟着走一格，算是逐句高亮。
function paintProgress({ progress = 0, duration = 0, time = 0 } = {}) {
    const pct = Math.max(0, Math.min(100, Math.round((Number(progress) || 0) * 100)));
    const bar = playerBarNode();
    if (bar) {
        bar.style.setProperty('--tad-progress', `${pct}%`);
        const clock = bar.querySelector('[data-tad-player="time"]');
        if (clock) clock.textContent = duration ? `${clockText(time)} / ${clockText(duration)}` : '';
    }
    progressNodes.forEach((node) => node.style.setProperty('--tad-progress', `${pct}%`));
}

function pauseCurrent() {
    if (!voiceEngine.current || voiceEngine.paused) return false;
    if (!voiceEngine.pause()) return false;
    trackNodes(liveTrack).forEach((node) => {
        node.classList.remove('playing');
        node.classList.add('paused');
    });
    syncPlayerPause();
    return true;
}

function resumeCurrent() {
    if (!voiceEngine.paused || !voiceEngine.current) return false;
    if (!voiceEngine.resume()) return false;
    trackNodes(liveTrack).forEach((node) => {
        node.classList.remove('paused');
        node.classList.add('playing');
    });
    syncPlayerPause();
    return true;
}

function togglePause() {
    // 先认 WebAudio 的暂停点；退回 <audio> 时只能整体暂停。
    if (voiceEngine.current) {
        if (voiceEngine.paused) resumeCurrent();
        else pauseCurrent();
        return;
    }
    if (audio) {
        // <audio> 兜底时没有「从暂停点续播」，空格就当停止。
        stopPlayback();
        return;
    }
    if (playList.length) stepPlay(1);
}

// 上一句/下一句：没生成好的那句交给「从这句继续」，把后面的句子一起排上。
function stepPlay(delta) {
    if (!playList.length || !delta) return;
    const base = playPos >= 0 ? playPos : (delta > 0 ? -1 : playList.length);
    const index = Math.max(0, Math.min(playList.length - 1, base + delta));
    const track = playList[index];
    const node = track?.node || bubblesByKey(track?.key || '')[0];
    if (!node) return;
    playPos = index;
    if (node.dataset.status === 'ready') {
        playBubble(node);
        return;
    }
    playFromNode(node);
}

function bindPlayerBar(bar) {
    const hit = (name, handler) => {
        const button = bar.querySelector(`[data-tad-player="${name}"]`);
        if (button) button.addEventListener('click', handler);
    };
    hit('prev', () => stepPlay(-1));
    hit('next', () => stepPlay(1));
    hit('pause', () => togglePause());
    hit('close', () => stopPlayback());
}

function isTypingTarget(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') return true;
    return node.isContentEditable === true;
}

function segmentFromButton(btn, autoplay) {
    return {
        key: btn.dataset.key,
        speaker: btn.dataset.voiceName,
        emotion: btn.dataset.voiceEmotion || 'default',
        effect: btn.dataset.effect || '',
        text: btn.dataset.text,
        fresh: btn.dataset.fresh === '1',
        autoplay: !!autoplay,
        track: trackOf(btn),
    };
}

function markPlayed(track) {
    const key = track?.key;
    if (!key) return;
    playedKeys.add(key);
    trackNodes(track).forEach((node) => node.classList.add('played'));
}

function markReady(key, url) {
    bubblesByKey(key).forEach((node) => {
        node.dataset.status = 'ready';
        node.dataset.audioUrl = url;
        node.classList.remove('loading', 'error');
        node.classList.toggle('played', playedKeys.has(key));
        delete node.dataset.fresh;
    });
    voiceEngine.prime(key, url);
    notifyQueueChange();
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
    if (segment.autoplay) pushAuto(segment.track || trackOfKey(key));
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
            voiceEngine.setBlob(key, record.blob);
            pending.delete(key);
            markReady(key, url);
            considerDrain();
        }).catch(() => { /* 没有持久缓存就继续向网关请求 */ });
    }
    pump();
}

// 跟随滚动：这句已经不在聊天框视口里时才滚一下，用户自己滚到别处时不硬拽回去。
function revealNode(node) {
    if (!node || !playbackSettings().follow) return;
    const chat = document.getElementById('chat');
    if (!chat) return;
    const box = chat.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    if (rect.top >= box.top && rect.bottom <= box.bottom) return;
    chat.scrollTop += rect.top - box.top - Math.max(0, (box.height - rect.height) / 2);
}

async function playBubble(btn) {
    const key = btn?.dataset.key;
    const url = btn?.dataset.audioUrl || memory.get(key);
    if (!url) return;
    // 点正在播的这句 → 暂停；点暂停的这句 → 接着播，不再从头开始。
    if (voiceEngine.currentKey === key && !voiceEngine.paused) {
        pauseCurrent();
        return;
    }
    if (voiceEngine.paused && voiceEngine.currentKey === key) {
        resumeCurrent();
        return;
    }
    // 没有 WebAudio（或解码失败）时用的是 <audio>，暂停只能整体停掉。
    if (audio && btn?.classList.contains('playing')) {
        stopPlayback();
        return;
    }
    const token = ++playToken;
    autoList.splice(0, autoList.length);
    const track = trackOf(btn);
    // 单句点击也要有上一句/下一句：按同一条消息里的气泡顺序建列表。
    if (!playList.some((item) => item.node === btn)) setPlayList(tracksOfMessage(btn));
    const same = trackNodes(track);
    document.querySelectorAll(`${VOICE_NODE}.playing, ${VOICE_NODE}.paused`).forEach((node) => {
        node.classList.remove('playing', 'paused');
    });
    same.forEach((node) => node.classList.add('playing'));
    revealNode(same[0]);
    showPlayer(track);
    await playUrl(url, key, btn.dataset.effect || '');
    if (token === playToken) {
        same.forEach((node) => node.classList.remove('playing', 'paused'));
        markPlayed(track);
        hidePlayer();
    }
}

function considerDrain() {
    if (draining) return;
    const playback = playbackSettings();
    const buffer = Math.max(1, Math.min(20, Number(playback.bufferSize) || 1));
    while (autoList.length && !memory.has(autoList[0].key) && !pending.has(autoList[0].key) && !genQueue.some((item) => item.key === autoList[0].key)) {
        autoList.shift();
    }
    let ready = 0;
    for (const track of autoList) {
        if (!memory.has(track.key)) break;
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
            const track = autoList[0];
            const key = track.key;
            if (!memory.has(key)) {
                if (pending.has(key) || genQueue.some((item) => item.key === key)) {
                    await waitQueueChange();
                    continue;
                }
                autoList.shift();
                continue;
            }
            autoList.shift();
            const same = trackNodes(track);
            document.querySelectorAll(`${VOICE_NODE}.playing, ${VOICE_NODE}.paused`).forEach((node) => {
                node.classList.remove('playing', 'paused');
            });
            same.forEach((node) => node.classList.add('playing'));
            revealNode(same[0]);
            showPlayer(track);
            await playUrl(memory.get(key), key, track.node?.dataset.effect || effectOfKey(key));
            if (token === playToken) {
                same.forEach((node) => node.classList.remove('playing', 'paused'));
                markPlayed(track);
                // 下一句如果已经就绪，先解码好，播完这句就能直接接上。
                const nextKey = autoList[0]?.key;
                if (nextKey && memory.has(nextKey)) voiceEngine.prime(nextKey, memory.get(nextKey));
            }
        }
    } finally {
        draining = false;
        if (autoList.length && token === playToken) considerDrain();
        else if (token === playToken) {
            readingMes = null;
            hidePlayer();
        }
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
                reportFailure(key, message);
            } finally {
                pending.delete(key);
                notifyQueueChange();
                considerDrain();
            }
        }
    } finally {
        pumping = false;
        notifyQueueChange();
        considerDrain();
        if (genQueue.length) pump();
    }
}

function lastMesText() {
    const nodes = document.querySelectorAll('.mes_text');
    return nodes.length ? nodes[nodes.length - 1] : null;
}

// DOM 里没有控件时（比如刚编辑过的楼层），从原始正文里现拼一份出来，顺序和正文一致。
function segmentsFromPlain(text) {
    const marked = markSpeech(applyRegexFilters(text));
    if (!marked) return [];
    const holder = document.createElement('div');
    holder.innerHTML = marked.controls.join('');
    return [...holder.querySelectorAll(VOICE_NODE)].map((node) => ({
        key: node.dataset.key,
        speaker: node.dataset.voiceName,
        emotion: node.dataset.voiceEmotion || 'default',
        effect: node.dataset.effect || '',
        text: node.dataset.text,
        fresh: false,
        autoplay: false,
    }));
}

const SPEECH_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeSpeechEntities(text) {
    return String(text || '').replace(/&(#?\w+);/g, (match, name) => SPEECH_ENTITIES[name] ?? match);
}

// 念的文本要去掉排版符号：HTML、代码块、Markdown、表格、分隔线、列表符号。
function stripForSpeech(html) {
    const plain = String(html || '')
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/~~~[\s\S]*?~~~/g, ' ')
        .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, ' ')
        .replace(/^\s*\|.*\|\s*$/gm, ' ')
        .replace(/^\s*(?:[-*+]|\d+[.、)])\s+/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/[*_~`#>|]+/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n');
    return decodeSpeechEntities(plain).trim();
}

function markupToSpeech(text) {
    const source = applyRegexFilters(String(text || ''))
        .replace(/<(tucao|advice|think)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    // 每句台词只念标签里的文本。line.start 已经把前面那句译文圈进去了（自由格式只圈标签），
    // 所以直接按区间替换成念的文本，一句不会念两遍，也不挑模板。
    const { lines } = parseDialogueLines(source, { format: voiceFormat() });
    let spoken = '';
    let at = 0;
    for (const line of lines) {
        spoken += source.slice(at, line.start);
        spoken += line.text ? `\n${line.text}\n` : ' ';
        at = line.end;
    }
    return stripForSpeech(spoken + source.slice(at));
}

function fullSegments(text, speaker) {
    const who = canonicalSpeaker(speaker);
    return splitSentences(markupToSpeech(text)).map((line) => ({
        key: bubbleKey(who, 'default', line),
        speaker: who,
        emotion: 'default',
        text: line,
        fresh: false,
        autoplay: false,
    }));
}

function queueMessage(mes, autoplay, full = false) {
    if (!enabled() || !mes || mes.getAttribute('is_user') === 'true') return;
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
    // 整楼连播时先记下句子顺序，播放条才能上一句/下一句。
    setPlayList(segments.map((segment) => trackOfKey(segment.key)));
    segments.forEach((segment) => enqueueSegment({ ...segment, autoplay: !!autoplay }));
}

function queueLastMessage(autoplay) {
    const mes = [...document.querySelectorAll('#chat .mes')].pop();
    queueMessage(mes, autoplay, fullScope());
}

function mountFullButtons() {
    const active = enabled() && fullScope();
    document.querySelectorAll('#chat .mes').forEach((mes) => {
        const existing = mes.querySelector('.tad-full-play');
        if (!active || mes.getAttribute('is_user') === 'true') {
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
    if (!enabled()) return;
    const last = lastMesText();
    if (!last) return;
    last.querySelectorAll(VOICE_NODE).forEach((btn) => {
        if (btn.dataset.settled === '0') return;
        if (autoplay && btn.dataset.status !== 'ready' && btn.dataset.status !== 'error') btn.dataset.autoplay = '1';
        if (btn.dataset.status === 'waiting') enqueue(btn, { autoplay });
    });
    pump();
}

// 楼层里有没有语音标签。标准形状只认 <tts>；换了自定义模板就按模板里第一段固定文字找，
// 不再要求那段必须长成 HTML 标签——`【{角色}, {情绪}】…` 这种模板以前一律判成「没有标记」，
// 于是整楼既不渲染也不入队。
function literalAppears(raw, literal) {
    const base = String(literal || '').trim();
    if (!base) return false;
    const variants = new Set([base]);
    if (base.includes('|')) variants.add(base.replace(/\|/g, '｜'));
    if (base.includes('｜')) variants.add(base.replace(/｜/g, '|'));
    return [...variants].some((part) => part && raw.includes(part));
}

function looksLikeVoice(raw) {
    if (!raw) return false;
    if (/<(?:i-)?tts>/i.test(raw)) return true;
    const format = compileFormat(voiceFormat());
    if (format.standard) return false;
    const literal = format.literals.map((part) => String(part || '')).find((part) => part.trim());
    // 模板里连一段固定文字都没有时判断不了，交给解析器去看。
    if (!literal) return true;
    return literalAppears(raw, literal);
}

// 一次性自检：正文没被改写时，先看这几项，省得来回猜是开关、兼容模式还是酒馆接口拿不到。
function logSelfCheck() {
    const ctx = chatContext();
    console.info('[tts-afterdrought] 自检', {
        总开关: enabled(),
        兼容模式: compatMode(),
        台词格式: voiceFormat(),
        聊天记录: Array.isArray(ctx?.chat) ? ctx.chat.length : '取不到',
        角色表: `${gatewayCharacters.length} 人`,
        格式化钩子: formatterHooked ? '已接管' : (typeof ctx?.messageFormatter?.addHook === 'function' ? '可装' : '没有，走改 DOM'),
    });
}

// 钩子装上去了，但有些酒馆版本正文走的不是这条格式化路径（或者被别的扩展整个接管），
// 钩子一次都不会被调用：正文里有 <tts>，楼里却没有控件。补一道兜底，按老办法重画一遍。
let repairLogged = false;
function repairMissingBubbles() {
    if (generating() || !enabled() || skipRewrite()) return false;
    const ctx = chatContext();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : null;
    if (!chat) return false;
    let repaired = 0;
    document.querySelectorAll('#chat .mes').forEach((mes) => {
        const text = mes.querySelector('.mes_text');
        if (!text || text.tagName !== 'DIV' || text.querySelector('#curEditTextarea')) return;
        if (text.querySelector(VOICE_NODE)) return;
        const id = Number(mes.getAttribute('mesid'));
        const entry = Number.isInteger(id) ? chat[id] : null;
        if (!entry) return;
        const raw = rawOf(entry);
        if (!looksLikeVoice(raw)) return;
        const next = rawTtsHtml(raw, entry, id);
        if (!next || next === text.innerHTML) return;
        text.innerHTML = next;
        repaired += 1;
    });
    if (repaired && !repairLogged) {
        repairLogged = true;
        console.warn(`[tts-afterdrought] 格式化钩子没把控件画进正文，已用兜底重画 ${repaired} 楼`);
    }
    return repaired > 0;
}

// 从一段 HTML 里取出所有控件的缓存键：只比状态属性的话，ready/error/waiting 的来回会一直被当成「正文变了」。
function voiceKeysOf(html) {
    return (String(html).match(/data-key="[^"]*"/g) || []).join('\u0001');
}

function scan() {
    mountFullButtons();
    if (!enabled() || skipRewrite()) return;
    // 钩子接手了正文，这里再改 DOM 只会跟酒馆的渲染抢同一个节点；
    // 只有「正文有标签、楼里却没有控件」时才动手。
    if (formatterHooked) {
        repairMissingBubbles();
        if (!generating()) playNewReply = false;
        return;
    }
    let changed = false;
    const ctx = chatContext();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : null;
    document.querySelectorAll(BUBBLE_ROOTS).forEach((node) => {
        if (!node.isConnected || node.closest(VOICE_NODE) || node.querySelector?.('#curEditTextarea')) return;
        // 带 <tts> 的楼层只能从原始消息重画，DOM 里的标签已经被酒馆剥掉了。
        const mesid = Number(node.closest('.mes')?.getAttribute('mesid'));
        const entry = chat && Number.isInteger(mesid) ? chat[mesid] : null;
        const raw = rawOf(entry);
        if (!looksLikeVoice(raw)) return;
        const next = rawTtsHtml(raw, entry, mesid);
        if (!next) return;
        // 只认当前 DOM：酒馆自己重画过（刷新楼层、切 swipe）之后，气泡就没了，
        // 这时再拿缓存跳过重画，正文会一直停在剥完标签的样子。
        if (next === node.innerHTML) return;
        // 同一批台词已经在正文里了，差别只在状态：重写会把失败的气泡改回 waiting，
        // 下一轮扫描又入队一次，合成失败（或网关慢）时就成了每隔 120ms 重发请求的死循环。
        if (voiceKeysOf(next) === voiceKeysOf(node.innerHTML)) return;
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
    playedKeys.delete(key);
    voiceEngine.stop();
    dropCachedAudio(key);
    bubblesByKey(key).forEach((node) => {
        node.dataset.status = 'waiting';
        node.removeAttribute('data-audio-url');
        node.classList.remove('loading', 'playing', 'paused', 'played', 'error');
    });
    btn.dataset.fresh = '1';
    enqueue(btn, { autoplay: false });
    pump();
}

// 从这一句开始，把同一楼里后面的气泡全部排队朗读。
function playFromNode(btn) {
    const holder = btn?.closest('.mes_text');
    if (!holder) {
        playBubble(btn);
        return;
    }
    const nodes = [...holder.querySelectorAll(VOICE_NODE)];
    const from = nodes.indexOf(btn);
    if (from < 0) return;
    stopPlayback();
    setPlayList(nodes.map(trackOf));
    nodes.slice(from).forEach((node) => {
        enqueueSegment({
            key: node.dataset.key,
            speaker: node.dataset.voiceName,
            emotion: node.dataset.voiceEmotion || 'default',
            effect: node.dataset.effect || '',
            text: node.dataset.text,
            fresh: false,
            autoplay: true,
            track: trackOf(node),
        });
    });
}

// 网关可能回 wav，也可能回 mp3/ogg。按文件头判断真实编码，文件名后缀别再说谎。
// 只做识别，不做兜底：认不出来就返回空串，让调用方决定是报错还是当 wav 存。
async function sniffAudioExt(blob) {
    try {
        const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
        const ascii = (start, end) => String.fromCharCode(...head.slice(start, end));
        if (ascii(0, 4) === 'RIFF') return 'wav';
        if (ascii(0, 4) === 'OggS') return 'ogg';
        if (ascii(0, 4) === 'fLaC') return 'flac';
        if (ascii(0, 4) === 'FORM') return 'aiff';
        if (ascii(4, 8) === 'ftyp') return 'm4a';
        if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
        if (ascii(0, 3) === 'ID3') return 'mp3';
        if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';
    } catch { /* 读不出文件头就当未知 */ }
    return '';
}

async function downloadBubble(btn) {
    const url = btn?.dataset.audioUrl;
    if (!url) return;
    const speaker = btn.dataset.voiceName || 'voice';
    let blob = null;
    try {
        blob = await (await fetch(url)).blob();
    } catch {
        blob = null;
    }
    if (!blob || !blob.size) {
        notify('error', '这段语音已经取不到了，重新生成一次');
        return;
    }
    const ext = (await sniffAudioExt(blob)) || 'wav';
    const emotion = btn.dataset.voiceEmotion || 'default';
    const name = `[${safeFilePart(speaker)}]_[${safeFilePart(emotion)}]_${safeFilePart(btn.dataset.text)}_${await shortHash(btn.dataset.key || url)}.${ext}`;
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
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
    const from = document.createElement('button');
    from.type = 'button';
    from.textContent = '从这句继续';
    menu.append(download, reroll, from);
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
        const height = 110;
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
    from.addEventListener('click', (event) => {
        event.stopPropagation();
        const btn = target;
        closeMenu();
        if (btn) playFromNode(btn);
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

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const btn = event.target.closest?.(VOICE_NODE);
        if (!btn) return;
        event.preventDefault();
        btn.click();
    });

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
                // 开着的时候只重画带语音标记的楼层：别的扩展往正文里挂的东西不该被整条重写掉。
                if (enabled() && !looksLikeVoice(rawOf(entry))) return;
                try {
                    // 关掉扩展后不再改写正文，<tts> 标签要自己收干净，只留读者该看的那句。
                    // 收在格式化之前做：格式化会把未知标签连同标签里的文字一起剥掉，剥完就分不清哪句是台词了。
                    const source = enabled() ? rawOf(entry) : humanizeTtsTags(rawOf(entry));
                    const html = ctx.messageFormatting(
                        source,
                        entry.name || '',
                        !!entry.is_system,
                        !!entry.is_user,
                        id,
                        {},
                        false,
                    );
                    text.innerHTML = html;
                } catch { /* 这条还原失败就留着现有正文 */ }
            });
        }
        scan();
    } finally {
        refreshing = false;
    }
}

// 0ms 去抖等于每个 DOM 变更都扫全页。给渲染留一点合并窗口，流式输出时更明显。
const SCAN_DEBOUNCE_MS = 120;

function scheduleScan() {
    if (refreshing || !enabled()) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scan(), SCAN_DEBOUNCE_MS);
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
    setValue('fab', fabEnabled());
    setValue('auto', autoPlay());
    setValue('render', renderMode());
    setValue('prompt-enabled', settings.prompt.enabled !== false);
    setValue('prompt-depth', settings.prompt.depth ?? 1);
    setValue('prompt-role', settings.prompt.role || 'system');
    setValue('prompt-format', settings.prompt.format || DEFAULT_VOICE_FORMAT);
    setValue('prompt-content', settings.prompt.builtin === false ? (settings.prompt.content || '') : dialoguePrompt());
    setValue('scope', settings.playback.scope === 'full' ? 'full' : 'dialogue');
    setValue('compat', settings.playback.compat === true);
    setValue('auto-infer', settings.playback.autoInfer === true);
    setValue('progressive', settings.playback.progressive === true);
    setValue('buffer', settings.playback.bufferSize || 5);
    setValue('volume', settings.playback.volume ?? 1);
    voiceEngine.setVolume(settings.playback.volume ?? 1);
    setValue('rate', settings.playback.rate ?? 1);
    voiceEngine.setRate(settings.playback.rate ?? 1);
    setValue('follow', settings.playback.follow !== false);
    setValue('sfx', settings.playback.sfx !== false);
    setValue('notify-enabled', settings.notify.enabled !== false);
    setValue('notify-success', settings.notify.success === true);
    setValue('notify-warning', settings.notify.warning !== false);
    setValue('notify-error', settings.notify.error !== false);
    document.querySelectorAll('[data-tad="buffer"]').forEach((node) => {
        node.disabled = settings.playback.progressive !== true;
    });
    document.querySelectorAll('[data-tad="auto-infer-note"]').forEach((node) => {
        // 对白范围本来就会自动合成，这个开关只在全文和兼容模式下起作用。
        const useful = settings.playback.scope === 'full' || settings.playback.compat === true;
        node.textContent = useful ? '' : '（对「对白」无效）';
    });
    document.querySelectorAll('[data-tad="prompt-state"]').forEach((node) => {
        node.textContent = settings.prompt.builtin === false
            ? '正在使用你改过的提示词。{{CHAR}} 会换成当前角色名，{{CHARACTERS}} 会换成网关角色表里这段剧情露过面的角色（一个都没认出来时给完整表），{{EMOTIONS}} 会换成情绪列表，{{格式}} 会换成上面的台词格式。'
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
    if (patch.fab !== undefined) localStorage.setItem(STORAGE.fabShow, patch.fab ? '1' : '0');
    if (patch.auto !== undefined) localStorage.setItem(STORAGE.auto, patch.auto ? '1' : '0');
    if (patch.render !== undefined) localStorage.setItem(STORAGE.render, patch.render === 'line' ? 'line' : 'bubble');
    if (patch.prompt) {
        if (patch.prompt.builtin === true) {
            settings.prompt.builtin = true;
            settings.prompt.content = '';
            delete patch.prompt.content;
            delete patch.prompt.builtin;
        }
        const formatBefore = settings.prompt.format;
        Object.assign(settings.prompt, patch.prompt);
        if (patch.prompt.format !== undefined) {
            const next = String(settings.prompt.format || '').trim();
            // 模板不合法就不写进去，面板会弹提示并把输入框退回原值。
            settings.prompt.format = next && !formatProblem(next) ? next : formatBefore;
            if (settings.prompt.format !== formatBefore) refreshView = true;
        }
    }
    if (patch.playback) {
        Object.assign(settings.playback, patch.playback);
        settings.playback.bufferSize = Math.max(1, Math.min(20, Number(settings.playback.bufferSize) || 5));
        settings.playback.volume = Math.max(0, Math.min(1, Number(settings.playback.volume)));
        if (Number.isNaN(settings.playback.volume)) settings.playback.volume = 1;
        settings.playback.rate = Math.max(0.5, Math.min(2, Number(settings.playback.rate) || 1));
        settings.playback.follow = settings.playback.follow !== false;
        if (patch.playback.compat !== undefined || patch.playback.scope !== undefined) refreshView = true;
    }
    if (patch.notify) Object.assign(settings.notify, patch.notify);
    if (patch.regexFilters) {
        settings.regexFilters = patch.regexFilters;
        refreshView = true;
    }
    if (patch.prompt || patch.playback || patch.notify || patch.regexFilters) saveSettings(settings);
    if (patch.fab !== undefined) applyFabVisibility();
    applyDialoguePrompt();
    if (patch.enabled === false || patch.render !== undefined || refreshView) stopPlayback();
    if (patch.enabled === false) {
        // 关掉总开关就不再改写正文，消息上的喇叭也一起收回去。
        refreshRenderedMessages();
        mountFullButtons();
    } else if (patch.enabled === true) {
        loadGatewayCharacters();
        loadEmotionNames();
        if (!skipRewrite()) scan();
        else mountFullButtons();
    } else if (patch.playback) {
        mountFullButtons();
    }
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
    const bytes = list.reduce((sum, item) => sum + (item?.blob?.size || 0), 0);
    const size = bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : `${Math.round(bytes / 1024)} KB`;
    document.querySelectorAll('[data-tad="cache-count"]').forEach((node) => {
        node.textContent = `${list.length} 条 · ${size}`;
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
    // 方括号是文件名里的分隔符，正文里出现也要换掉，不然导入时切不回去。
    return String(value || 'voice').replace(/[<>:"/\\|?*[\]\u0000-\u001f]/g, '_').slice(0, 40) || 'voice';
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
        // 按真实编码命名，wav/mp3/ogg 各归各位。
        const ext = (await sniffAudioExt(item.blob)) || 'wav';
        const file = `[${safeFilePart(item.speaker)}]_[${safeFilePart(item.emotion || 'default')}]_${safeFilePart(item.text)}_${await shortHash(item.key)}.${ext}`;
        const handle = await folderHandle.getFileHandle(file, { create: true });
        const writable = await handle.createWritable();
        await writable.write(item.blob);
        await writable.close();
        manifest.push({
            key: item.key,
            speaker: item.speaker,
            emotion: item.emotion || 'default',
            effect: item.effect || '',
            text: item.text,
            file,
            ext,
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
                effect: item.effect || '',
                text: item.text,
                timestamp: Date.now(),
            });
            seen.add(item.file);
            imported += 1;
        }
    } catch { /* 没有清单时继续按文件名导入 */ }
    // 文件名：[角色]_[情绪]_台词_哈希.ext；旧版没有情绪那一段，两种都认。
    const fileRe = /^\[(.*?)\]_(?:\[(.*?)\]_)?(.*)_([a-f0-9]{8,})\.([a-z0-9]{2,5})$/i;
    const oldRe = /^(.*?)_(.*)_([a-f0-9]{8,})\.([a-z0-9]{2,5})$/i;
    const liveNodes = [...document.querySelectorAll(`#chat ${VOICE_NODE}`)];
    for await (const [name, handle] of folderHandle.entries()) {
        if (handle.kind !== 'file' || seen.has(name)) continue;
        const match = name.match(fileRe) || name.match(oldRe);
        if (!match) continue;
        const bracketed = match.length === 6;
        // 旧版名字 `[角色]_文本_哈希` 也会落进带情绪的括号分组里，这时第二段是空的。
        const hasEmotion = bracketed && typeof match[2] === 'string';
        const speaker = match[1].trim() || 'Imported';
        const emotion = hasEmotion ? (match[2].trim() || 'default') : 'default';
        const text = (bracketed ? match[3] : match[2]).trim();
        if (!text) continue;
        const file = await handle.getFile();
        // 页面上还挂着同一句时用它的 key：情绪也在里面，别硬塞 default。
        const node = liveNodes.find((item) => item.dataset.text === text && item.dataset.voiceName === speaker)
            || liveNodes.find((item) => item.dataset.text === text);
        const finalSpeaker = node?.dataset.voiceName || speaker;
        const finalEmotion = node?.dataset.voiceEmotion || emotion;
        await audioStore.put({
            key: node?.dataset.key || bubbleKey(finalSpeaker, finalEmotion, text),
            blob: file,
            speaker: finalSpeaker,
            emotion: finalEmotion,
            effect: node?.dataset.effect || '',
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
    stopPlayback();
    await audioStore.clear();
    for (const url of memory.values()) URL.revokeObjectURL(url);
    memory.clear();
    playedKeys.clear();
    // 内存里的 blob URL 已经失效，气泡要退回「未生成」状态，否则点开是坏链接。
    document.querySelectorAll(`#chat ${VOICE_NODE}`).forEach((node) => {
        node.dataset.status = 'waiting';
        node.removeAttribute('data-audio-url');
        node.classList.remove('loading', 'playing', 'paused', 'played', 'error');
        delete node.dataset.autoplay;
    });
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
        text = '语音网关在线';
        ok = true;
    } catch { /* 面板上显示未就绪 */ }
    nodes.forEach((node) => {
        node.textContent = text;
        node.className = ok ? 'tad-status tad-status-ok' : 'tad-status tad-status-down';
    });
}

function connectionBox() {
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
    return booth;
}

function appendSettingsFields(parent) {
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
    panels.append(mainModule(), playbackModule(), promptModule(), notifyModule(), cacheModule(), regexModule());
    desk.append(index, panels);

    parent.append(desk);
    paintControls();
    renderRegexLists(parent);
    // 这时 parent 还没挂进文档，全局查询找不到这批节点，先按 parent 单独落页签。
    showSettingsTab(settingsTab, parent);
}

const SETTINGS_TABS = [
    ['main', '主要设置'],
    ['play', '播放'],
    ['prompt', '提示词'],
    ['notify', '通知'],
    ['cache', '缓存'],
    ['filter', '过滤'],
];
let settingsTab = 'main';

function showSettingsTab(tab, root = document) {
    settingsTab = SETTINGS_TABS.some(([id]) => id === tab) ? tab : 'main';
    root.querySelectorAll('[data-tad-tab]').forEach((node) => {
        const on = node.dataset.tadTab === settingsTab;
        node.classList.toggle('is-on', on);
        node.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    root.querySelectorAll('[data-tad-panel]').forEach((node) => {
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

function mainModule() {
    const box = moduleBox('连接与总开关', 'main');
    const switches = document.createElement('div');
    switches.className = 'tad-switches';
    const inferRow = switchRow('回复后自动合成', 'auto-infer');
    const inferNote = document.createElement('span');
    inferNote.className = 'tad-switch-note';
    inferNote.dataset.tad = 'auto-infer-note';
    inferRow.querySelector('span').append(inferNote);
    switches.append(
        switchRow('启用', 'enabled'),
        switchRow('悬浮窗', 'fab'),
        switchRow('新回复自动朗读', 'auto'),
        inferRow,
    );
    const render = selectField('渲染', 'render', [['bubble', '气泡'], ['line', '台词']]);
    const scope = selectField('朗读范围', 'scope', [['dialogue', '对白'], ['full', '全文']]);
    const note = document.createElement('div');
    note.className = 'tad-hint';
    note.textContent = '关掉「启用」后不再改写正文、不注入提示词，也不再合成语音。关掉「悬浮窗」只是收起页面上的 TTS 按钮，设置仍能从酒馆的扩展面板打开。全文同样渲染对白，朗读时按整条消息逐句读，用消息上的喇叭重听。「回复后自动合成」对「对白」范围无效，只在前端卡兼容或全文范围下起作用。';
    switches.addEventListener('change', (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement)) return;
        const map = {
            enabled: () => commitSettings({ enabled: input.checked }),
            fab: () => commitSettings({ fab: input.checked }),
            auto: () => commitSettings({ auto: input.checked }),
            'auto-infer': () => commitSettings({ playback: { autoInfer: input.checked } }),
        };
        map[input.dataset.tad]?.();
    });
    render.querySelector('select').addEventListener('change', (event) => commitSettings({ render: event.target.value }));
    scope.querySelector('select').addEventListener('change', (event) => commitSettings({ playback: { scope: event.target.value } }));
    box.append(connectionBox(), switches, render, scope, note);
    return box;
}

function playbackModule() {
    const box = moduleBox('播放与自动化', 'play');
    const switches = document.createElement('div');
    switches.className = 'tad-switches';
    switches.append(
        switchRow('边生成边播放', 'progressive'),
        switchRow('前端卡兼容', 'compat'),
        switchRow('朗读时跟随滚动', 'follow'),
        switchRow('电话/心声音效', 'sfx'),
    );
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
    note.textContent = '「边生成边播放」攒到缓冲句数就开播，缓冲越小起播越快、越容易断。前端卡兼容不改写正文，只在前端卡上按整条消息读。播放中空格暂停/继续，左右方向键换句，Esc 停止。';
    switches.addEventListener('change', (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement)) return;
        const map = {
            progressive: () => commitSettings({ playback: { progressive: input.checked } }),
            compat: () => commitSettings({ playback: { compat: input.checked } }),
            follow: () => commitSettings({ playback: { follow: input.checked } }),
            sfx: () => commitSettings({ playback: { sfx: input.checked } }),
        };
        map[input.dataset.tad]?.();
    });
    buffer.addEventListener('change', () => commitSettings({ playback: { bufferSize: Number(buffer.value) || 5 } }));

    const volumeLabel = document.createElement('label');
    volumeLabel.className = 'tad-field';
    volumeLabel.append(document.createTextNode('音量'));
    const volume = document.createElement('input');
    volume.type = 'range';
    volume.min = '0';
    volume.max = '1';
    volume.step = '0.05';
    volume.dataset.tad = 'volume';
    volumeLabel.append(volume);
    volume.addEventListener('input', () => voiceEngine.setVolume(Number(volume.value)));
    volume.addEventListener('change', () => commitSettings({ playback: { volume: Math.max(0, Math.min(1, Number(volume.value))) } }));

    const rateLabel = document.createElement('label');
    rateLabel.className = 'tad-field';
    rateLabel.append(document.createTextNode('语速'));
    const rate = document.createElement('input');
    rate.type = 'range';
    rate.min = '0.5';
    rate.max = '2';
    rate.step = '0.05';
    rate.dataset.tad = 'rate';
    rateLabel.append(rate);
    // 拖动时只调引擎，松手才写设置，免得每帧都落一次 localStorage。
    rate.addEventListener('input', () => voiceEngine.setRate(Number(rate.value)));
    rate.addEventListener('change', () => commitSettings({ playback: { rate: Number(rate.value) } }));

    box.append(switches, bufferLabel, volumeLabel, rateLabel, note);
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
    const formatLabel = document.createElement('label');
    formatLabel.className = 'tad-field';
    formatLabel.append(document.createTextNode('台词格式'));
    const formatInput = document.createElement('input');
    formatInput.type = 'text';
    formatInput.className = 'text_pole';
    formatInput.dataset.tad = 'prompt-format';
    formatLabel.append(formatInput);
    const formatHint = document.createElement('div');
    formatHint.className = 'tad-hint';
    formatHint.textContent = '占位符：{译文} {角色} {情绪} {文本}。去掉 {译文} 就是自由格式：正文照常写，标签只补充谁、什么情绪、念哪句。改这里会同步提示词、解析和显示。';
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
    formatInput.addEventListener('change', () => {
        const value = formatInput.value.trim() || DEFAULT_VOICE_FORMAT;
        const problem = formatProblem(value);
        if (problem) {
            notify('error', `台词格式有问题：${problem}`);
            formatInput.value = voiceFormat();
            return;
        }
        commitSettings({ prompt: { format: value } });
        paintControls();
    });
    content.addEventListener('change', () => {
        const builtin = content.value.trim() === dialoguePrompt().trim();
        commitSettings({ prompt: builtin ? { builtin: true, content: '' } : { builtin: false, content: content.value } });
    });
    reset.addEventListener('click', () => commitSettings({ prompt: { builtin: true, content: '' } }));
    box.append(switches, depthLabel, role, formatLabel, formatHint, content, state, reset);
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
    countValue.textContent = '0 条';
    count.append(document.createTextNode('已缓存 '), countValue);
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

// 触摸抬起后浏览器还会补发一次 click。面板现在是半屏高，悬浮窗那一下正好落在
// 露出来的遮罩上，于是刚打开就被这声 click 关掉。开面板后的短时间先不理遮罩点击。
const SHEET_OPEN_GUARD_MS = 400;
let sheetOpenedAt = 0;

function openSheet() {
    const overlay = document.querySelector('#tad-overlay');
    if (!overlay) return;
    overlay.hidden = false;
    sheetOpenedAt = performance.now();
    overlay.querySelector('.tad-sheet-body')?.scrollTo?.({ top: 0 });
    refreshStatus();
    refreshCacheCount();
    renderRegexLists();
    loadGatewayCharacters();
}

function closeSheet() {
    const overlay = document.querySelector('#tad-overlay');
    if (overlay) overlay.hidden = true;
}

function closeSheetFromBackdrop() {
    if (performance.now() - sheetOpenedAt < SHEET_OPEN_GUARD_MS) return;
    closeSheet();
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
    overlay.addEventListener('click', closeSheetFromBackdrop);
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!overlay.hidden) {
            closeSheet();
            return;
        }
        // 面板没开时，Esc 当成「停止」：正在放或队列里还有句子就一起清掉。
        if (voiceEngine.current || audio || autoList.length) {
            stopPlayback();
            notify('info', '已停止朗读');
        }
    });

    // 迷你播放条：贴左下角，播放时才出现，显示当前句字幕和进度。
    const player = document.createElement('div');
    player.id = 'tad-player';
    player.hidden = true;
    player.innerHTML = `
        <div class="tad-player-head">
            <span class="tad-player-who"></span>
            <span class="tad-player-time" data-tad-player="time"></span>
            <span class="tad-player-queue" data-tad-player="queue"></span>
        </div>
        <div class="tad-player-text"></div>
        <div class="tad-player-track"><i></i></div>
        <div class="tad-player-actions">
            <button type="button" data-tad-player="prev" title="上一句" aria-label="上一句">⏮</button>
            <button type="button" data-tad-player="pause" title="暂停/继续（空格）" aria-label="暂停或继续">暂停</button>
            <button type="button" data-tad-player="next" title="下一句" aria-label="下一句">⏭</button>
            <button type="button" data-tad-player="close" title="停止朗读" aria-label="停止朗读">✕</button>
        </div>`;
    bindPlayerBar(player);

    document.addEventListener('keydown', (event) => {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
        // 打字的地方、正开着设置面板、焦点在气泡上时，都别抢键。
        if (isTypingTarget(event.target)) return;
        if (event.target.closest?.(VOICE_NODE)) return;
        if (!overlay.hidden) return;
        if (player.hidden) return;
        if (event.key === ' ') {
            event.preventDefault();
            togglePause();
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            stepPlay(event.key === 'ArrowRight' ? 1 : -1);
        }
    });

    document.body.append(fab, player, overlay);
    applyFabVisibility();
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
    // 正文渲染不能等界面搭完：搭界面哪一步抛错，后面的钩子就装上不去，读者只会看到剥了标签的正文。
    installFormatterHooks();
    applyDialoguePrompt();
    if (enabled()) {
        loadEmotionNames();
        loadGatewayCharacters();
    }
    watchGatewayCharacters();
    restoreFolder();
    refreshCacheCount();
    buildShell();
    mountExtensionSettings();
    if (event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, mountExtensionSettings);
    }
    bindBubbleMenu();
    // 播放进度统一走这一个回调：播放条进度、当前句高亮都从这里来。
    voiceEngine.onProgress = paintProgress;
    // 设置在内存里留了一份，别的标签页改了之后要跟着失效。
    window.addEventListener('storage', (event) => {
        if (event.key && event.key !== STORAGE.settings) return;
        resetSettingsCache();
        paintControls();
        applyDialoguePrompt();
    });
    // 关页面/切后台被杀时，网关那边的合成任务还挂着。走 keepalive 一起撤掉。
    window.addEventListener('pagehide', () => {
        const stale = [...inflightRequests.values()];
        inflightRequests.clear();
        cancelRemote(stale);
        speechAbort.abort();
    });
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    // 钩子先装：装完让酒馆把已有楼层重画一遍，历史消息也能拿到气泡。
    installFormatterHooks();
    logSelfCheck();
    if (formatterHooked) refreshRenderedMessages();
    else scan();

    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, () => {
            streaming = false;
            speakableGeneration = enabled();
            if (!enabled()) return;
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
            speakableGeneration = enabled() && type !== 'quiet';
            if (enabled()) await loadGatewayCharacters();
            applyDialoguePrompt();
        });
    }
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            streaming = false;
            stopPlayback();
            hookControls.clear();
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
