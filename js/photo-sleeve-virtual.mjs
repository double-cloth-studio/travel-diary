// 标题单独成行，媒体行保留原始索引，查看器与滚动窗口共用同一份顺序。
export function buildPhotoSleeveRows(media, columns, grouped) {
    const rows = [];
    let start = 0;
    while (start < media.length) {
        if (grouped && (start === 0 || media[start].recordId !== media[start - 1].recordId)) {
            rows.push({ start, end: start, heading: true });
        }
        let end = start + 1;
        while (end < media.length && end - start < columns
            && (!grouped || media[end].recordId === media[start].recordId)) end++;
        rows.push({ start, end, heading: false });
        start = end;
    }
    return rows;
}

export function mountVirtualPhotoSleeve(sleeve, { media, grouped, renderItem, renderHeading, mountMedia, releaseMedia }) {
    const content = document.createElement('div');
    content.className = 'photo-sleeve-virtual-content';
    sleeve.append(content);
    const mounted = new Map();
    let mounting = [];
    let rows = [];
    let columns = 0;
    let width = 0;
    let needsLayout = true;
    let frame;
    let disposed = false;

    function createRow(row) {
        const node = document.createElement('div');
        node.className = 'photo-sleeve-virtual-row';
        node.innerHTML = row.heading ? renderHeading(media[row.start], row.start)
            : media.slice(row.start, row.end).map((item, offset) => renderItem(item, row.start + offset)).join('');
        return node;
    }

    function mountRow(index) {
        if (mounted.has(index)) return mounted.get(index);
        const row = rows[index];
        const node = createRow(row);
        node.dataset.virtualRow = String(index);
        node.style.top = `${row.top}px`;
        const following = [...content.children].find(child => Number(child.dataset.virtualRow) > index);
        content.insertBefore(node, following || null);
        mounted.set(index, node);
        mounting.push(...node.querySelectorAll('img'));
        return node;
    }

    function removeRow(index, node) {
        node.querySelectorAll('img').forEach(releaseMedia);
        node.remove();
        mounted.delete(index);
    }

    function layout() {
        const style = getComputedStyle(sleeve);
        const nextColumns = style.gridTemplateColumns.split(' ').filter(Boolean).length || 1;
        const gap = parseFloat(style.rowGap) || 0;
        if (columns !== nextColumns) {
            for (const [index, node] of mounted) removeRow(index, node);
            columns = nextColumns;
        }
        content.style.setProperty('--photo-columns', columns);
        rows = buildPhotoSleeveRows(media, columns, grouped);
        // 一次批量测量当前列宽下的按钮和各组标题，长标题换行也参与总高度。
        const probe = document.createElement('div');
        probe.className = 'photo-sleeve-virtual-probe';
        const sample = createRow({ start: 0, end: 1, heading: false });
        const headings = rows.filter(row => row.heading).map(createRow);
        probe.append(sample, ...headings);
        content.append(probe);
        // 纸页动画可能缩放祖先元素，使用未经过变换的布局高度计算滚动范围。
        const itemHeight = parseFloat(getComputedStyle(sample).height);
        const headingHeights = headings.map(node => parseFloat(getComputedStyle(node).height));
        probe.remove();
        let top = 0;
        let headingIndex = 0;
        for (const row of rows) {
            row.top = top;
            row.height = row.heading ? headingHeights[headingIndex++] : itemHeight;
            top += row.height + gap;
        }
        for (const [index, node] of mounted) node.style.top = `${rows[index].top}px`;
        content.style.height = `${Math.max(0, top - gap)}px`;
    }

    function update() {
        frame = undefined;
        if (disposed || !sleeve.isConnected || !sleeve.clientWidth) return;
        // 桌面右页独立滚动，手机纸页 display: contents 时由窗口滚动。
        const page = sleeve.closest('.paper-page');
        const pageBounds = page?.getBoundingClientRect();
        const clipped = pageBounds?.height > 0 && /(auto|scroll)/.test(getComputedStyle(page).overflowY);
        const top = clipped ? Math.max(0, pageBounds.top) : 0;
        const bottom = clipped ? Math.min(innerHeight, pageBounds.bottom) : innerHeight;
        let contentTop = content.getBoundingClientRect().top;
        if (needsLayout || width !== sleeve.clientWidth) {
            width = sleeve.clientWidth;
            needsLayout = false;
            const offset = top - contentTop;
            const visibleRow = offset > 0 ? rows[findRow(offset)] : null;
            const focusIndex = Number(document.activeElement?.closest('.photo-sleeve-button')?.dataset.mediaIndex);
            const restoreFocus = content.contains(document.activeElement);
            layout();
            contentTop = content.getBoundingClientRect().top;
            if (visibleRow) {
                const anchor = rows.find(row => row.heading === visibleRow.heading && (row.heading
                    ? row.start === visibleRow.start : row.start <= visibleRow.start && row.end > visibleRow.start));
                if (anchor) {
                    const delta = contentTop - top + anchor.top + Math.min(offset - visibleRow.top, anchor.height);
                    if (Math.abs(delta) >= 1) {
                        if (clipped) page.scrollTop += delta;
                        else window.scrollBy({ top: delta, behavior: 'instant' });
                        contentTop = content.getBoundingClientRect().top;
                    }
                }
            }
            if (restoreFocus && Number.isInteger(focusIndex)) {
                const index = rows.findIndex(row => !row.heading && focusIndex >= row.start && focusIndex < row.end);
                if (index >= 0) mountRow(index).querySelector(`[data-media-index="${focusIndex}"]`).focus({ preventScroll: true });
            }
        }
        const overscan = Math.max(300, bottom - top);
        const from = top - contentTop - overscan;
        const to = bottom - contentTop + overscan;
        const needed = new Set();
        for (let index = findRow(from); index < rows.length && rows[index].top <= to; index++) {
            needed.add(index);
            mountRow(index);
        }
        for (const [index, node] of mounted) {
            if (!needed.has(index) && !node.contains(document.activeElement)) removeRow(index, node);
        }
        // 先完成所有行的增删，再启动观察与预读，避免每插入一行便触发布局。
        flushMedia();
    }

    function flushMedia() {
        const images = mounting;
        mounting = [];
        images.forEach(mountMedia);
    }

    function findRow(offset) {
        let low = 0;
        let high = rows.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (rows[middle].top + rows[middle].height < offset) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    function scheduleUpdate() {
        if (!disposed && frame === undefined) frame = requestAnimationFrame(update);
    }

    function invalidateLayout() {
        needsLayout = true;
        scheduleUpdate();
    }

    function handleKeydown(event) {
        if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return;
        const button = event.target.closest('.photo-sleeve-button');
        if (!button) return;
        const next = Number(button.dataset.mediaIndex) + (event.shiftKey ? -1 : 1);
        if (next < 0 || next >= media.length) return;
        const rowIndex = rows.findIndex(row => !row.heading && next >= row.start && next < row.end);
        const node = mountRow(rowIndex);
        flushMedia();
        event.preventDefault();
        node.querySelector(`[data-media-index="${next}"]`).focus();
        scheduleUpdate();
    }

    addEventListener('scroll', scheduleUpdate, { capture: true, passive: true });
    addEventListener('resize', invalidateLayout);
    sleeve.addEventListener('keydown', handleKeydown);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleUpdate) : null;
    observer?.observe(sleeve);
    document.fonts?.addEventListener('loadingdone', invalidateLayout);
    document.fonts?.ready.then(invalidateLayout);
    update();
    return () => {
        disposed = true;
        cancelAnimationFrame(frame);
        observer?.disconnect();
        removeEventListener('scroll', scheduleUpdate, true);
        removeEventListener('resize', invalidateLayout);
        document.fonts?.removeEventListener('loadingdone', invalidateLayout);
        sleeve.removeEventListener('keydown', handleKeydown);
        for (const [index, node] of mounted) removeRow(index, node);
    };
}
