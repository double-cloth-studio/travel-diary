import { getMediaFileUrl } from './utils.js?v=2.1.153';
import { sourceOf } from './zip-stream.mjs';

const CACHE_NAME = 'travel-image-text-v2';
const MAXIMUM_IMAGE_BYTES = 64 * 1024 * 1024;
const results = new Map();
const pending = new Map();
const contentResults = new Map();
let generation = 0;
let preloaded;
let serial = Promise.resolve();

function normalizeText(text) {
    return String(text || '').normalize('NFKC').toLowerCase()
        .replace(/\s+/g, ' ').replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1').trim();
}

export function imageSource(name) {
    const url = getMediaFileUrl(name);
    return { key: url, url };
}

export function recordImages(record, resolve = imageSource) {
    return record.photo_folder ? (record.photos || []).map(name => resolve(`${record.photo_folder}/${name}`)) : [];
}

export function imageTextMatches(key, query) {
    const text = results.get(key);
    if (!text) return false;
    const normalized = normalizeText(query);
    return Boolean(normalized && text.includes(normalized));
}

export function recordImageTextMatches(record, query, resolve = imageSource) {
    return recordImages(record, resolve).some(image => imageTextMatches(image.key, query));
}

export function clearImageTextCache() {
    generation++;
    results.clear();
    pending.clear();
    contentResults.clear();
    preloaded = undefined;
}

export async function preloadImageTextIndex() {
    if (preloaded) return preloaded;
    const version = generation;
    preloaded = (async () => {
        try {
            const response = await fetch(new URL('.cache/image-text/index.json', window.location.href), {
                credentials: 'same-origin', signal: AbortSignal.timeout(20000)
            });
            if (!response.ok) return;
            const data = await response.json();
            if (Array.isArray(data.entries)) await loadImageTextEntries(data.entries, version);
        } catch { /* 旧服务或缓存不可用时保留按需识别。 */ }
    })();
    return preloaded;
}

export async function loadImageTextEntries(entries, version = generation) {
    for (let index = 0; index < entries.length; index++) {
        if (version !== generation) return;
        const entry = entries[index];
        if (typeof entry.path !== 'string' || typeof entry.text !== 'string') continue;
        let key = imageSource(entry.path).key;
        if (entry.id) {
            const url = new URL('api/travel-data?mode=recycle-file', window.location.href);
            url.searchParams.set('id', entry.id);
            url.searchParams.set('path', entry.path);
            key = url.href;
        }
        const text = normalizeText(entry.text).slice(0, 50000);
        results.set(key, text);
        if (/^[a-f0-9]{64}$/.test(entry.digest)) contentResults.set(entry.digest, text);
        // 大索引分段入内存，避免阻塞输入和首屏绘制。
        if (index % 100 === 99) {
            if (globalThis.scheduler?.yield) await scheduler.yield();
            else await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
}

async function createWorker() {
    const base = new URL('../assets/ocr/', import.meta.url);
    const api = await import(new URL('tesseract.esm.min.js', base).href);
    const engine = await api.default.createWorker('chi_sim+chi_tra+eng', 1, {
        workerPath: new URL('worker.min.js', base).href,
        corePath: base.href,
        langPath: base.href.replace(/\/$/, ''),
        workerBlobURL: false,
        cacheMethod: 'none',
        errorHandler() {}
    });
    try {
        await engine.setParameters({ tessedit_pageseg_mode: '11', user_defined_dpi: '300' });
        return engine;
    } catch (error) {
        await engine.terminate();
        throw error;
    }
}

function withTimeout(operation, milliseconds, onTimeout = () => {}) {
    let timer;
    return Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => { onTimeout(); reject(new Error('图片文字识别超时')); }, milliseconds);
    })]).finally(() => clearTimeout(timer));
}

