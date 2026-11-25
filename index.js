import { eventSource, event_types } from '../../../../script.js';

const STORAGE = {
    api: 'tad_api',
    auto: 'tad_auto',
    enabled: 'tad_enabled',
};

const memory = new Map();
let audio = null;
let playToken = 0;
let scanTimer = 0;

function apiBase() {
    return (localStorage.getItem(STORAGE.api) || 'http://127.0.0.1:9881')
        .trim()
        .replace(/\/+$/, '')
        .replace(/\/tts$/, '');
}

function enabled() {
    return localStorage.getItem(STORAGE.enabled) !== '0';
}

function autoPlay() {
    return localStorage.getItem(STORAGE.auto) === '1';
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
        .replace(/\s+/g, ' ')
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
        const line = text.slice(start, end).replace(/^[“"「『\s]+|[”"」』\s]+$/g, '').trim();
        if (!line) continue;
        tagged.push({ speaker, emotion: emotion || 'default', text: line });
    }
    if (tagged.length) return tagged;
    return [{ speaker: 'default', emotion: 'default', text }];
}

function signature(segments) {
    return JSON.stringify(segments);
}

function stopPlayback() {
    playToken += 1;
    if (audio) {
        audio.pause();
        audio = null;
    }
    document.querySelectorAll('.tad-on').forEach((node) => node.classList.remove('tad-on'));
}

async function fetchAudio(segment) {
    const key = `${segment.speaker}\n${segment.emotion}\n${segment.text}`;
    if (memory.has(key)) return memory.get(key);
    let response;
    try {
        response = await fetch(`${apiBase()}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: segment.text,
                speaker: segment.speaker,
                emotion: segment.emotion || 'default',
            }),
        });
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
    const url = await audioUrlFromResponse(response);
    memory.set(key, url);
    return url;
}

async function audioUrlFromResponse(response) {
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
        return URL.createObjectURL(await response.blob());
    }
    const data = await response.json();
    const encoded = data.audio_base64 || data.wav_base64 || data.audio;
    if (!encoded || typeof encoded !== 'string') {
        throw new Error('TTS 返回了 JSON，但没有音频');
    }
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
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
    apiLabel.textContent = 'TTS 服务地址';
    const apiInput = document.createElement('input');
    apiInput.type = 'text';
    apiInput.value = apiBase();
    apiLabel.append(apiInput);

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

    async function refreshStatus() {
        status.className = '';
        status.textContent = '检查中…';
        try {
            const response = await fetch(`${apiBase()}/health`);
            if (!response.ok) throw new Error(String(response.status));
            status.textContent = 'TTS 服务在线';
            status.className = 'tad-status-ok';
        } catch {
            status.textContent = 'TTS 服务未就绪';
            status.className = 'tad-status-down';
        }
    }

    function save() {
        localStorage.setItem(STORAGE.api, apiInput.value.trim() || 'http://127.0.0.1:9881');
        localStorage.setItem(STORAGE.enabled, enabledInput.checked ? '1' : '0');
        localStorage.setItem(STORAGE.auto, autoInput.checked ? '1' : '0');
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
    toggle.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
        if (!panel.hidden) refreshStatus();
    });

    panel.append(status, apiLabel, enabledLabel, autoLabel);
    dock.append(panel, toggle);
    document.body.append(dock);
    refreshStatus();
}

function init() {
    buildDock();
    const chat = document.querySelector('#chat');
    if (chat) {
        const observer = new MutationObserver(scheduleScan);
        observer.observe(chat, { childList: true, subtree: true, characterData: true });
    }
    scan();

    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, () => {
            scan({ autoLast: autoPlay() });
        });
    }
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            stopPlayback();
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
