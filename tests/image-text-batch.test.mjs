import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { processImageTextBatch } from '../scripts/image-text-batch.mjs';
import { resolveWorkerCount } from '../scripts/build-image-text-index.js';

const items = count => Array.from({ length: count }, (_, index) => ({ index }));
const pause = () => new Promise(resolve => setTimeout(resolve, 2));

test('并发数受 CPU 和可用内存约束，保留串行选项并拒绝无效参数', () => {
    const resources = { parallelism: 16, memory: 16 * 1024 ** 3 };
    assert.equal(resolveWorkerCount(undefined, resources), 4);
    assert.equal(resolveWorkerCount(8, resources), 8);
    assert.equal(resolveWorkerCount(1, resources), 1);
    assert.equal(resolveWorkerCount(undefined, { ...resources, parallelism: 1 }), 1);
    assert.equal(resolveWorkerCount(undefined, { ...resources, parallelism: 2 }), 1);
    assert.equal(resolveWorkerCount(8, { ...resources, parallelism: 2 }), 2);
    assert.equal(resolveWorkerCount(8, { ...resources, memory: 2 * 1024 ** 3 }), 1);
    assert.equal(resolveWorkerCount(undefined, { ...resources, memory: 300 * 1024 ** 2 }), 1);
    for (const value of [0, -1, 9, 1.5, NaN, '4']) assert.throws(() => resolveWorkerCount(value, resources), /--workers/);
});

test('批量识别真正并行，复用有限 Worker，完整保存乱序结果并释放资源', async () => {
    let active = 0, peak = 0, created = 0, terminated = 0;
    const saved = [];
    await processImageTextBatch(items(9), {
        workers: 3,
        createRecognizer() {
            created++;
            return {
                async recognize(blob) {
                    assert.equal(this.busy, undefined);
                    this.busy = true;
                    peak = Math.max(peak, ++active);
                    await pause();
                    active--;
                    delete this.busy;
                    return blob.text();
                },
                async terminate() { assert.equal(this.busy, undefined); terminated++; }
            };
        },
        load: async item => new Blob([`文字 ${item.index}`]),
        save: async report => { saved.push(report); }
    });
    assert.equal(peak, 3);
    assert.equal(created, 3);
    assert.equal(terminated, 3);
    assert.deepEqual(saved.sort((a, b) => a.index - b.index), items(9).map(item => ({ ...item, text: `文字 ${item.index}` })));
});

test('同内容并发只识别一次，既有摘要和空文字结果可复用，各路径分别保存', async () => {
    let calls = 0;
    const saved = [];
    const digest = text => createHash('sha256').update(text).digest('hex');
    const blobs = ['重复原图', '重复原图', '已有原图', '无文字原图', '重复原图'];
    await processImageTextBatch(items(blobs.length), {
        workers: 4,
        cached: [{ digest: digest('已有原图'), text: '已有文字' }, { digest: digest('无文字原图'), text: '' }],
        createRecognizer: () => ({ async recognize() { calls++; await pause(); return '只识别一次'; }, terminate() {} }),
        load: async item => new Blob([blobs[item.index]]),
        save: async report => { saved.push(report); }
    });
    assert.equal(calls, 1);
    assert.deepEqual(saved.sort((a, b) => a.index - b.index).map(report => report.text),
        ['只识别一次', '只识别一次', '已有文字', '', '只识别一次']);
});

test('单图失败继续，失败的重复内容可重试，损坏原图不影响后续项', async () => {
    let calls = 0;
    const saved = [];
    await processImageTextBatch(items(4), {
        workers: 1,
        createRecognizer: () => ({ async recognize() { if (++calls === 1) throw new Error('识别失败'); return '重试成功'; }, terminate() {} }),
        load: async item => { if (item.index === 2) throw new Error('原图损坏'); return new Blob(['同一图片']); },
        save: async report => { saved.push(report); }
    });
    assert.equal(calls, 2);
    assert.deepEqual(saved, [{ index: 0, message: '识别失败' }, { index: 1, text: '重试成功' },
        { index: 2, message: '原图损坏' }, { index: 3, text: '重试成功' }]);
});

test('保存失败停止派发，等待在途任务结束并释放全部 Worker 后再报错', async () => {
    let loaded = 0, terminated = 0;
    await assert.rejects(processImageTextBatch(items(20), {
        workers: 2,
        createRecognizer: () => ({ async recognize(blob) { await pause(); return blob.text(); }, terminate() { terminated++; } }),
        load: async item => { loaded++; return new Blob([String(item.index)]); },
        save: async () => { throw new Error('磁盘不可写'); }
    }), /磁盘不可写/);
    assert.equal(loaded, 2);
    assert.equal(terminated, 2);
});
