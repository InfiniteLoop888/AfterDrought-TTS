// IndexedDB 封装：音频缓存（audios）与配置（configs）。
// 全部方法都做了降级——环境不支持 IndexedDB 时返回空值而不是抛错，
// 这样扩展在没有存储能力的内嵌浏览器里也能跑，只是不缓存。

export const audioStore = {
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
