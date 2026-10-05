// src\ui\layout.ts
import { handleGroupHeaderClick } from '../table-editor/cell-click.js';

document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.querySelector<HTMLElement>('.left-sidebar-column');
    const sidebarResizer = document.querySelector<HTMLElement>('.sidebar-resizer');
    const wrapper = document.querySelector<HTMLElement>('.panel-content-wrapper');
    const oscContainer = document.getElementById('osc-container');

    // Доли от ширины окна (не пиксели!) — чтобы пропорции сохранялись
    // при любом DPI (100%, 125%, 150%, ...) и любом размере окна.
    // При фиксированных пикселях на 125% DPI резерв 900+610 не влезал в
    // CSS-ширину окна, и дерево схлопывалось до 40px.
    //
    // Верхнего потолка у дерева нет — таблицу можно сжать как угодно сильно.
    // Единственное ограничение: когда осц. скрыт, мы резервируем место
    // под его будущее появление, чтобы сайдбар не «прыгал» при открытии.
    const TREE_MIN_SHARE = 0.05;      // мин. доля дерева от ширины окна (5%)
    const OSC_RESERVED_SHARE = 0.45;  // резерв под осц., когда он скрыт

    /**
     * Считает верхнюю границу ширины дерева INI.
     *
     * Логика:
     *   - Если осц. скрыт — резервируем 45% wrapper под его будущее
     *     появление, чтобы сайдбар не «прыгал» при открытии.
     *   - Если осц. открыт — дерево может растянуться на всю wrapper
     *     (таблица сжимается как угодно сильно, это допустимо).
     *
     * Нижняя граница (5% от ширины окна) применяется отдельно —
     * в doDragSidebar и в enforceSidebarLimits.
     */
    function calcMaxSidebarWidth(): number {
        if (!wrapper || !oscContainer) return 0;
        const wrapperWidth = wrapper.getBoundingClientRect().width;
        const isOscHidden = oscContainer.classList.contains('hidden');
        const oscReserve = isOscHidden ? wrapperWidth * OSC_RESERVED_SHARE : 0;
        return wrapperWidth - oscReserve;
    }

    function enforceSidebarLimits(): void {
        if (!sidebar || !wrapper || !oscContainer) return;
        const maxSidebarWidth = calcMaxSidebarWidth();
        const minSidebarWidth = window.innerWidth * TREE_MIN_SHARE;

        // Слишком широкое — сжимаем до верхней границы.
        if (sidebar.offsetWidth > maxSidebarWidth) {
            sidebar.style.width = `${maxSidebarWidth}px`;
        }
        // Слишком узкое — растягиваем до нижней границы.
        // (Например, при сжатии окна или при смене DPI.)
        if (sidebar.offsetWidth < minSidebarWidth) {
            sidebar.style.width = `${minSidebarWidth}px`;
        }
    }

    // --- РЕСАЙЗЕРЫ ---
    if (sidebarResizer && sidebar && wrapper && oscContainer) {
        sidebarResizer.addEventListener('mousedown', (e: MouseEvent) => {
            e.preventDefault();
            sidebarResizer.classList.add('active');
            document.body.classList.add('is-resizing');

            const doDragSidebar = (moveEvent: MouseEvent): void => {
                const wrapperRect = wrapper.getBoundingClientRect();
                const maxSidebarWidth = calcMaxSidebarWidth();
                const minSidebarWidth = window.innerWidth * TREE_MIN_SHARE;

                let newWidth = moveEvent.clientX - wrapperRect.left;
                if (newWidth < minSidebarWidth) newWidth = minSidebarWidth;
                if (newWidth > maxSidebarWidth) newWidth = maxSidebarWidth;
                sidebar.style.width = `${newWidth}px`;
            };

            const stopDragSidebar = (): void => {
                sidebarResizer.classList.remove('active');
                document.body.classList.remove('is-resizing');
                window.removeEventListener('mousemove', doDragSidebar);
                window.removeEventListener('mouseup', stopDragSidebar);
            };

            window.addEventListener('mousemove', doDragSidebar);
            window.addEventListener('mouseup', stopDragSidebar);
        });
    }

    const table = document.querySelector<HTMLElement>('.modbus-grid');
    const groupHeaders = document.querySelectorAll<HTMLElement>('.modbus-grid thead tr:first-child th');
    const subHeaders = document.querySelectorAll<HTMLElement>('.modbus-grid thead tr:last-child th');
    const cols = document.querySelectorAll<HTMLElement>('.modbus-grid colgroup col');

    if (table) {
        // =====================================================
        // 1) Ресайзеры ВНУТРИ групп (нижняя строка шапки):
        //    №|Имя, Имя|Описание, Описание|Ед.изм,
        //    hex|Physical (БАЗА), hex|Physical (КОНТРОЛЛЕР)
        // =====================================================
        const internalIndices = [0, 1, 2, 4, 6];
        internalIndices.forEach(idx => {
            const th = subHeaders[idx];
            const nextCol = cols[idx + 1];
            const currCol = cols[idx];
            if (!th || !nextCol || !currCol) return;

            const resizer = document.createElement('div');
            resizer.className = 'table-resizer internal-resizer';
            th.appendChild(resizer);

            resizer.addEventListener('mousedown', (e: MouseEvent) => {
                e.preventDefault();
                resizer.classList.add('active');
                document.body.classList.add('is-resizing');

                const startX = e.clientX;
                const totalTableWidth = table.offsetWidth;
                const nextTh = subHeaders[idx + 1];
                if (!nextTh) return;

                const startWidthLeft = th.getBoundingClientRect().width;
                const startWidthRight = nextTh.getBoundingClientRect().width;

                const doDragInternal = (moveEvent: MouseEvent): void => {
                    let delta = moveEvent.clientX - startX;
                    if (startWidthLeft + delta < 40) delta = 40 - startWidthLeft;
                    if (startWidthRight - delta < 40) delta = startWidthRight - 40;
                    const pctLeft = ((startWidthLeft + delta) / totalTableWidth) * 100;
                    const pctRight = ((startWidthRight - delta) / totalTableWidth) * 100;
                    currCol.style.width = `${pctLeft}%`;
                    nextCol.style.width = `${pctRight}%`;
                };

                const stopDragInternal = (): void => {
                    resizer.classList.remove('active');
                    document.body.classList.remove('is-resizing');
                    window.removeEventListener('mousemove', doDragInternal);
                    window.removeEventListener('mouseup', stopDragInternal);
                };

                window.addEventListener('mousemove', doDragInternal);
                window.addEventListener('mouseup', stopDragInternal);
            });
        });

        // =====================================================
        // 2) Групповые ресайзеры ВЕРХНЕЙ строки шапки:
        //    ПАРАМЕТРЫ | БАЗА   и   БАЗА | КОНТРОЛЛЕР
        //    Тянут ширину ВСЕЙ группы целиком.
        // =====================================================
        const groups: number[][] = [
            [0, 1, 2, 3], // ПАРАМЕТРЫ
            [4, 5],       // БАЗА
            [6, 7]        // КОНТРОЛЛЕР
        ];

        const getColWidth = (idx: number): number =>
            subHeaders[idx] ? subHeaders[idx].getBoundingClientRect().width : 0;

        for (let g = 0; g < groups.length - 1; g++) {
            const headerTh = groupHeaders[g];
            const leftGroup = groups[g];
            const rightGroup = groups[g + 1];
            if (!headerTh || !leftGroup || !rightGroup) continue;

            const resizer = document.createElement('div');
            resizer.className = 'table-resizer group-resizer';
            headerTh.appendChild(resizer);

            resizer.addEventListener('mousedown', (e: MouseEvent) => {
                e.preventDefault();
                resizer.classList.add('active');
                document.body.classList.add('is-resizing');

                const startX = e.clientX;
                const totalTableWidth = table.offsetWidth;

                const leftStartWidths = leftGroup.map(getColWidth);
                const rightStartWidths = rightGroup.map(getColWidth);
                const leftTotal = leftStartWidths.reduce((a, b) => a + b, 0);
                const rightTotal = rightStartWidths.reduce((a, b) => a + b, 0);
                if (leftTotal <= 0 || rightTotal <= 0) return;

                const minLeft = 40 * leftGroup.length;
                const minRight = 40 * rightGroup.length;

                const doDragGroup = (moveEvent: MouseEvent): void => {
                    let delta = moveEvent.clientX - startX;
                    if (leftTotal + delta < minLeft) delta = minLeft - leftTotal;
                    if (rightTotal - delta < minRight) delta = rightTotal - minRight;

                    const leftScale = (leftTotal + delta) / leftTotal;
                    const rightScale = (rightTotal - delta) / rightTotal;

                    leftGroup.forEach((colIdx, i) => {
                        if (cols[colIdx]) {
                            cols[colIdx].style.width =
                                `${((leftStartWidths[i] * leftScale) / totalTableWidth) * 100}%`;
                        }
                    });

                    rightGroup.forEach((colIdx, i) => {
                        if (cols[colIdx]) {
                            cols[colIdx].style.width =
                                `${((rightStartWidths[i] * rightScale) / totalTableWidth) * 100}%`;
                        }
                    });
                };

                const stopDragGroup = (): void => {
                    resizer.classList.remove('active');
                    document.body.classList.remove('is-resizing');
                    window.removeEventListener('mousemove', doDragGroup);
                    window.removeEventListener('mouseup', stopDragGroup);
                };

                window.addEventListener('mousemove', doDragGroup);
                window.addEventListener('mouseup', stopDragGroup);
            });
        }

        // =====================================================
        // 3) Клик по групповым заголовкам "БАЗА" и "КОНТРОЛЛЕР".
        //    Индексы в groupHeaders: 0=ПАРАМЕТРЫ, 1=БАЗА, 2=КОНТРОЛЛЕР.
        //    Игнорируем клики по ресайзеру (он лежит внутри <th>).
        // =====================================================
        const clickableHeaderMap: Record<number, 'base' | 'controller'> = {
            1: 'base',
            2: 'controller',
        };
        for (const idxStr of Object.keys(clickableHeaderMap)) {
            const idx = parseInt(idxStr, 10);
            const th = groupHeaders[idx];
            const groupName = clickableHeaderMap[idx];
            if (!th || !groupName) continue;

            th.style.cursor = 'pointer';
            th.classList.add('clickable-group-header');

            // Стрелка, направленная к границе БАЗА|КОНТРОЛЛЕР.
            // Рисуем реальным <span> с инлайн-стилями — не зависит от кэша CSS.
            const arrow = document.createElement('span');
            arrow.textContent = groupName === 'base' ? '>' : '<';
            arrow.style.position = 'absolute';
            arrow.style.top = '50%';
            arrow.style.transform = 'translateY(-50%)';
            if (groupName === 'base') {
                arrow.style.right = '6px';   // остриё ">" к правому краю (границе)
            } else {
                arrow.style.left = '6px';    // остриё "<" к левому краю (границе)
            }
            arrow.style.fontSize = '30px';
            arrow.style.fontWeight = '900';
            arrow.style.lineHeight = '1';
            arrow.style.color = '#00b050';
            arrow.style.pointerEvents = 'none';
            th.appendChild(arrow);

            th.addEventListener('click', (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                // Если клик был по ресайзеру — игнорируем (ресайзер обрабатывает mousedown)
                if (target && target.classList.contains('table-resizer')) return;
                handleGroupHeaderClick(th, groupName);
            });
        }
    }

    enforceSidebarLimits();

    // При изменении размера окна заново проверяем границы —
    // иначе при сжатии окна дерево останется старым и «съест» таблицу.
    window.addEventListener('resize', enforceSidebarLimits);
});