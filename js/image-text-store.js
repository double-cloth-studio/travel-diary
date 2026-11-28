const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { ordinaryPath } = require('./record-inventory.js');

const BASE = '.cache/image-text';
const VERSION = 'ocr-7-fast-3072-v1';
const MAXIMUM_TEXT_BYTES = 256 * 1024;

function validateImageSource(source) {
    const name = source?.path;
    if (typeof name !== 'string' || !/^data\/(photos\/.+|profile\/profile-picture\.png)$/.test(name)
        || !/\.(png|jpe?g|webp|gif|avif|heic|heif|bmp)$/i.test(name)
        || name.split('/').some(part => !part || part.startsWith('.') || /[. ]$/.test(part) || /[\\:\x00-\x1f\x7f]/.test(part))
        || (source.id != null && !/^[a-f0-9]{32}$/.test(source.id))) {
        throw Object.assign(new Error('图片索引路径无效。'), { status: 400 });
    }
    return source.id ? `.cache/recycle-bin/${source.id}/${name}` : name;
}

function signature(stat) {
    return `${VERSION}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function createImageTextStore(root) {
    const cacheName = source => `${BASE}/${createHash('sha256').update(validateImageSource(source)).digest('hex')}.json`;
    async function locate(source) {
        const file = await ordinaryPath(root, validateImageSource(source));
        const version = signature(await fs.stat(file));
        return { file, version, etag: `"${createHash('sha256').update(validateImageSource(source) + version).digest('hex')}"` };
    }
    async function read(name) {
        const file = await ordinaryPath(root, name);
        if ((await fs.stat(file)).size > MAXIMUM_TEXT_BYTES) return null;
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        if (typeof value?.text !== 'string' || value.text.length > 50000 || !/^[a-f0-9]{64}$/.test(value.digest)) return null;
        return value;
    }
    async function get(source) {
        const located = await locate(source);
        try {
            const value = await read(cacheName(source));
            if (value?.version === located.version) return { ...located, text: value.text, digest: value.digest };
        } catch (error) {
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        return { ...located, text: null };
    }
    return {
        get,
        async put(source, text, expectedEtag) {
            if (typeof text !== 'string' || text.length > 50000) throw Object.assign(new Error('图片文字过长。'), { status: 422 });
            const { file, version, etag } = await locate(source);
            if (etag !== expectedEtag) throw Object.assign(new Error('图片已变化，请重新识别。'), { status: 409 });
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(file)) hash.update(chunk);
            const value = { path: source.path, ...(source.id ? { id: source.id } : {}), version, digest: hash.digest('hex'), text };
            const body = JSON.stringify(value);
            if (Buffer.byteLength(body) > MAXIMUM_TEXT_BYTES) throw Object.assign(new Error('图片文字过长。'), { status: 422 });
            // 逐级检查父目录，缓存不能通过符号链接写到项目以外。
            for (const directory of ['.cache', BASE]) {
                await fs.mkdir(path.join(root, directory)).catch(error => { if (error.code !== 'EEXIST') throw error; });
                await ordinaryPath(root, directory, true);
            }
            const destination = path.join(root, cacheName(source));
            try { await ordinaryPath(root, cacheName(source)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
            try {
                await fs.writeFile(temporary, body, { flag: 'wx' });
                if ((await locate(source)).version !== version) throw Object.assign(new Error('图片已变化，请重新识别。'), { status: 409 });
                await fs.rename(temporary, destination);
            } finally { await fs.unlink(temporary).catch(() => {}); }
        },
        async list(recycled = false) {
            let directory;
            try { directory = await ordinaryPath(root, BASE, true); }
            catch (error) { if (error.code === 'ENOENT') return []; throw error; }
            const names = (await fs.readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
            const entries = [];
            let next = 0;
            await Promise.all(Array.from({ length: Math.min(8, names.length) }, async () => {
                while (next < names.length) {
                    const name = `${BASE}/${names[next++]}`;
                    try {
                        const value = await read(name);
                        if (!value || Boolean(value.id) !== recycled || cacheName(value) !== name) continue;
                        if ((await locate(value)).version === value.version) entries.push({ path: value.path,
                            ...(value.id ? { id: value.id } : {}), text: value.text, digest: value.digest });
                    } catch (error) {
                        if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError) && !error.status) throw error;
                    }
                }
            }));
            return entries;
        }
    };
}

module.exports = { createImageTextStore, validateImageSource, MAXIMUM_TEXT_BYTES };
