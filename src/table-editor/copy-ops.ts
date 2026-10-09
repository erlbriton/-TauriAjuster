// src/table-editor/copy-ops.ts

// Операции массового копирования значений между Базой и Контроллером.

import { updateMismatchClass, baseControllerMismatch } from './controller-write.js';
import { planControllerWrite } from '../ini-manager/tree-core.js';
import { writeRegistersFC16, readHoldingRegistersFC03 } from '../serial/serial-actions.js';
import { getTableEditorState } from '../ini-manager/table-editor.js';

/**
 * Копирует значения Контроллера (колонки 6,7) в Базу (колонки 4,5)
 * для всех строк таблицы — только в памяти браузера.
 * Возвращает количество обработанных строк.
 */
export function copyControllerToBase(): number {
    const rows = Array.from(
        document.querySelectorAll<HTMLTableRowElement>('#grid-data-rows tr'),
    );
    let copied = 0;

    for (const tr of rows) {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 8) continue;

        const baseHex = tds[4];
        const basePhys = tds[5];
        const ctrlHex = tds[6];
        const ctrlPhys = tds[7];
        if (!baseHex || !basePhys || !ctrlHex || !ctrlPhys) continue;

        // Не копируем пустые и прочерки — там нет живого значения
        const ctrlHexText = (ctrlHex.textContent || '').trim();
        if (!ctrlHexText || ctrlHexText === '—') continue;

        // Переписываем содержимое ячеек Контроллера в Базу
        baseHex.innerHTML = ctrlHex.innerHTML;
        basePhys.innerHTML = ctrlPhys.innerHTML;

        // Пересчитываем подсветку расхождения (после копирования — совпадает, станет чёрной)
        const dataType = (tr.getAttribute('data-type') || '').toUpperCase();
        updateMismatchClass(tr, dataType);

        copied++;
    }

    return copied;
}

// ─────────────────────────────────────────────
// База → Контроллер (двухфазная запись по Modbus)
// ─────────────────────────────────────────────
//
// СХЕМА (важно, не удалять):
//   Фаза 1. Для каждого параметра — только ЗАПИСЬ (FC16). Без чтения после
//           каждой записи, без паузы 500 мс, без повторов. Результат записи
//           (успех/таймаут) игнорируется: устройство могло выполнить кадр
//           молча (окно сохранения в энергонезависимую память ~1–1,5 с).
//   Фаза 2. После всех записей — ОДНО групповое чтение всех затронутых
//           регистров батчами (до 125 регистров на пакет FC03). Ячейки
//           Контроллера обновляются только у тех параметров, где прочитанное
//           значение совпало с записанным.
//   Окна и модалки не показываются ни при успехе, ни при ошибке.
//           Если что-то не записалось — строка подсветится автоматически
//           классом row-mismatch (механизм уже есть в updateMismatchClass).
//           Дополнительно: если незаписавшихся ≥ 2, в столбце "hex контроллера"
//           у левого края появляется стрелка ▼ — во всех строках, кроме самой
//           нижней. Это подсказывает пользователю, что ниже есть ещё проблемы.
//
// Скорость: на 180 параметров раньше было 5–6 минут (read+паузы после каждой
// записи), теперь — один проход записи + 1–3 пакета чтения в конце.

interface WrittenTarget {
    tr: HTMLTableRowElement;
    startReg: number;
    /** Слова, которые должны оказаться в регистрах после успешной записи. */
    expectedWords: number[];
    dataType: string;
    /** Hex-строка Базы — попадает в parts[hexIndex] при успехе. */
    baseText: string;
    hexIndex: number;
    kind: 'words' | 'byte' | 'bit';
    byteValue: number;
    bytePos: 'L' | 'H';
    bitValue: number;
}

/**
 * Снимает все стрелки ▼, поставленные markFailedRows.
 * Вызывается в начале copyBaseToController перед новой попыткой копирования —
 * чтобы не накапливались от предыдущего раза.
 */
function clearFailedArrows(): void {
    document
        .querySelectorAll('#grid-data-rows .copy-down-arrow')
        .forEach((el) => el.remove());
}

/**
 * Помечает незаписавшиеся строки стрелками ▼ в ячейке "hex" группы "Контроллер".
 *
 * Логика:
 *   - Если незаписавшихся 0 или 1 — стрелки НЕ ставятся (пользователь увидит
 *     единственную красную строку сам).
 *   - Если ≥ 2 — ставим ▼ в КАЖДУЮ незаписавшуюся строку, кроме САМОЙ НИЖНЕЙ.
 *     Так пользователь, находясь в любом месте таблицы, всегда видит: ниже
 *     есть ещё проблемы. Самая нижняя незаписавшаяся строка — без стрелки,
 *     это сигнал «дошли до конца».
 *
 * Стрелки появляются в td[6] (столбец hex контроллера), у левого края ячейки,
 * чтобы не мешать чтению значения справа.
 */
