import { recognizeImage } from '/js/image-text-search.js';

async function run() {
    const response = await fetch('./manifest');
    if (!response.ok) throw new Error('无法读取图片清单。');
    for (const item of await response.json()) {
        const report = { index: item.index };
        try {
            const original = await fetch(item.source, { signal: AbortSignal.timeout(20000) });
            if (!original.ok) throw new Error(`原图读取失败（HTTP ${original.status}）。`);
            report.text = await recognizeImage(await original.blob());
        } catch (error) { report.message = error.message; }
        const saved = await fetch('./progress', { method: 'POST', body: JSON.stringify(report) });
        if (!saved.ok) throw new Error('无法保存图片文字索引。');
    }
    const completed = await fetch('./complete', { method: 'POST' });
    if (!completed.ok) throw new Error('无法完成图片文字索引。');
}

run().catch(error => fetch('./error', { method: 'POST', body: String(error.message) }));
