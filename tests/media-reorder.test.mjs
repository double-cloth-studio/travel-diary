import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const { moveMediaGroup, selectedMediaGroups, mediaDragKeys } = await loadBrowserModule(new URL('../js/record-editor.js', import.meta.url), '\nexport { moveMediaGroup, selectedMediaGroups, mediaDragKeys };');

test('拖动手柄只合并连续选中的附件，保留未选附件之间的间隔', () => {
    const order = ['photo:1', 'video:1', 'upload:1', 'photo:2', 'video:2', 'photo:3'];
    assert.deepEqual(selectedMediaGroups(order, new Set(['video:2', 'photo:2', 'video:1', 'photo:1', 'photo:3'])), [
        ['photo:1', 'video:1'], ['photo:2', 'video:2', 'photo:3']
    ]);
    assert.deepEqual(selectedMediaGroups(order, new Set(['photo:1', 'upload:1', 'video:2'])), [
        ['photo:1'], ['upload:1'], ['video:2']
    ]);
    assert.deepEqual(selectedMediaGroups(order, new Set(order)), [order]);
    assert.deepEqual(selectedMediaGroups(order, new Set(['missing'])), []);
});

test('单项可以拖到首位、末位和中间', () => {
    const order = ['a', 'b', 'c', 'd'];
    assert.deepEqual(moveMediaGroup(order, new Set(['d']), 'a'), ['d', 'a', 'b', 'c']);
    assert.deepEqual(moveMediaGroup(order, new Set(['a'])), ['b', 'c', 'd', 'a']);
    assert.deepEqual(moveMediaGroup(order, new Set(['d']), 'c'), ['a', 'b', 'd', 'c']);
    assert.deepEqual(order, ['a', 'b', 'c', 'd']);
});

test('间隔选中时单项手柄仅移动自身，连续组手柄仅移动所属组', () => {
    const order = ['a', 'b', 'c', 'd', 'e', 'f'];
    const selected = new Set(['a', 'b', 'd', 'f']);
    assert.deepEqual([...mediaDragKeys(order, selected, 'a')], ['a', 'b']);
    assert.deepEqual([...mediaDragKeys(order, selected, 'b')], ['a', 'b']);
    assert.deepEqual(moveMediaGroup(order, mediaDragKeys(order, selected, 'a'), 'e'), ['c', 'd', 'a', 'b', 'e', 'f']);
    assert.deepEqual(moveMediaGroup(order, mediaDragKeys(order, selected, 'd'), 'a'), ['d', 'a', 'b', 'c', 'e', 'f']);
    assert.deepEqual(moveMediaGroup(order, mediaDragKeys(order, selected, 'c')), ['a', 'b', 'd', 'e', 'f', 'c']);
    assert.deepEqual([...selected], ['a', 'b', 'd', 'f']);
});

test('混合已有、新增及跨类型选择只移动当前列表中的文件', () => {
    const keys = new Set(['upload:1', 'photo:1', 'video:1']);
    assert.deepEqual(moveMediaGroup(['photo:1', 'photo:2', 'upload:1', 'photo:3'], keys, 'photo:3'), ['photo:2', 'photo:1', 'upload:1', 'photo:3']);
    assert.deepEqual(moveMediaGroup(['video:2', 'video:1'], keys, 'video:2'), ['video:1', 'video:2']);
});

test('全选、空选择及无效落点保持顺序', () => {
    const order = ['a', 'b'];
    assert.deepEqual(moveMediaGroup(order, new Set(order)), order);
    assert.deepEqual(moveMediaGroup(order, new Set(), 'a'), order);
    assert.deepEqual(moveMediaGroup(order, new Set(['a']), 'missing'), order);
});