function markFailedRows(failedRows: HTMLTableRowElement[]): void {
    if (failedRows.length <= 1) return;

    for (let i = 0; i < failedRows.length - 1; i++) {
        const tr = failedRows[i];
        const hexCell = tr.querySelectorAll('td')[6] as HTMLTableCellElement | undefined;
        if (!hexCell) continue;

        // Защита от дублирования: если стрелка уже стоит — не добавляем.
        if (hexCell.querySelector('.copy-down-arrow')) continue;

        // Ячейка должна быть контекстом позиционирования для absolute-стрелки.
        // Иначе стрелка «прилипнет» к ближайшему позиционированному предку
        // (обычно это <table> или <body>) и окажется не в ячейке.
        hexCell.style.position = 'relative';

        const arrow = document.createElement('span');
        arrow.className = 'copy-down-arrow';
        arrow.textContent = '▼';
        // appendChild вместо prepend: при position:absolute место в DOM
        // не влияет на визуальное положение — стрелка и так ляжет поверх
        // содержимого слева, не сдвигая hex-значение.
        hexCell.appendChild(arrow);
    }
}

/** Считает батчи адресов (как getOptimizedBatches, но для массива адресов). */
function buildBatches(
    addresses: number[],
    maxGap = 10,
    maxRegisters = 125,
): { start: number; count: number }[] {
    const sorted = [...new Set(addresses)].sort((a, b) => a - b);
    if (sorted.length === 0) return [];

    const batches: { start: number; count: number }[] = [];
    let start = sorted[0];
    let end = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
        const addr = sorted[i];
        const gap = addr - end - 1;
        const newCount = addr - start + 1;
        if (gap > maxGap || newCount > maxRegisters) {
            batches.push({ start, count: end - start + 1 });
            start = addr;
            end = addr;
        } else {
            end = addr;
        }
    }
    batches.push({ start, count: end - start + 1 });
    return batches;
}

/**
 * Фаза 1 для одной строки: записать значение в контроллер БЕЗ обратного чтения.
 * Для byte/bit предварительное чтение всё равно нужно — чтобы подставить байт/бит
 * в текущее слово, не затерев соседние биты. Для words — только запись.
 *
 * Возвращает описание записи (для фазы 2) или null, если строку нельзя записать.
 */
async function writeOneTarget(
    tr: HTMLTableRowElement,
    slaveAddr: number,
): Promise<WrittenTarget | null> {
    const dataType = (tr.getAttribute('data-type') || '').toUpperCase();
    const sub = tr.getAttribute('data-sub') || '';
    const tds = tr.querySelectorAll('td');

    let parts: string[] = [];
    try { parts = JSON.parse(tr.dataset.parts || '[]'); } catch { parts = []; }

    let scale = 1.0;
    if (parts.length > 6 && parts[6]) {
        const parsedScale = parseFloat(parts[6].replace(',', '.'));
        if (!isNaN(parsedScale) && parsedScale !== 0) scale = parsedScale;
    }

    let bytePos: '' | 'L' | 'H' = '';
    if (dataType === 'TBYTE' || dataType === 'TPRMLIST') {
        bytePos = (sub || '').toUpperCase() as 'L' | 'H';
    }

    const baseText = (tds[4]?.textContent || '').trim();
    let valueStr = '';
    let editType: 'hex' | 'phys' = 'hex';

    if (dataType === 'TPRMLIST') {
        let found = '';
        for (const p of parts) {
            const part = (p || '').trim();
            if (part.includes('#')) {
                const [h, t] = part.split('#');
                if (h && t && t.trim() === baseText) { found = h.trim(); break; }
            }
        }
        if (!found) return null;
        valueStr = found;
    } else if (dataType === 'TBIT') {
        valueStr = baseText;
        editType = 'phys';
    } else {
        valueStr = baseText;
    }

    const plan = planControllerWrite(dataType, editType, valueStr, scale, sub, bytePos);
    if (!plan.ok) return null;

    const reg = parseInt(tr.getAttribute('data-reg') || '', 16);
    if (isNaN(reg)) return null;

    const hexIndex = parseInt(tr.getAttribute('data-hex-index') || '-1', 10);

    // ── WORDS: пишем без чтения ─────────────────────────────────────────────
    if (plan.kind === 'words') {
        await writeRegistersFC16(slaveAddr, reg, plan.words);
        return {
            tr, startReg: reg, expectedWords: plan.words, dataType,
            baseText, hexIndex, kind: 'words',
            byteValue: 0, bytePos: 'L', bitValue: 0,
        };
    }

    // ── BYTE: read-modify-write (соседний байт нельзя затирать) ─────────────
    if (plan.kind === 'byte') {
        const words = await readHoldingRegistersFC03(slaveAddr, reg, 1);
        if (!words) return null;
        const currentWord = words[0];
        const highByte = (currentWord >> 8) & 0xFF;
        const lowByte = currentWord & 0xFF;
        const newWord = plan.bytePos === 'H'
            ? ((plan.byteValue << 8) | lowByte) & 0xFFFF
            : ((highByte << 8) | plan.byteValue) & 0xFFFF;
        await writeRegistersFC16(slaveAddr, reg, [newWord]);
        return {
            tr, startReg: reg, expectedWords: [newWord], dataType,
            baseText, hexIndex, kind: 'byte',
            byteValue: plan.byteValue, bytePos: plan.bytePos, bitValue: 0,
        };
    }

    // ── BIT: read-modify-write (соседние биты нельзя затирать) ──────────────
    if (plan.kind === 'bit') {
        const words = await readHoldingRegistersFC03(slaveAddr, reg, 1);
        if (!words) return null;
        const currentWord = words[0];
        const bitMask = 1 << plan.bitIndex;
        const newWord = plan.bitValue === 1
            ? (currentWord | bitMask) & 0xFFFF
            : (currentWord & ~bitMask) & 0xFFFF;
        await writeRegistersFC16(slaveAddr, reg, [newWord]);
        return {
            tr, startReg: reg, expectedWords: [newWord], dataType,
            baseText, hexIndex, kind: 'bit',
            byteValue: 0, bytePos: 'L', bitValue: plan.bitValue,
        };
    }

    return null;
}

