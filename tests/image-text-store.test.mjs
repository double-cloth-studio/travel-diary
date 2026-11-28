import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createImageTextStore, validateImageSource } from '../js/image-text-store.js';
import { createHandler } from '../js/server.js';
import { captureRecycle } from '../js/recycle-bin.js';
import { installAuth, login } from './helpers/auth.mjs';
import { listenOnFetchSafePort } from './helpers/http.mjs';
import { loadBrowserModule } from './helpers/browser-modules.mjs';
import builder from '../scripts/build-image-text-index.js';

const source = { path: 'data/photos/trip/门票.png' };
async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'travel-ocr-index-'));
    t.after(async () => {
        if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('travel-ocr-index-')) await rm(root, { recursive: true, force: true });
    });
    await mkdir(path.join(root, 'data/photos/trip'), { recursive: true });
    await writeFile(path.join(root, source.path), 'original');
    await writeFile(path.join(root, 'data/travel_data.json'), '[]');
    return root;
}

test('磁盘索引可跨实例读取，空结果有效，变更原图或损坏缓存后失效，旧结果不能回填', async t => {
    const root = await fixture(t);
    const store = createImageTextStore(root);
    const initial = await store.get(source);
    assert.equal(initial.text, null);
    await store.put(source, '杭州西湖', initial.etag);
    const another = createImageTextStore(root);
    assert.equal((await another.get(source)).text, '杭州西湖');
    assert.deepEqual(await another.list(), [{ ...source, text: '杭州西湖', digest: createHash('sha256').update('original').digest('hex') }]);
    await writeFile(path.join(root, source.path), 'replaced');
    assert.equal((await store.get(source)).text, null);
    assert.deepEqual(await store.list(), []);
    await assert.rejects(store.put(source, '旧文字', initial.etag), { status: 409 });
    await store.put(source, '', (await store.get(source)).etag);
    assert.equal((await store.get(source)).text, '');
    const [cache] = await readdir(path.join(root, '.cache/image-text'));
    await writeFile(path.join(root, '.cache/image-text', cache), '{损坏');
    assert.equal((await store.get(source)).text, null);
    assert.deepEqual(await store.list(), []);
    await store.put(source, '修复', (await store.get(source)).etag);
    await unlink(path.join(root, source.path));
    assert.deepEqual(await store.list(), []);
});

