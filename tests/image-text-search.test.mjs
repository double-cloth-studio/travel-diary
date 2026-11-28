import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadBrowserModule } from './helpers/browser-modules.mjs';
import { normalizeTravelLocation } from '../js/location.mjs';
import { buildRecycleTree } from '../js/recycle-tree.mjs';

const { imageSource, recordImages, recordImageTextMatches, imageTextMatches, indexImageText, clearImageTextCache } =
    await loadBrowserModule(new URL('../js/image-text-search.js', import.meta.url));

test('同图并发共享任务，中文断字、全角字符和英文大小写可搜索，空关键词不命中', async () => {
    clearImageTextCache();
    const image = { key: 'one', source: new Blob(['图片一']) };
    let calls = 0;
    const recognize = async () => { calls++; return '杭 州 西 湖\n ＯＣＲ Search ８６７５３０９'; };
    await Promise.all([indexImageText(image, recognize), indexImageText(image, recognize)]);
    assert.equal(calls, 1);
    for (const query of ['杭州西湖', '西 湖', 'OCR SEARCH', '8675309', '８６７５３０９']) assert.ok(imageTextMatches('one', query), query);
    assert.equal(imageTextMatches('one', ''), false);
    assert.equal(imageTextMatches('one', '山间'), false);
    const record = { photo_folder: 'data/photos/one', photos: ['ticket.png'] };
    assert.ok(recordImageTextMatches(record, '西湖', () => image));
    assert.deepEqual(recordImages({}), []);
    assert.equal(imageSource('data/photos/one/门票.png').key, 'data/photos/one/%E9%97%A8%E7%A5%A8.png');
});

test('识别失败可以重试；无文字图片保留空结果，不反复识别', async () => {
    clearImageTextCache();
    const image = { key: 'empty', source: new Blob(['图片']) };
    await assert.rejects(indexImageText(image, async () => { throw new Error('无法识别'); }), /无法识别/);
    let calls = 0;
    await indexImageText(image, async () => { calls++; return ''; });
    await indexImageText(image, async () => { calls++; return '错误的重复识别'; });
    assert.equal(calls, 1);
    assert.equal(imageTextMatches(image.key, '错误'), false);
});

test('清除缓存阻止旧请求回填，同名的当前、备份和回收图片各自匹配', async () => {
    clearImageTextCache();
    let finish;
    const current = { key: 'current:ticket.png', source: new Blob(['当前图片']) };
    const old = indexImageText(current, () => new Promise(resolve => { finish = resolve; }));
    while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
    clearImageTextCache();
    finish('旧的文字');
    await old;
    assert.equal(imageTextMatches(current.key, '旧的'), false);
    await indexImageText(current, async () => '现在的文字');
    await indexImageText({ ...current, key: 'backup:ticket.png' }, async () => '备份中的文字');
    await indexImageText({ ...current, key: 'recycle:ticket.png' }, async () => '回收的文字');
    assert.ok(imageTextMatches(current.key, '现在'));
    assert.ok(imageTextMatches('backup:ticket.png', '备份'));
    assert.ok(imageTextMatches('recycle:ticket.png', '回收'));
    assert.equal(imageTextMatches(current.key, '备份'), false);
});

test('持久缓存按内容复用，同路径图片被替换后重新识别，缓存不可用时仍可搜索', async t => {
    clearImageTextCache();
    t.mock.method(globalThis, 'fetch', async () => new Response('站点图片'));
    const store = new Map();
    const previousWindow = globalThis.window;
    const previousCaches = globalThis.caches;
    globalThis.window = { location: { href: 'http://localhost/diary/', origin: 'http://localhost' } };
    globalThis.caches = { open: async () => ({
        match: async key => store.get(key)?.clone(),
        put: async (key, value) => store.set(key, value),
        keys: async () => [...store.keys()], delete: async key => store.delete(key)
    }) };
    t.after(() => { globalThis.window = previousWindow; globalThis.caches = previousCaches; });
    let calls = 0;
    const recognize = async blob => { calls++; return await blob.text(); };
    await indexImageText({ key: 'a', source: new Blob(['西湖门票']) }, recognize);
    await indexImageText({ key: 'b', source: new Blob(['西湖门票']) }, recognize);
    assert.equal(calls, 1);
    clearImageTextCache();
    await indexImageText({ key: 'a', source: new Blob(['山间散步']) }, recognize);
    assert.equal(calls, 2);
    assert.equal(imageTextMatches('a', '西湖'), false);
    assert.ok(imageTextMatches('a', '山间'));
    globalThis.caches = { open: async () => { throw new Error('存储受限'); } };
    await indexImageText({ key: 'url', url: 'data/photos/a.png' }, recognize);
    assert.ok(imageTextMatches('url', '站点图片'));
    await assert.rejects(indexImageText({ key: 'external', url: 'https://example.com/a.png' }, recognize), /当前站点/);
});

test('离线 OCR 分发文件完整，模型、脚本和各 WASM 回退均与固定来源校验一致', async () => {
    const manifest = JSON.parse(await readFile(new URL('../assets/ocr/sources.json', import.meta.url), 'utf8'));
    for (const entry of manifest) {
        const bytes = await readFile(new URL(`../assets/ocr/${entry.file}`, import.meta.url));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.file);
    }
    for (const file of ['worker.min.js', 'tesseract.esm.min.js', 'chi_sim.traineddata.gz', 'chi_tra.traineddata.gz', 'eng.traineddata.gz',
        'tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
        assert.ok(manifest.some(entry => entry.file === file), file);
    }
});

test('图片独有关键词同时命中笔记、完整行程和所属归档地点，回收树标记图片归属', async () => {
    clearImageTextCache();
    const previousDocument = globalThis.document;
    globalThis.document = { addEventListener() {} };
    let app;
    try {
        app = await loadBrowserModule(new URL('../js/app.js', import.meta.url), `
export function findImageFixtures(records, query) {
    const previous = travelModel;
    travelModel = deriveTravelModel(records);
    try {
        const notes = getLedgerRecords({ q: query });
        return { notes, trips: getLedgerTrips(notes), countries: getArchiveCountries(query) };
    } finally { travelModel = previous; }
}`);
    } finally { globalThis.document = previousDocument; }
    const records = ['北京市', '上海市'].map((place, index) => normalizeTravelLocation({
        record_id: `r-${String(index + 1).repeat(32)}`, date: `2026-11-0${index + 1}`, trip_id: 'same-trip',
        country: 'CN', admin_area: place, locality: place, desc_md: `data/travel-diary/2026/${index}.md`,
        descTitle: `日记${index}`, searchText: '', photo_folder: 'data/photos/demo', photos: [`${index}.png`]
    }));
    const image = imageSource('data/photos/demo/0.png');
    await indexImageText({ ...image, source: new Blob(['第一张图片']) }, async () => '西湖门票');
    const result = app.findImageFixtures(records, '西湖');
    assert.equal(result.notes.length, 1);
    assert.equal(result.notes[0].descTitle, '日记0');
    assert.equal(result.trips.length, 1);
    assert.equal(result.trips[0].tripRecords.length, 2);
    assert.equal(result.countries.length, 1);
    assert.equal(result.countries[0].areas.length, 1);
    assert.equal(result.countries[0].areas[0].adminArea, '北京市');
    const tree = buildRecycleTree([{ path: 'data/photos/demo/0.png', size: 1 }], '西湖', {
        mediaKind: () => 'image', matchesFile: () => imageTextMatches(image.key, '西湖')
    });
    assert.equal(tree.get('').matches, true);
});
