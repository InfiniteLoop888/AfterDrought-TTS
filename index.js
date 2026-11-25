import { eventSource, event_types, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';

const STORAGE = {
    api: 'tad_api',
    auto: 'tad_auto',
    enabled: 'tad_enabled',
    inject: 'tad_inject',
};

const PROMPT_KEY = 'tts-afterdrought-dialogue';
const PROMPT_EMOTIONS = ['default', '开心', '生气', '悲伤', '害怕', '厌恶', '低落', '惊讶', '平静', '害羞', '委屈', '耳语'];

const DEFAULT_API = 'http://127.0.0.1:7860';

const VECTORS = {
    '开心': [0.6, 0, 0, 0, 0, 0, 0, 0],
    '高兴': [0.6, 0, 0, 0, 0, 0, 0, 0],
    '喜悦': [0.6, 0, 0, 0, 0, 0, 0, 0],
    happy: [0.6, 0, 0, 0, 0, 0, 0, 0],
    '生气': [0, 0.6, 0, 0, 0, 0, 0, 0],
    '愤怒': [0, 0.6, 0, 0, 0, 0, 0, 0],
    angry: [0, 0.6, 0, 0, 0, 0, 0, 0],
    '悲伤': [0, 0, 0.6, 0, 0, 0, 0, 0],
    '难过': [0, 0, 0.6, 0, 0, 0, 0, 0],
    sad: [0, 0, 0.6, 0, 0, 0, 0, 0],
    '害怕': [0, 0, 0, 0.6, 0, 0, 0, 0],
    '恐惧': [0, 0, 0, 0.6, 0, 0, 0, 0],
    '厌恶': [0, 0, 0, 0, 0.6, 0, 0, 0],
    '低落': [0, 0, 0, 0, 0, 0.6, 0, 0],
    '惊讶': [0, 0, 0, 0, 0, 0, 0.6, 0],
    '惊喜': [0, 0, 0, 0, 0, 0, 0.6, 0],
    '平静': [0, 0, 0, 0, 0, 0, 0, 0.6],
};

const TEXT_EMOTIONS = {
    '害羞': '害羞、犹豫，声音轻柔，带有一点不好意思',
    '委屈': '委屈，声音发紧，像是在忍着不哭',
    '耳语': '用很轻的气声耳语，音量低，像在贴着耳朵说话',
};

const memory = new Map();
let audio = null;
let playToken = 0;
let scanTimer = 0;
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

function dialoguePrompt() {
    const name = currentCharacterName();
    const who = name ? `当前角色卡的名字是「${name}」。这个角色开口时必须使用这个名字，不要换成称呼、代词或昵称。\n` : '';
    return `[对白语音标记]
${who}角色真正说出口的每一句都要打上语音标记，否则无法朗读。旁白、动作、心理活动保持普通正文，不要放进标记。

格式，标记和这句对白在同一行：
[角色名, 情绪] 对白内容

规则：
1. 同一个人全篇只用同一个角色名。
2. 情绪只能从这些词里选一个：${PROMPT_EMOTIONS.join('、')}。听不出明显情绪时用 default。害羞、委屈、耳语只在语气确实如此时使用。
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

function cleanText(text) {
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .trim();
}

function parseSegments(raw) {
    const text = cleanText(raw);
    if (!text) return [];

    const re = /[\[【]([^,，\]】\n]{1,30})\s*[,，]\s*([^\]】\n]{1,30})[\]】]/g;
    const matches = [...text.matchAll(re)];
    const tagged = [];
    for (let i = 0; i < matches.length; i++) {
        const speaker = matches[i][1].trim();
        const emotion = matches[i][2].trim();
        if (!speaker || emotion.toLowerCase() === 'new') continue;
        if (/^\d+$/.test(speaker) || /\d|[:：/\\]/.test(emotion)) continue;
        const start = matches[i].index + matches[i][0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
        const line = spokenLine(text, start, end);
        if (!line) continue;
        tagged.push({ speaker, emotion: emotion || 'default', text: line });
    }
    if (tagged.length) return tagged;
    return [{ speaker: 'default', emotion: 'default', text }];
}

function spokenLine(text, start, end) {
    const chunk = text.slice(start, end).replace(/^[\s:：]+/, '');
    const quoted = chunk.match(/^[“"「『]([\s\S]*?)[”"」』]/);
    if (quoted && quoted[1].trim()) return quoted[1].trim();
    const line = (chunk.split(/\r?\n/, 1)[0] || '').replace(/^[“"「『]+|[”"」』]+$/g, '').trim();
    return line;
}

function signature(segments) {
    return JSON.stringify(segments);
}

function emotionFields(emotion) {
    const name = (emotion || 'default').trim();
    const vector = VECTORS[name] || VECTORS[name.toLowerCase()];
    if (vector) {
        const fields = { emo_mode: '2', emo_weight: '0.8' };
        vector.forEach((value, index) => {
            fields[`vec${index + 1}`] = String(value);
        });
        return fields;
    }
    if (TEXT_EMOTIONS[name]) {
        return { emo_mode: '3', emo_weight: '0.6', emo_text: TEXT_EMOTIONS[name] };
    }
    return { emo_mode: '0', emo_weight: '0.65' };
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
    document.querySelectorAll('.tad-on').forEach((node) => node.classList.remove('tad-on'));
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

async function playSegments(segments, buttons, errorNode) {
    const token = ++playToken;
    errorNode.textContent = '';
    for (let i = 0; i < segments.length; i++) {
        if (token !== playToken) return;
        buttons.forEach((button) => button.classList.remove('tad-on'));
        buttons[i]?.classList.add('tad-on');
        try {
            const url = await fetchAudio(segments[i]);
            if (token !== playToken) return;
            await playUrl(url);
        } catch (error) {
            errorNode.textContent = error.message || String(error);
            buttons.forEach((button) => button.classList.remove('tad-on'));
            return;
        }
    }
    buttons.forEach((button) => button.classList.remove('tad-on'));
}

function mountMessage(mes, { auto = false } = {}) {
    if (!enabled()) return;
    if (mes.getAttribute('is_user') === 'true' || mes.getAttribute('is_system') === 'true') return;
    const textNode = mes.querySelector('.mes_text');
    if (!textNode) return;

    const segments = parseSegments(textNode.innerText || '');
    if (!segments.length) return;
    const sig = signature(segments);

    let bar = mes.querySelector(':scope .tad-bar');
    if (bar && bar.dataset.sig === sig) {
        if (auto && bar.dataset.autoplayed !== '1') {
            bar.dataset.autoplayed = '1';
            playSegments(segments, [...bar.querySelectorAll('.tad-line')], bar.querySelector('.tad-error'));
        }
        return;
    }

    bar?.remove();
    bar = document.createElement('div');
    bar.className = 'tad-bar';
    bar.dataset.sig = sig;

    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'tad-btn';
    all.textContent = '朗读';

    const errorNode = document.createElement('span');
    errorNode.className = 'tad-error';

    const lineButtons = segments.map((segment) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tad-line';
        const label = segment.speaker === 'default' ? segment.text : `${segment.speaker} · ${segment.text}`;
        button.textContent = label;
        button.title = label;
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            playSegments([segment], [button], errorNode);
        });
        return button;
    });

    all.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        playSegments(segments, lineButtons, errorNode);
    });

    bar.append(all, ...lineButtons, errorNode);
    const block = mes.querySelector('.mes_block') || textNode.parentElement || mes;
    block.append(bar);

    if (auto) {
        bar.dataset.autoplayed = '1';
        playSegments(segments, lineButtons, errorNode);
    }
}

function scan({ autoLast = false } = {}) {
    if (!enabled()) return;
    const messages = [...document.querySelectorAll('#chat .mes')];
    const last = messages[messages.length - 1];
    const skipLast = generating();
    for (const mes of messages) {
        if (skipLast && mes === last) continue;
        mountMessage(mes, { auto: autoLast && mes === last && !skipLast });
    }
}

function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scan(), 300);
}

function buildDock() {
    if (document.querySelector('.tad-dock')) return;
    const dock = document.createElement('div');
    dock.className = 'tad-dock';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tad-btn';
    toggle.textContent = 'TTS';

    const panel = document.createElement('div');
    panel.className = 'tad-panel';
    panel.hidden = true;

    const status = document.createElement('div');
    status.textContent = '未检查';

    const apiLabel = document.createElement('label');
    apiLabel.textContent = 'IndexTTS 地址';
    const apiInput = document.createElement('input');
    apiInput.type = 'text';
    apiInput.value = apiBase();
    apiLabel.append(apiInput);

    const voiceLabel = document.createElement('label');
    voiceLabel.textContent = '音色参考';
    const voiceInput = document.createElement('input');
    voiceInput.type = 'file';
    voiceInput.accept = 'audio/*,.wav,.mp3,.flac,.ogg,.opus';
    voiceLabel.append(voiceInput);
    const voiceHint = document.createElement('div');
    voiceHint.textContent = voiceName || '未选文件时用服务自带 voice_03.wav';

    const enabledLabel = document.createElement('label');
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = enabled();
    enabledLabel.append(enabledInput, document.createTextNode(' 启用'));

    const autoLabel = document.createElement('label');
    const autoInput = document.createElement('input');
    autoInput.type = 'checkbox';
    autoInput.checked = autoPlay();
    autoLabel.append(autoInput, document.createTextNode(' 新回复自动朗读'));

    const injectLabel = document.createElement('label');
    const injectInput = document.createElement('input');
    injectInput.type = 'checkbox';
    injectInput.checked = injectEnabled();
    injectLabel.append(injectInput, document.createTextNode(' 注入对白格式'));

    async function refreshStatus() {
        status.className = '';
        status.textContent = '检查中…';
        voiceHint.textContent = voiceName || '未选文件时用服务自带 voice_03.wav';
        try {
            const response = await fetch(`${apiBase()}/api/v1/health`);
            if (!response.ok) throw new Error(String(response.status));
            status.textContent = 'IndexTTS 在线';
            status.className = 'tad-status-ok';
        } catch {
            status.textContent = 'IndexTTS 未就绪';
            status.className = 'tad-status-down';
        }
    }

    function save() {
        const previous = apiBase();
        localStorage.setItem(STORAGE.api, apiInput.value.trim() || DEFAULT_API);
        localStorage.setItem(STORAGE.enabled, enabledInput.checked ? '1' : '0');
        localStorage.setItem(STORAGE.auto, autoInput.checked ? '1' : '0');
        localStorage.setItem(STORAGE.inject, injectInput.checked ? '1' : '0');
        applyDialoguePrompt();
        if (apiBase() !== previous && voiceName === 'voice_03.wav') {
            voiceBlob = null;
            voiceName = '';
        }
        if (!enabledInput.checked) {
            stopPlayback();
            document.querySelectorAll('.tad-bar').forEach((node) => node.remove());
        } else {
            scan();
        }
        refreshStatus();
    }

    apiInput.addEventListener('change', save);
    enabledInput.addEventListener('change', save);
    autoInput.addEventListener('change', save);
    injectInput.addEventListener('change', save);
    voiceInput.addEventListener('change', () => {
        const file = voiceInput.files && voiceInput.files[0];
        if (!file) return;
        rememberVoice(file, file.name).then(() => {
            voiceHint.textContent = file.name;
        });
    });
    toggle.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
        if (!panel.hidden) refreshStatus();
    });

    panel.append(status, apiLabel, voiceLabel, voiceHint, enabledLabel, autoLabel, injectLabel);
    dock.append(panel, toggle);
    document.body.append(dock);
    refreshStatus();
}

function init() {
    applyDialoguePrompt();
    buildDock();
    const chat = document.querySelector('#chat');
    if (chat) {
        const observer = new MutationObserver(scheduleScan);
        observer.observe(chat, { childList: true, subtree: true, characterData: true });
    }
    scan();

    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, () => {
            speakableGeneration = true;
            scan({ autoLast: autoPlay() });
        });
    }
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, (type) => {
            speakableGeneration = type !== 'quiet';
            applyDialoguePrompt();
        });
    }
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
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
