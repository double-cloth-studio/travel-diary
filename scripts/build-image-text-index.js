const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createImageTextStore, validateImageSource, MAXIMUM_TEXT_BYTES } = require('../js/image-text-store.js');
const { ordinaryPath } = require('../js/record-inventory.js');
const { findBrowser } = require('./build-media-previews.js');
const { loadRuntimeConfig } = require('../js/runtime-config.js');
const { createHandler } = require('../js/server.js');

function resolveWorkerCount(requested, resources = {}) {
    if (requested != null && (!Number.isInteger(requested) || requested < 1 || requested > 8)) {
        throw new Error('--workers 必须是 1 到 8 之间的整数。');
    }
    const parallelism = resources.parallelism ?? os.availableParallelism();
    // 保留浏览器与系统空间，每个 OCR Worker 按 1 GiB 预算；容器优先采用可用内存限制。
    const memory = resources.memory ?? Math.min(os.freemem(), process.availableMemory?.() ?? os.freemem());
    const memoryLimit = Math.max(1, Math.floor((memory - 512 * 1024 ** 2) / 1024 ** 3));
    return Math.max(1, Math.min(requested ?? 4, requested == null ? parallelism - 1 : parallelism, memoryLimit));
}

async function collectImages(root) {
    const images = new Map();
    const add = source => { validateImageSource(source); images.set(JSON.stringify(source), source); };
    async function walk(directory) {
        let file;
        try { file = await ordinaryPath(root, directory, true); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const item of await fs.readdir(file, { withFileTypes: true })) {
            const name = `${directory}/${item.name}`;
            if (item.isSymbolicLink()) throw new Error(`图片目录不能包含符号链接：${name}`);
            if (item.isDirectory()) await walk(name);
            else if (/\.(png|jpe?g|webp|gif|avif|heic|heif|bmp)$/i.test(item.name)) add({ path: name });
        }
    }
    await walk('data/photos');
    try {
        const records = JSON.parse(await fs.readFile(await ordinaryPath(root, 'data/travel_data.json'), 'utf8'));
        if (!Array.isArray(records)) throw new Error('旅行索引必须是数组。');
        for (const record of records) {
            if (record.photo_folder) for (const name of record.photos || []) add({ path: `${record.photo_folder}/${name}` });
        }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await ordinaryPath(root, 'data/profile/profile-picture.png'); add({ path: 'data/profile/profile-picture.png' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const recycled = await require('../js/recycle-bin.js').readRecycleBin(root);
    for (const item of recycled.items) for (const file of item.files) {
        if (/^data\/(photos\/|profile\/profile-picture\.png$)/.test(file.path)
            && /\.(png|jpe?g|webp|gif|avif|heic|heif|bmp)$/i.test(file.path)) add({ path: file.path, id: item.id });
    }
    return [...images.values()];
}

async function buildImageTextIndex(root, options = {}) {
    const workerCount = resolveWorkerCount(options.workers);
    root = await fs.realpath(root);
    const store = createImageTextStore(root);
    const log = options.log || console.log;
    const result = { generated: 0, cached: 0, failed: 0, skipped: 0 };
    const images = await collectImages(root);
    const items = [];
    const cachedContent = new Map();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, images.length) }, async () => {
        while (next < images.length) {
            const source = images[next++];
            try {
                const cached = await store.get(source);
                if (cached.text !== null && !options.force) {
                    result.cached++;
                    cachedContent.set(cached.digest, cached.text);
                    continue;
                }
                items.push({ ...source, etag: cached.etag });
            } catch (error) {
                if (error.code === 'ENOENT' && options.skipMissing) {
                    result.skipped++; log(`跳过缺失原图：${source.path}`);
                } else { result.failed++; log(`索引失败：${source.path}；${error.message}`); }
            }
        }
    }));
    if (!items.length) return result;
    const workers = Math.min(workerCount, items.length);
    const started = Date.now();
    log(`准备索引 ${items.length} 张图片，使用 ${workers} 个并行 Worker；相同内容复用识别结果。`);
    const config = loadRuntimeConfig(root).mediaPreviews;
    const browserPath = await findBrowser(options.browser || process.env.TRAVEL_BROWSER_PATH || config.browserPath);
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-ocr-browser-'));
    const session = `/__image-text-${randomBytes(16).toString('hex')}/`;
    const handler = createHandler(path.resolve(__dirname, '..'), { writeMode: 'local', allowedOrigins: [], generateMediaPreviews: false });
    let browser, timer, resolveDone, rejectDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    const completed = new Set();
    const heartbeat = () => {
        clearTimeout(timer);
        timer = setTimeout(() => rejectDone(new Error('浏览器超过 180 秒没有报告进度，已停止索引。')), 180000);
    };
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            if (req.method === 'GET' && url.pathname === session) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
                    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'" });
                res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>构建图片文字索引</title><script type="module" src="./batch.mjs"></script></html>');
            } else if (req.method === 'GET' && url.pathname === session + 'batch.mjs') {
                res.writeHead(200, { 'Content-Type': 'text/javascript' });
                res.end(await fs.readFile(path.join(__dirname, 'image-text-batch.mjs')));
            } else if (req.method === 'GET' && url.pathname === session + 'manifest') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ workers, items: items.map((item, index) => ({ index, source: `./source?index=${index}` })),
                    cached: [...cachedContent].map(([digest, text]) => ({ digest, text })) }));
            } else if (req.method === 'GET' && url.pathname === session + 'source') {
                const index = Number(url.searchParams.get('index'));
                if (!Number.isInteger(index) || !items[index]) throw new Error('图片序号无效。');
                const item = items[index];
                const located = await store.get(item);
                if (located.etag !== item.etag) throw new Error('图片已变化。');
                const stat = await fs.stat(located.file);
                if (stat.size > 64 * 1024 * 1024) throw new Error('图片超过 64 MiB，无法识别。');
                res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size });
                await pipeline(createReadStream(located.file), res);
            } else if (req.method === 'POST' && [session + 'progress', session + 'error', session + 'complete'].includes(url.pathname)) {
                let size = 0;
                const chunks = [];
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > MAXIMUM_TEXT_BYTES) throw new Error('索引报告过大。');
                    chunks.push(chunk);
                }
                const body = Buffer.concat(chunks).toString('utf8');
                if (url.pathname.endsWith('/error')) throw new Error(body);
                if (url.pathname.endsWith('/complete')) {
                    if (completed.size !== items.length) throw new Error('仍有图片未完成。');
                    res.writeHead(204); res.end(); resolveDone(result); return;
                }
                const report = JSON.parse(body);
                if (!Number.isInteger(report.index) || !items[report.index] || completed.has(report.index)) throw new Error('索引报告无效。');
                const item = items[report.index];
                if (typeof report.text === 'string') {
                    try { await store.put(item, report.text, item.etag); result.generated++; }
                    catch (error) { report.message = error.message; result.failed++; }
                } else result.failed++;
                completed.add(report.index);
                const elapsed = (Date.now() - started) / 1000;
                const remaining = Math.ceil(elapsed / completed.size * (items.length - completed.size));
                log(`[${completed.size}/${items.length}] ${report.message ? '失败' : '已索引'}：${item.id ? `回收站 ${item.id}/` : ''}${item.path}${report.message ? `；${report.message}` : ''}（已用 ${Math.round(elapsed)} 秒，预计剩余 ${remaining} 秒）`);
                res.writeHead(204); res.end(); heartbeat();
            } else if (req.method === 'GET' && (/^\/js\/[a-z0-9.-]+$/i.test(url.pathname) || /^\/assets\/ocr\/[a-z0-9_.-]+$/i.test(url.pathname))) {
                await handler(req, res);
            } else { res.writeHead(404); res.end(); }
        } catch (error) {
            if (!res.headersSent) res.writeHead(500);
            res.end('图片索引任务失败。');
            // 单张原图读取失败交由浏览器记录并继续，其他错误终止本轮。
            if (new URL(req.url, 'http://localhost').pathname !== session + 'source') rejectDone(error);
        }
    });
    const cancel = () => rejectDone(new Error('已取消图片文字索引。'));
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        heartbeat();
        browser = spawn(browserPath, ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
            `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}${session}`], { windowsHide: true, stdio: 'ignore' });
        browser.once('error', rejectDone);
        browser.once('exit', code => rejectDone(new Error(`浏览器提前退出（${code}）。`)));
        return await done;
    } finally {
        clearTimeout(timer);
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
        if (browser && browser.exitCode === null && browser.pid) await new Promise(resolve => { browser.once('exit', resolve); browser.kill(); });
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        // 只清理本命令创建的临时浏览器配置，并核对绝对路径范围。
        if (path.dirname(profile) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('travel-ocr-browser-')) {
            await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
        console.log('用法：npm run media:ocr -- [--dir 项目目录] [--browser 浏览器路径或目录] [--workers 1-8] [--skip-missing] [--force]\n使用已有 Edge / Chrome 离线识别简繁中文和英文，索引保存在 .cache/image-text/。包括当前图片、未引用图片、头像和回收站版本；有效索引自动跳过，相同内容只识别一次。默认按 CPU 和可用内存选择最多 4 个并行 Worker，--workers 指定并发上限（仍受 CPU 和内存约束）；--workers 1 使用串行模式。--force 强制重建，--skip-missing 跳过缺失原图。浏览器沿用 mediaPreviews.browserPath 与 TRAVEL_BROWSER_PATH 配置。');
        return;
    }
    const options = {};
    let root = path.resolve(__dirname, '..');
    while (args.length) {
        const arg = args.shift();
        if (arg === '--skip-missing') options.skipMissing = true;
        else if (arg === '--force') options.force = true;
        else if (['--dir', '--browser', '--workers'].includes(arg) && args.length && !args[0].startsWith('--')) {
            const value = args.shift();
            if (arg === '--dir') root = path.resolve(value);
            else if (arg === '--workers') options.workers = /^\d+$/.test(value) ? Number(value) : NaN;
            else options.browser = value;
        } else throw new Error(`未知参数或缺少参数值：${arg}`);
    }
    const result = await buildImageTextIndex(root, options);
    console.log(`图片文字索引完成：新生成 ${result.generated} 项，有效缓存 ${result.cached} 项，跳过 ${result.skipped} 项，失败 ${result.failed} 项。`);
    if (result.failed) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildImageTextIndex, collectImages, resolveWorkerCount };
