// src/table-editor/cell-click.ts
// Логический слой: обработка клика по групповым заголовкам "БАЗА" и "КОНТРОЛЛЕР".
// НЕ строит DOM сам — диалоги импортируются из UI-слоя (src/ui),
// чтобы при портировании на нативное приложение достаточно было подменить UI-модуль.

import { showCopyBaseConfirm, showCopyControllerConfirm } from '../ui/confirm-dialog.js';
import { copyControllerToBase, copyBaseToController } from './copy-ops.js';

/**
 * Вызывается при одиночном клике по групповому заголовку "БАЗА" или "КОНТРОЛЛЕР".
 */
export function handleGroupHeaderClick(
    th: HTMLElement,
    groupName: 'base' | 'controller',
): void {
    const label = groupName === 'base' ? 'БАЗА' : 'КОНТРОЛЛЕР';
    console.log(`[HEADER CLICK] Группа "${label}" — текст: "${th.innerText.trim()}"`);

    // Визуальная подсветка на 600 мс, чтобы пользователь видел отклик на клик
    th.style.transition = 'background-color 0.15s ease';
    th.style.backgroundColor = 'rgba(0, 120, 215, 0.35)';
    setTimeout(() => {
        th.style.backgroundColor = '';
    }, 600);

    // Клик по БАЗЕ: окно подтверждения, при Yes — реальная запись База→Контроллер по Modbus.
    if (groupName === 'base') {
        showCopyBaseConfirm().then(async (ok) => {
            console.log(`[BASE COPY] Пользователь выбрал: ${ok ? 'Yes' : 'No'}`);
            if (ok) {
                await copyBaseToController();
            }
        });
    }

    // Клик по КОНТРОЛЛЕРУ: окно подтверждения, при Yes — копирование Контроллер→База в памяти.
    if (groupName === 'controller') {
        showCopyControllerConfirm().then((ok) => {
            console.log(`[CONTROLLER COPY] Пользователь выбрал: ${ok ? 'Yes' : 'No'}`);
            if (ok) {
                const n = copyControllerToBase();
                console.log(`[CONTROLLER COPY] Скопировано строк: ${n}`);
            }
        });
    }
}