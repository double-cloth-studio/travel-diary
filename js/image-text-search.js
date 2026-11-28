import { getMediaFileUrl } from './utils.js?v=2.1.152';
import { sourceOf } from './zip-stream.mjs';

const CACHE_NAME = 'travel-image-text-v2';
const MAXIMUM_IMAGE_BYTES = 64 * 1024 * 1024;
const results = new Map();
const pending = new Map();
let generation = 0;
let worker;
let serial = Promise.resolve();
let idleTimer;

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
    return Boolean(text && normalizeText(query) && text.includes(normalizeText(query)));
}

export function recordImageTextMatches(record, query, resolve = imageSource) {
    return recordImages(record, resolve).some(image => imageTextMatches(image.key, query));
}

export function clearImageTextCache() {
    generation++;
    results.clear();
    pending.clear();
}

async function createWorker() {
    const base = new URL('assets/ocr/', window.location.href);
    const api = await import(new URL('tesseract.esm.min.js', base).href);
    const engine = await api.default.createWorker('chi_sim+chi_tra+eng', 1, {
        workerPath: new URL('worker.min.js', base).href,
        corePath: base.href,
        langPath: base.href.replace(/\/$/, ''),
        workerBlobURL: false,
        cacheMethod: 'none',
        errorHandler() {}
    });
    await engine.setParameters({ tessedit_pageseg_mode: '11', user_defined_dpi: '300' });
    return engine;
}

function withTimeout(operation, milliseconds, onTimeout = () => {}) {
    let timer;
    return Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => { onTimeout(); reject(new Error('图片文字识别超时')); }, milliseconds);
    })]).finally(() => clearTimeout(timer));
}

async function recognizeImage(blob) {
    clearTimeout(idleTimer);
    try {
        const image = await prepareImage(blob);
        worker ||= createWorker();
        const engine = await withTimeout(worker, 90000).catch(error => { throw Object.assign(error, { engineUnavailable: true }); });
        const { data } = await withTimeout(engine.recognize(image), 60000, () => { void engine.terminate(); });
        return normalizeText(data.text).slice(0, 50000);
    } catch (error) {
        const failed = worker;
        worker = undefined;
        void failed?.then(engine => engine.terminate()).catch(() => {});
        throw error;
    } finally {
        idleTimer = setTimeout(() => {
            const previous = worker;
            worker = undefined;
            void previous?.then(engine => engine.terminate()).catch(() => {});
        }, 30000);
    }
}

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
        if (globalThis.caches && globalThis.crypto?.subtle) {
            const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
            key = new URL(`.cache/image-text/${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`, window.location.href).href;
            cache = await caches.open(CACHE_NAME);
            const saved = await cache.match(key);
            if (saved) return normalizeText(await saved.text()).slice(0, 50000);
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
        const text = await cachedRecognition(await loadImage(image), recognize);
        if (version === generation) results.set(image.key, text);
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
    const active = () => !disposed && input.isConnected && isActive();
    async function scan(version) {
        if (!active() || !input.value.trim() || document.hidden) return;
        const images = [...new Map(getImages().filter(image => image?.key && (image.url || image.source != null)).map(image => [image.key, image])).values()];
        if (!images.length) { status.hidden = true; return; }
        let done = 0;
        let failed = 0;
        status.hidden = false;
        for (const image of images) {
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
        if (event?.isComposing) return;
        if (!input.value.trim()) { status.hidden = true; return; }
        const version = revision;
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