// 每个批量槽位独占并复用一个 Worker，网页按需识别仍使用单个实例。
export function createImageTextRecognizer() {
    let worker;
    let idleTimer;
    const terminate = () => {
        clearTimeout(idleTimer);
        const previous = worker;
        worker = undefined;
        return previous?.then(engine => engine.terminate()).catch(() => {});
    };
    return {
        terminate,
        async recognize(blob) {
            clearTimeout(idleTimer);
            let image;
            try {
                image = await prepareImage(blob);
                worker ||= createWorker();
                const engine = await withTimeout(worker, 90000).catch(error => { throw Object.assign(error, { engineUnavailable: true }); });
                const { data } = await withTimeout(engine.recognize(image), 60000, () => { void engine.terminate(); });
                return normalizeText(data.text).slice(0, 50000);
            } catch (error) {
                void terminate();
                throw error;
            } finally {
                // 及时释放大画布，避免并行任务积累上一张图片的像素缓冲。
                if (image) { image.width = 1; image.height = 1; }
                idleTimer = setTimeout(terminate, 30000);
            }
        }
    };
}

const recognizer = createImageTextRecognizer();
export const recognizeImage = blob => recognizer.recognize(blob);

async function prepareImage(blob) {
    let image;
    let url;
    try {
        if (typeof createImageBitmap === 'function') image = await createImageBitmap(blob);
        else {
            image = new Image();
            url = URL.createObjectURL(blob);
            image.src = url;
            await withTimeout(image.decode(), 20000);
        }
        const width = image.width || image.naturalWidth;
        const height = image.height || image.naturalHeight;
        const scale = Math.min(1, 3072 / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d', { alpha: false });
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas;
    } finally {
        image?.close?.();
        if (url) URL.revokeObjectURL(url);
    }
}

async function loadImage(image) {
    if (image.source != null) {
        const source = sourceOf(image.source);
        if (source.size > MAXIMUM_IMAGE_BYTES) throw new Error('图片过大');
        const chunks = [];
        for await (const chunk of source.chunks()) chunks.push(chunk);
        return new Blob(chunks);
    }
    const url = new URL(image.url, window.location.href);
    if (url.origin !== window.location.origin) throw new Error('仅识别当前站点的图片');
    const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('图片读取失败');
    if (Number(response.headers.get('Content-Length')) > MAXIMUM_IMAGE_BYTES) throw new Error('图片过大');
    const blob = await response.blob();
    if (blob.size > MAXIMUM_IMAGE_BYTES) throw new Error('图片过大');
    return blob;
}

// 按图片内容保存识别结果，同路径替换、备份版本和回收版本不会串用旧文字。
async function cachedRecognition(blob, recognize) {
    let cache;
    let key;
    try {
        if (globalThis.crypto?.subtle) {
            const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
            const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
            if (contentResults.has(hash)) return contentResults.get(hash);
            key = new URL(`.cache/image-text/${hash}`, window.location.href).href;
            if (globalThis.caches) {
                cache = await caches.open(CACHE_NAME);
                const saved = await cache.match(key);
                if (saved) return normalizeText(await saved.text()).slice(0, 50000);
            }
        }
    } catch { /* 缓存受限时继续在内存中识别。 */ }
    const text = normalizeText(await recognize(blob)).slice(0, 50000);
    if (cache && key) {
        try {
            await cache.put(key, new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
            const keys = await cache.keys();
            for (const old of keys.slice(0, Math.max(0, keys.length - 2048))) await cache.delete(old);
        } catch { /* 磁盘缓存失败不影响搜索。 */ }
    }
    return text;
}

export async function indexImageText(image, recognize = recognizeImage) {
    if (results.has(image.key)) return;
    if (pending.has(image.key)) return pending.get(image.key);
    const version = generation;
    const task = serial.catch(() => {}).then(async () => {
        if (version !== generation) return;
        let disk;
        let endpoint;
        if (recognize === recognizeImage && image.source == null) {
            try {
                const url = new URL(image.url, window.location.href);
                const base = new URL('.', window.location.href);
                const relative = decodeURIComponent(url.pathname.slice(base.pathname.length));
                if (url.origin === base.origin && url.pathname.startsWith(base.pathname) && /^data\/(photos\/|profile\/)/.test(relative)) {
                    endpoint = new URL('.cache/image-text/file', base);
                    endpoint.searchParams.set('path', relative);
                    const response = await fetch(endpoint, { credentials: 'same-origin', signal: AbortSignal.timeout(20000) });
                    if (response.ok) disk = await response.json();
                }
            } catch { /* 索引服务不可用时仍可本地识别。 */ }
            if (version !== generation) return;
            if (typeof disk?.text === 'string') { results.set(image.key, normalizeText(disk.text)); return; }
        }
        const text = await cachedRecognition(await loadImage(image), recognize);
        if (version === generation) {
            results.set(image.key, text);
            if (endpoint && disk?.etag) {
                try {
                    await fetch(endpoint, { method: 'PUT', credentials: 'same-origin',
                        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'If-Match': disk.etag },
                        body: text, signal: AbortSignal.timeout(20000) });
                } catch { /* 磁盘写入失败不影响本次搜索。 */ }
            }
        }
    });
    serial = task;
    pending.set(image.key, task);
    try { await task; }
    finally { if (pending.get(image.key) === task) pending.delete(image.key); }
}

// 输入框保持原节点，识别只刷新结果区，不夺取焦点或改变已有勾选。
export function createImageTextSearch(input, { getImages, onUpdate, isActive = () => true }) {
    const status = document.createElement('p');
    status.className = 'image-text-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    (input.closest('.ledger-controls') || input.parentElement).insertAdjacentElement('afterend', status);
    let revision = 0;
    let timer;
    let disposed = false;
    let hydrated = false;
    const active = () => !disposed && input.isConnected && isActive();
    async function scan(version) {
        if (!active() || !input.value.trim() || document.hidden) return;
        const images = [...new Map(getImages().filter(image => image?.key && (image.url || image.source != null)).map(image => [image.key, image])).values()];
        if (!images.length) { status.hidden = true; return; }
        const missing = images.filter(image => !results.has(image.key));
        if (!missing.length) {
            status.hidden = false;
            status.textContent = `已检索 ${images.length} 张图片的文字`;
            return;
        }
        let done = images.length - missing.length;
        let failed = 0;
        status.hidden = false;
        for (const image of missing) {
            if (!active() || version !== revision || document.hidden) return;
            status.textContent = `正在识别图片文字 ${done} / ${images.length}…`;
            const existed = results.has(image.key);
            try { await indexImageText(image); }
            catch (error) {
                failed++;
                if (error.engineUnavailable) {
                    if (active() && version === revision) status.textContent = '图片文字识别暂不可用，请刷新后重试；仍可搜索原有文字。';
                    return;
                }
            }
            done++;
            if (!active() || version !== revision) return;
            if (!existed && imageTextMatches(image.key, input.value)) onUpdate();
        }
        if (!active() || version !== revision) return;
        onUpdate();
        status.textContent = failed ? `图片文字识别完成，${failed} 张未能识别；重新搜索可重试。` : `已检索 ${done} 张图片的文字`;
    }
    function refresh(event) {
        clearTimeout(timer);
        revision++;
        const version = revision;
        void preloadImageTextIndex().then(() => {
            if (active() && version === revision && !hydrated) {
                hydrated = true;
                if (input.value.trim()) onUpdate();
            }
        });
        if (event?.isComposing) return;
        if (!input.value.trim()) { status.hidden = true; return; }
        timer = setTimeout(() => { void scan(version); }, 250);
    }
    input.addEventListener('input', refresh);
    input.addEventListener('compositionend', refresh);
    document.addEventListener('visibilitychange', refresh);
    return {
        refresh,
        dispose() {
            disposed = true;
            revision++;
            clearTimeout(timer);
            input.removeEventListener('input', refresh);
            input.removeEventListener('compositionend', refresh);
            document.removeEventListener('visibilitychange', refresh);
            status.remove();
        }
    };
}
