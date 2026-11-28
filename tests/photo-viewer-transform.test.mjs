import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getInitialPhotoScale,
    getPhotoViewerZoomTranslate,
    getPhotoViewerBounds,
    constrainPhotoViewerTranslate,
    getPhotoViewerRenderMetrics
} from '../js/photo-viewer-transform.mjs';

test('视频可以按图片的等比适配规则放大到舞台边界', () => {
    const result = getInitialPhotoScale({
        stageWidth: 988,
        stageHeight: 549,
        naturalWidth: 572,
        naturalHeight: 326,
        allowUpscale: true
    });

    assert.equal(result, Math.min(988 / 572, 549 / 326));
});

test('图片初始适配仍不会超过原始尺寸', () => {
    const result = getInitialPhotoScale({
        stageWidth: 988,
        stageHeight: 549,
        naturalWidth: 414,
        naturalHeight: 300
    });

    assert.equal(result, 1);
});

test('超宽的图片也按舞台宽度完整显示', () => {
    const result = getInitialPhotoScale({ stageWidth: 450, stageHeight: 600, naturalWidth: 9000, naturalHeight: 600 });
    assert.equal(result, 0.05);
});

test('小于舞台的照片仍允许少量拖动，且不会被拖离视野', () => {
    const result = constrainPhotoViewerTranslate({
        translateX: 420,
        translateY: -360,
        bounds: {
            stageWidth: 360,
            stageHeight: 610,
            imageWidth: 320,
            imageHeight: 202
        }
    });

    assert.deepEqual(result, {
        translateX: 360 * 0.06,
        translateY: -32
    });
});

test('大于舞台的照片拖到边缘后仍留出背景和阴影空间', () => {
    const result = constrainPhotoViewerTranslate({
        translateX: 500,
        translateY: -500,
        bounds: {
            stageWidth: 360,
            stageHeight: 610,
            imageWidth: 1000,
            imageHeight: 800
        }
    });

    assert.deepEqual(result, {
        translateX: 341.6,
        translateY: -127
    });
});

test('恰好适配的媒体可以向两侧拖动，留白在窄屏缩减且不随缩放增大', () => {
    for (const stageSize of [240, 360, 1000]) {
        const edgeSpace = Math.min(32, stageSize * 0.06);
        for (const scale of [1, 4]) {
            for (const direction of [-1, 1]) {
                const result = constrainPhotoViewerTranslate({
                    translateX: direction * 10000,
                    translateY: direction * 10000,
                    bounds: {
                        stageWidth: stageSize, stageHeight: stageSize,
                        imageWidth: stageSize * scale, imageHeight: stageSize * scale
                    }
                });
                const expected = direction * ((stageSize * scale - stageSize) / 2 + edgeSpace);
                assert.equal(result.translateX, expected);
                assert.equal(result.translateY, expected);
            }
        }
    }
});

test('缩小显示时直接使用当前显示尺寸，避免移动端大图缩小缺块', () => {
    const fitted = getPhotoViewerRenderMetrics({
        naturalWidth: 4000,
        naturalHeight: 2526,
        scale: 0.13
    });

    assert.equal(fitted.width, 520);
    assert.equal(fitted.height, 328.38);

    const zoomed = getPhotoViewerRenderMetrics({
        naturalWidth: 4000,
        naturalHeight: 2526,
        scale: 1
    });

    assert.equal(zoomed.width, 4000);
    assert.equal(zoomed.height, 2526);
});

test('原图以上的缩放仍按显示尺寸重绘，并与旋转和拖动边界一致', () => {
    for (const scale of [0.13, 1, 1.25, 2.5, 5]) {
        const size = getPhotoViewerRenderMetrics({ naturalWidth: 4000, naturalHeight: 2526, scale });
        for (const rotation of [0, 90, 180, 270]) {
            const bounds = getPhotoViewerBounds({
                stageWidth: 988, stageHeight: 549,
                sourceWidth: 4000, sourceHeight: 2526, scale, rotation
            });
            const sideways = rotation % 180 !== 0;
            assert.ok(Math.abs(bounds.imageWidth - (sideways ? size.height : size.width)) < 1e-8);
            assert.ok(Math.abs(bounds.imageHeight - (sideways ? size.width : size.height)) < 1e-8);
        }
    }
});

test('双指缩放围绕当前手势中心而不是照片中心放大', () => {
    const result = getPhotoViewerZoomTranslate({
        translateX: 20,
        translateY: -10,
        previousScale: 1,
        nextScale: 2,
        startFocalPoint: { x: 120, y: -80 },
        currentFocalPoint: { x: 135, y: -70 }
    });

    assert.deepEqual(result, {
        translateX: -65,
        translateY: 70
    });
});