test('拒绝路径穿越、视频、外部符号链接和过长文字', async t => {
    for (const value of ['../outside.png', 'data/photos/a/../secret.png', 'data/photos/.hidden.png',
        'data/photos/a\\b.png', 'data/photos/a:secret.png', 'data/videos/a.mp4', 'data/profile/auth.png']) {
        assert.throws(() => validateImageSource({ path: value }));
    }
    assert.throws(() => validateImageSource({ ...source, id: '../outside' }));
    const root = await fixture(t);
    const external = await fixture(t);
    const store = createImageTextStore(root);
    const version = (await store.get(source)).etag;
    await assert.rejects(store.put(source, 'a'.repeat(50001), version), { status: 422 });
    await mkdir(path.join(root, '.cache'));
    await symlink(external, path.join(root, '.cache/image-text'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.put(source, '禁止', version), { status: 403 });
    assert.equal(await readFile(path.join(external, source.path), 'utf8'), 'original');
});

test('批量收集覆盖引用与未引用图片和回收版本；有效索引不启动浏览器，缺图按选项报告', async t => {
    const root = await fixture(t);
    await writeFile(path.join(root, 'data/travel_data.json'), JSON.stringify([{ record_id: `r-${'1'.repeat(32)}`, photo_folder: 'data/photos/trip', photos: ['missing.png'] }]));
    const id = await captureRecycle(root, { title: '旧版本', files: [source] });
    const images = await builder.collectImages(root);
    assert.deepEqual(images, [source, { path: 'data/photos/trip/missing.png' }, { ...source, id }]);
    const store = createImageTextStore(root);
    for (const item of [source, { ...source, id }]) await store.put(item, '', (await store.get(item)).etag);
    const result = await builder.buildImageTextIndex(root, { skipMissing: true, browser: '不存在的浏览器', log() {} });
    assert.deepEqual(result, { generated: 0, cached: 2, failed: 0, skipped: 1 });
    const failed = await builder.buildImageTextIndex(root, { log() {} });
    assert.deepEqual(failed, { generated: 0, cached: 2, failed: 1, skipped: 0 });
});

test('HTTP 批量读取只返回当前图，缓存回传要求同源和版本；回收文字沿用认证保护', async t => {
    const root = await fixture(t);
    await installAuth(root);
    const id = await captureRecycle(root, { title: '旧版本', files: [source] });
    const store = createImageTextStore(root);
    await store.put({ ...source, id }, '回收独有文字', (await store.get({ ...source, id })).etag);
    const server = http.createServer(createHandler(root, { generateMediaPreviews: false }));
    const base = await listenOnFetchSafePort(server);
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const endpoint = `${base}/.cache/image-text/file?path=${encodeURIComponent(source.path)}`;
    const initial = await (await fetch(endpoint)).json();
    assert.equal(initial.text, null);
    const put = (origin, etag, text = '西湖') => fetch(endpoint, { method: 'PUT',
        headers: { Origin: origin, 'Content-Type': 'text/plain; charset=utf-8', 'If-Match': etag }, body: text });
    assert.equal((await put('https://other.example', initial.etag)).status, 403);
    assert.equal((await put(base, 'outdated')).status, 409);
    assert.equal((await put(base, initial.etag)).status, 204);
    const entries = await (await fetch(`${base}/.cache/image-text/index.json`)).json();
    assert.equal(entries.entries.length, 1);
    assert.equal(entries.entries[0].text, '西湖');
    assert.equal(entries.entries[0].id, undefined);
    assert.equal((await fetch(`${base}/api/travel-data?mode=recycle-bin`)).status, 401);
    const auth = await login(base);
    const recycled = await (await fetch(`${base}/api/travel-data?mode=recycle-bin`, { headers: { Cookie: auth.cookie } })).json();
    assert.equal(recycled.imageText[0].text, '回收独有文字');
    assert.equal(recycled.imageText[0].id, id);
    const cache = (await readdir(path.join(root, '.cache/image-text')))[0];
    assert.equal((await fetch(`${base}/.cache/image-text/${cache}`)).status, 403);
});

test('浏览器并发预载只读取一份文本索引，首次匹配不读取原图；清缓存阻止旧索引回填', async t => {
    const module = await loadBrowserModule(new URL('../js/image-text-search.js', import.meta.url));
    const previousWindow = globalThis.window;
    globalThis.window = { location: { href: 'http://localhost/diary/', origin: 'http://localhost' } };
    t.after(() => { globalThis.window = previousWindow; });
    let requests = 0;
    let finish;
    t.mock.method(globalThis, 'fetch', async url => {
        requests++;
        assert.equal(String(url), 'http://localhost/diary/.cache/image-text/index.json');
        return new Response(JSON.stringify({ entries: [{ ...source, text: '杭 州 西 湖 ＯＣＲ' }] }));
    });
    module.clearImageTextCache();
    await Promise.all([module.preloadImageTextIndex(), module.preloadImageTextIndex()]);
    assert.equal(requests, 1);
    assert.ok(module.recordImageTextMatches({ photo_folder: 'data/photos/trip', photos: ['门票.png'] }, '西湖 ocr'));
    await module.indexImageText(module.imageSource(source.path), () => { throw new Error('不应启动 OCR'); });
    assert.equal(requests, 1);
    module.clearImageTextCache();
    t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { finish = resolve; }));
    const old = module.preloadImageTextIndex();
    module.clearImageTextCache();
    finish(new Response(JSON.stringify({ entries: [{ ...source, text: '旧文字' }] })));
    await old;
    assert.equal(module.imageTextMatches(module.imageSource(source.path).key, '旧文字'), false);
});

test('单图磁盘命中不读取原图或启动 Worker，ZIP 按内容摘要复用已预载文字', async t => {
    const module = await loadBrowserModule(new URL('../js/image-text-search.js', import.meta.url));
    const previousWindow = globalThis.window;
    globalThis.window = { location: { href: 'http://localhost/diary/', origin: 'http://localhost' } };
    t.after(() => { globalThis.window = previousWindow; });
    module.clearImageTextCache();
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async url => {
        requests++;
        const parsed = new URL(url);
        assert.equal(parsed.pathname, '/diary/.cache/image-text/file');
        assert.equal(parsed.searchParams.get('path'), source.path);
        return new Response(JSON.stringify({ text: '磁盘已有西湖', etag: 'version' }));
    });
    await module.indexImageText(module.imageSource(source.path));
    assert.equal(requests, 1);
    assert.ok(module.imageTextMatches(module.imageSource(source.path).key, '西湖'));
    const digest = createHash('sha256').update('same image').digest('hex');
    await module.loadImageTextEntries([{ ...source, text: '内容摘要命中', digest }]);
    await module.indexImageText({ key: 'zip:ticket.png', source: new Blob(['same image']) }, () => { throw new Error('不应重复识别 ZIP 中的相同图片'); });
    assert.ok(module.imageTextMatches('zip:ticket.png', '摘要'));
    assert.equal(requests, 1);
});