/**
 * Фаза 2: сгруппированное чтение всех затронутых регистров и обновление ячеек.
 * Обновляем ячейки только там, где прочитанное совпало с записанным.
 * Для несовпавших строк — ничего не трогаем, они подсветятся row-mismatch.
 *
 * Возвращает массив неуспешных строк в порядке появления в таблице
 * (сверху вниз). Внешний код использует его для стрелок ▼ и прокрутки.
 */
async function readBackAndUpdateUI(
    written: WrittenTarget[],
    slaveAddr: number,
): Promise<HTMLTableRowElement[]> {
    if (written.length === 0) return [];

    // Собираем все адреса, которые нужно прочитать (с учётом 32-битных слов).
    const allAddrs = new Set<number>();
    for (const w of written) {
        for (let i = 0; i < w.expectedWords.length; i++) {
            allAddrs.add(w.startReg + i);
        }
    }

    const batches = buildBatches([...allAddrs], 10, 125);
    console.log(
        `[BASE→CONTROLLER] Обратное чтение: ${allAddrs.size} регистров в ${batches.length} батч(ах)`,
    );

    const readMap = new Map<number, number>();
    for (const b of batches) {
        const words = await readHoldingRegistersFC03(slaveAddr, b.start, b.count);
        if (!words) {
            console.warn(`[BASE→CONTROLLER] Батч r${b.start.toString(16)}..r${(b.start + b.count - 1).toString(16)} не прочитан`);
            continue;
        }
        for (let i = 0; i < words.length; i++) {
            readMap.set(b.start + i, words[i]);
        }
    }

    let updated = 0;
    const failedRows: HTMLTableRowElement[] = [];
    for (const w of written) {
        // Проверяем, что все записанные слова прочитались обратно без изменений.
        let allMatch = true;
        for (let i = 0; i < w.expectedWords.length; i++) {
            if (readMap.get(w.startReg + i) !== w.expectedWords[i]) {
                allMatch = false;
                break;
            }
        }
        if (!allMatch) {
            // Запоминаем все неуспешные строки в порядке их появления в таблице.
            // Порядок важен: самая нижняя получит признак «последняя», и
            // стрелка ▼ в неё не ставится (см. markFailedRows).
            failedRows.push(w.tr);
            continue;
        }

        const tds = w.tr.querySelectorAll('td');
        if (tds[6] && tds[4]) tds[6].innerHTML = tds[4].innerHTML;
        if (tds[7] && tds[5]) tds[7].innerHTML = tds[5].innerHTML;

        let parts: string[] = [];
        try { parts = JSON.parse(w.tr.dataset.parts || '[]'); } catch { parts = []; }

        if (w.hexIndex >= 0 && w.hexIndex < parts.length) {
            if (w.kind === 'words') {
                parts[w.hexIndex] = w.baseText;
            } else if (w.kind === 'byte') {
                const byteHex = 'x' + w.byteValue.toString(16).toUpperCase().padStart(2, '0');
                parts[w.hexIndex] = byteHex;
            } else if (w.kind === 'bit') {
                const bitHex = 'x' + String(w.bitValue).padStart(4, '0');
                parts[w.hexIndex] = bitHex;
                if (parts.length > 0) parts[parts.length - 1] = bitHex;
            }
        }
        w.tr.dataset.parts = JSON.stringify(parts);

        updateMismatchClass(w.tr, w.dataType);
        updated++;
    }

    console.log(
        `[BASE→CONTROLLER] Подтверждено чтением: ${updated} из ${written.length}` +
        (failedRows.length > 0 ? `, не подтверждено: ${failedRows.length}` : ''),
    );
    return failedRows;
}

