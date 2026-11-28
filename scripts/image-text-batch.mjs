export async function processImageTextBatch(items, { workers, cached = [], createRecognizer, load, save }) {
    // 同内容的并发任务共享 Promise；失败后移除，允许后续副本重试。
    const content = new Map(cached.map(entry => [entry.digest, Promise.resolve(entry.text)]));
    let next = 0;
    let stopped = false;
    const settled = await Promise.allSettled(Array.from({ length: Math.min(workers, items.length) }, async () => {
        const recognizer = createRecognizer();
        try {
            while (!stopped && next < items.length) {
                const item = items[next++];
                const report = { index: item.index };
                try {
                    const blob = await load(item);
                    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
                    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
                    let task = content.get(hash);
                    if (!task) {
                        task = recognizer.recognize(blob);
                        content.set(hash, task);
                        task.catch(() => { if (content.get(hash) === task) content.delete(hash); });
                    }
                    report.text = await task;
                } catch (error) { report.message = error.message; }
                await save(report);
            }
        } catch (error) {
            stopped = true;
            throw error;
        } finally { await recognizer.terminate(); }
    }));
    const failed = settled.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
}

async function run() {
    const response = await fetch('./manifest');
    if (!response.ok) throw new Error('无法读取图片清单。');
    const { items, workers, cached } = await response.json();
    const { createImageTextRecognizer } = await import('/js/image-text-search.js');
    await processImageTextBatch(items, { workers, cached, createRecognizer: createImageTextRecognizer,
        async load(item) {
            const original = await fetch(item.source, { signal: AbortSignal.timeout(20000) });
            if (!original.ok) throw new Error(`原图读取失败（HTTP ${original.status}）。`);
            const blob = await original.blob();
            if (blob.size > 64 * 1024 * 1024) throw new Error('图片超过 64 MiB，无法识别。');
            return blob;
        },
        async save(report) {
            const saved = await fetch('./progress', { method: 'POST', body: JSON.stringify(report) });
            if (!saved.ok) throw new Error('无法保存图片文字索引。');
        }
    });
    const completed = await fetch('./complete', { method: 'POST' });
    if (!completed.ok) throw new Error('无法完成图片文字索引。');
}

if (typeof window !== 'undefined') run().catch(error => fetch('./error', { method: 'POST', body: String(error.message) }));
