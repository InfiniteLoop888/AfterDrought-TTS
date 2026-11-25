import { eventSource, event_types, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';

const STORAGE = {
    api: 'tad_api',
    auto: 'tad_auto',
    enabled: 'tad_enabled',
    inject: 'tad_inject',
    fab: 'tad_fab',
};

const PROMPT_KEY = 'tts-afterdrought-dialogue';
const LEGACY_API = 'http://127.0.0.1:7860';
const DEFAULT_API = 'http://127.0.0.1:9881';
const FALLBACK_EMOTIONS = ['平静', '温柔', '开心', '生气', '愤怒', '悲伤', '害怕', '惊讶', '害羞', '冷淡', '耳语'];
let emotionNames = FALLBACK_EMOTIONS.slice();

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

function apiBase() {
    let stored = (localStorage.getItem(STORAGE.api) || '').trim();
    if (!stored || stored.replace(/\/+$/, '') === LEGACY_API) stored = DEFAULT_API;
    return stored
        .replace(/\/+$/, '')
        .replace(/\/api\/v1$/, '')
        .replace(/\/v1$/, '')
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
    return emotionNames;
}

async function loadEmotionNames() {
    try {
        const response = await fetch(`${apiBase()}/v1/emotions`);
        if (!response.ok) return;
        const data = await response.json();
        if (Array.isArray(data.names) && data.names.length) {
            emotionNames = data.names;
            applyDialoguePrompt();
        }
    } catch { /* 网关不在时继续用短列表 */ }
}

function dialoguePrompt() {
    const name = currentCharacterName();
    const who = name ? `当前角色卡的名字是「${name}」。这个角色开口时必须使用这个名字，不要换成称呼、代词或昵称。\n` : '';
    return `[对白语音标记]
${who}角色真正说出口的每一句都要打上语音标记，否则无法朗读。旁白、动作、心理活动保持普通正文，不要放进标记。

格式，标记和这句对白在同一行：
[角色名, 情绪] 对白内容

规则：
1. 同一个人全篇只用同一个角色名。这个名字要和语音网关里的角色 id 或显示名一致。
2. 情绪只能从这些词里选一个：default、${promptEmotionNames().join('、')}。听不出明显情绪时用 default。
3. 标记后面同一行只写这一句口头对白。旁白另起一行，写在标记外面。
4. 语气不是情绪。需要耳语、放慢或冷淡时，在同一行末尾追加 〖vd:{"delivery":{"intensity":"whisper","pace":"slow"}}〗。intensity 只能是 normal、gentle、soft、whisper、firm、cold、teasing、hesitant、excited。写错会被忽略，对白照常朗读。

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

function takeDirector(spoken) {
    const match = String(spoken || '').match(/〖vd:([\s\S]*?)〗/);
    if (!match) return { text: String(spoken || '').trim(), director: null };
    let director = null;
    try {
        const data = JSON.parse(match[1]);
        if (data && typeof data === 'object' && !Array.isArray(data)) director = data;
    } catch { /* 导演指令不是合法 JSON 时丢掉，对白照常朗读 */ }
    return { text: String(spoken).replace(match[0], ' ').replace(/\s+/g, ' ').trim(), director };
}

function segmentText(director) {
    if (!director || !Array.isArray(director.segments)) return '';
    return director.segments.map((item) => (item && item.text) || '').join('').trim();
}

function bubbleKey(speaker, emotion, text, director = '') {
    return `${speaker}\n${emotion}\n${text}\n${director}`;
}

function buildBubbleHtml(speaker, emotion, text, settled = true, director = null) {
    const directorText = director ? JSON.stringify(director) : '';
    const key = bubbleKey(speaker, emotion, text, directorText);
    const cached = memory.get(key) || '';
    const status = cached ? 'ready' : (pending.has(key) ? 'queued' : 'waiting');
    const loading = status === 'queued' ? ' loading' : '';
    const width = Math.min(220, 60 + Math.max(2, Math.ceil(text.length * 0.25)) * 10);
    const seconds = Math.max(2, Math.ceil(text.length * 0.25));
    const url = cached ? ` data-audio-url="${escapeHtmlAttr(cached)}"` : '';
    const settledAttr = settled ? '' : ' data-settled="0"';
    const directorAttr = directorText ? ` data-director="${escapeHtmlAttr(directorText)}"` : '';
    return `<span class="voice-bubble${loading}" style="width: ${width}px" data-status="${status}" data-key="${escapeHtmlAttr(key)}"${url} data-text="${escapeHtmlAttr(text)}" data-voice-name="${escapeHtmlAttr(speaker)}" data-voice-emotion="${escapeHtmlAttr(emotion)}"${settledAttr}${directorAttr}>${BARS_HTML}<span class="sovits-voice-duration">${seconds}&quot;</span></span>`;
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
        const directed = takeDirector(spoken.spoken);
        const display = directed.text || segmentText(directed.director);
        if (!display) continue;
        result += buildBubbleHtml(speaker, emotion || 'default', display, spoken.settled, directed.director);
    }
    const tagged = matched ? result + source.slice(lastIndex) : source;
    const withLegacy = tagged.replace(/(\s*)\[TTSVoice[:：]\s*([^:：]+)\s*[:：]\s*([^:：]*)\s*[:：]\s*(.*?)\]/gi, (full, space, name, emotion, text) => {
        const directed = takeDirector(visibleText(text));
        const display = directed.text || segmentText(directed.director);
        if (!display) return full;
        return `${space || ''}${buildBubbleHtml(name.trim(), emotion.trim() || 'default', display, true, directed.director)}`;
    });
    return withLegacy === html ? html : withLegacy;
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

function sessionId() {
    try {
        const context = globalThis.SillyTavern?.getContext?.() || {};
        return String(context.chatId || context.chat_id || context.groupId || 'st-session');
    } catch {
        return 'st-session';
    }
}

async function fetchAudio(segment) {
    if (!segment.fresh && memory.has(segment.key)) return memory.get(segment.key);
    const preset = segment.emotion && segment.emotion !== 'default' ? segment.emotion : null;
    const body = {
        request_id: segment.fresh ? `${segment.key}:${Date.now()}` : `${sessionId()}:${segment.key}`,
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
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch {
        throw new Error('语音网关未就绪');
    }
    if (!response.ok) {
        let detail = `语音生成失败 (${response.status})`;
        try {
            const data = await response.json();
            const message = data.detail || data.error;
            if (typeof message === 'string') detail = message;
        } catch { /* 非 JSON 错误体 */ }
        throw new Error(detail);
    }
    const url = URL.createObjectURL(await response.blob());
    memory.set(segment.key, url);
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
    const cached = memory.get(key) || '';
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
                let director = null;
                if (btn.dataset.director) {
                    try { director = JSON.parse(btn.dataset.director); } catch { director = null; }
                }
                const url = await fetchAudio({
                    key,
                    speaker: btn.dataset.voiceName,
                    emotion: btn.dataset.voiceEmotion || 'default',
                    text: btn.dataset.text,
                    director,
                    fresh: btn.dataset.fresh === '1',
                });
                delete btn.dataset.fresh;
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
    memory.delete(btn.dataset.key);
    bubblesByKey(btn.dataset.key).forEach((node) => {
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
}

function commitSettings(patch) {
    if (patch.api !== undefined) localStorage.setItem(STORAGE.api, patch.api.trim() || DEFAULT_API);
    if (patch.enabled !== undefined) localStorage.setItem(STORAGE.enabled, patch.enabled ? '1' : '0');
    if (patch.auto !== undefined) localStorage.setItem(STORAGE.auto, patch.auto ? '1' : '0');
    if (patch.inject !== undefined) localStorage.setItem(STORAGE.inject, patch.inject ? '1' : '0');
    applyDialoguePrompt();
    if (patch.enabled === false) {
        stopPlayback();
    } else if (patch.enabled === true) {
        scan();
    }
    paintControls();
    if (patch.api !== undefined) loadEmotionNames();
    if (patch.api !== undefined || patch.enabled !== undefined) refreshStatus();
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
        const response = await fetch(`${apiBase()}/health`);
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

    const switches = document.createElement('div');
    switches.className = 'tad-switches';
    for (const [key, label] of [
        ['enabled', '启用'],
        ['auto', '新回复自动朗读'],
        ['inject', '注入对白格式'],
    ]) {
        const row = document.createElement('label');
        row.className = 'tad-switch';
        const name = document.createElement('span');
        name.textContent = label;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.tad = key;
        row.append(name, input);
        switches.append(row);
    }

    apiInput.addEventListener('change', () => commitSettings({ api: apiInput.value }));
    check.addEventListener('click', () => refreshStatus());
    switches.addEventListener('change', (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return;
        commitSettings({ [input.dataset.tad]: input.checked });
    });

    parent.append(status, apiLabel, check, hint, switches);
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
    if ((localStorage.getItem(STORAGE.api) || '').replace(/\/+$/, '') === LEGACY_API) {
        localStorage.setItem(STORAGE.api, DEFAULT_API);
    }
    applyDialoguePrompt();
    loadEmotionNames();
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