/**
 * Копирует в Контроллер только параметры, где База ≠ Контроллер.
 * Двухфазная схема: сначала все записи, потом одно групповое чтение.
 * Никаких модальных окон — успех/ошибка видны по подсветке строк.
 */
export async function copyBaseToController(): Promise<void> {
    const stateObj = getTableEditorState();
    const slaveAddr = stateObj?.slaveAddress ?? 0x01;

    const rows = Array.from(
        document.querySelectorAll<HTMLTableRowElement>('#grid-data-rows tr'),
    );

    // Отбираем строки: есть регистр И База ≠ Контроллер
    const targets: HTMLTableRowElement[] = [];
    for (const tr of rows) {
        const addrStr = tr.getAttribute('data-reg');
        if (!addrStr || isNaN(parseInt(addrStr, 16))) continue;
        const dataType = (tr.getAttribute('data-type') || '').toUpperCase();
        if (!baseControllerMismatch(tr, dataType)) continue;
        targets.push(tr);
    }

    if (targets.length === 0) {
        console.log('[BASE→CONTROLLER] Расхождений База/Контроллер нет — запись не требуется.');
        return;
    }

    console.log(`[BASE→CONTROLLER] Параметров к записи: ${targets.length}`);

    const wasPolling = stateObj?.isPolling === true;
    if (wasPolling && stateObj) {
        stateObj.isPolling = false;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const written: WrittenTarget[] = [];

    try {
        // Снимаем стрелки ▼ от предыдущего копирования — чтобы не накапливались.
        clearFailedArrows();

        // ─── ФАЗА 1: запись всех параметров (без чтения после каждой) ────────
        const t0 = Date.now();
        for (const tr of targets) {
            const result = await writeOneTarget(tr, slaveAddr);
            if (result) written.push(result);
        }
        console.log(
            `[BASE→CONTROLLER] Фаза 1 (запись): ${written.length} из ${targets.length} за ${Date.now() - t0} мс`,
        );

        // ─── ФАЗА 2: групповое чтение всех записанных регистров ──────────────
        const t1 = Date.now();
        const failedRows = await readBackAndUpdateUI(written, slaveAddr);
        console.log(`[BASE→CONTROLLER] Фаза 2 (чтение + UI): ${Date.now() - t1} мс`);

        // Ставим стрелки ▼ в незаписавшихся строках, кроме самой нижней.
        // Если незаписавшихся 0 или 1 — стрелки не появятся (см. markFailedRows).
        markFailedRows(failedRows);

        // Если что-то не записалось — прокручиваем таблицу к самой верхней
        // неуспешной строке, чтобы пользователь сразу её увидел. Дальше
        // ориентируется по стрелкам: ▼ = ниже есть ещё.
        if (failedRows.length > 0) {
            failedRows[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    } finally {
        if (wasPolling && stateObj) {
            stateObj.isPolling = true;
        }
    }

    // КРИТИЧНО: перед диспатчем события request-polling-restart нужно
    // дождаться, когда старый readLoop полностью завершится и сбросит
    // isLoopRunning = false. См. комментарий в предыдущей версии — логика
    // не изменилась.
    if (wasPolling) {
        const appStateRef = (window as unknown as {
            appState?: { isLoopRunning?: boolean };
        }).appState;

        const waitForLoopStop = async (): Promise<void> => {
            const MAX_WAIT_MS = 2000;
            const STEP_MS = 50;
            let waited = 0;
            while (appStateRef?.isLoopRunning && waited < MAX_WAIT_MS) {
                await new Promise((r) => setTimeout(r, STEP_MS));
                waited += STEP_MS;
            }
            if (appStateRef?.isLoopRunning) {
                console.warn(
                    '[BASE→CONTROLLER] readLoop не завершился за 2 сек — ' +
                    'перезапуск может не сработать',
                );
            }
        };
        void waitForLoopStop().then(() => {
            window.dispatchEvent(new CustomEvent('app:request-polling-restart'));
        });
    }
}