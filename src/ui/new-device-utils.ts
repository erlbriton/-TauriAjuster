// src/ui/new-device-utils.ts
// Вспомогательные утилиты для логики «Добавить устройство в базу»
// (см. new-device-add.ts).
//
// Файл выделен из new-device-add.ts, чтобы не смешивать основную логику
// (чтение шаблона, работа с fileStore, ветки Tauri/браузер) с чистыми
// функциями: определение режима Tauri, санитизация имён файлов,
// вычисление имени подпапки, сборка содержимого INI, подсветка узла
// в дереве.

import { getAllDevices } from '../ini-manager/tree-core.js';

/**
 * Определяет, запущено ли приложение в нативном режиме (Tauri v2).
 * В Tauri рантайм создаёт глобальный объект `window.__TAURI__` автоматически;
 * в обычном браузере его нет. Та же проверка используется в save-ini.ts.
 *
 * Зачем это здесь: браузерный File System Access API (showDirectoryPicker,
 * getFileHandle, createWritable, showSaveFilePicker) в WebView Tauri недоступен,
 * поэтому цепочка ensureDbFolder → saveFileToDbFolder → downloadFallback
 * в нативном режиме молча ничего не делает. Для Tauri нужна отдельная ветка
 * записи через @tauri-apps/plugin-fs.
 */
export function isTauriMode(): boolean {
    return typeof window !== 'undefined' && '__TAURI__' in window;
}

/** Убирает недопустимые символы из имени файла для File System Access API (Windows не разрешает !:*?"<>| и т.п.). */
export function sanitizeFileNameLoose(name: string): string {
    return name.replace(/[\\/:*?"<>|!]/g, '_');
}

/**
 * Вычисляет имя подпапки внутри Devices для нового или обновляемого INI.
 *
 * Правила (по согласованию с заказчиком):
 *  1. Если Location задан — имя папки = Location (с санитизацией).
 *     Пример: Location=Огонь → папка "Огонь".
 *  2. Если Location пустой — берём токены ID-строки между серийным номером
 *     и датой прошивки. Это тип устройства и (если есть) версия.
 *     Пример: "00004000 DExS.AVS v1.10.6.3 18.07.2022 www.intmash.ru"
 *       → "DExS.AVS v1.10.6.3"
 *     Пример: "00001011 DExS.AVK 18.07.2022 www.intmash.ru"
 *       → "DExS.AVK"
 *  3. Если ни Location, ни токенов из ID не получилось — возвращаем null.
 *     Вызывающий код должен показать ошибку и НЕ сохранять файл.
 *
 * Функция чистая (только вычисление). Создание самой папки — отдельная
 * Rust-команда ensure_device_subdir.
 */
export function resolveDeviceSubdirName(location: string, idText: string): string | null {
    // 1. Location задан — используем его.
    const loc = location.trim();
    if (loc) {
        return sanitizeFileNameLoose(loc);
    }

    // 2. Location пустой — извлекаем токены из ID-строки.
    //    Формат: "<серийник> <тип> [<версия>] <дата> [<URL>]".
    //    Идём от второго токена к концу, пока не встретим дату или URL.
    const tokens = idText.trim().split(/\s+/);
    if (tokens.length < 2) return null;

    const middle: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        // Дата вида dd.mm.yyyy — дальше начинается «хвост», останавливаемся.
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(t)) break;
        // URL (www.* или что-то похожее на домен .ru/.com/.net/.org) — тоже стоп.
        if (t.includes('www.') || /^[\w.-]+\.(ru|com|net|org)$/i.test(t)) break;
        middle.push(t);
    }
    if (middle.length === 0) return null;

    return sanitizeFileNameLoose(middle.join(' '));
}

/**
 * Вставляет/заменяет в секции [DEVICE] шаблона строки ID=, Location=, Description=.
 *
 * Особенности:
 *  - ID= всегда заменяется на полную строку подключённого контроллера;
 *  - Location= и Description= присутствуют в [DEVICE] ВСЕГДА, даже если
 *    значения из полей пустые (тогда строки будут вида "Location=" без
 *    значения). Это соглашение структуры INI-файлов проекта — см. также
 *    buildBackupContent в backup-ui.ts, где применена та же логика;
 *  - если в шаблоне строки не было — она добавляется в конец [DEVICE];
 *  - если в шаблоне вообще нет секции [DEVICE] — создаём её целиком.
 */
export function buildDeviceIniContent(
    templateText: string,
    idText: string,
    location: string,
    description: string,
): string {
    const lines = templateText.split(/\r?\n/);
    const out: string[] = [];
    let inDevice = false;
    let deviceSeen = false;
    let idDone = false;
    let locDone = false;
    let descDone = false;

    const flushMissing = (): void => {
        if (!idDone) out.push(`ID=${idText}`);
        if (!locDone) out.push(`Location=${location}`);
        if (!descDone) out.push(`Description=${description}`);
    };

    for (const line of lines) {
        const trimmed = line.trim();
        const sec = trimmed.match(/^\[(.*)\]$/);
        if (sec) {
            if (inDevice) flushMissing();
            inDevice = ((sec[1] ?? '').trim().toUpperCase() === 'DEVICE');
            if (inDevice) deviceSeen = true;
            out.push(line);
            continue;
        }
        if (inDevice && trimmed.includes('=')) {
            const key = trimmed.split('=')[0].trim().toLowerCase();
            if (key === 'id') {
                out.push(`ID=${idText}`);
                idDone = true;
                continue;
            }
            if (key === 'location') {
                out.push(`Location=${location}`);
                locDone = true;
                continue;
            }
            if (key === 'description') {
                out.push(`Description=${description}`);
                descDone = true;
                continue;
            }
        }
        out.push(line);
    }
    if (inDevice) flushMissing();
    if (!deviceSeen) {
        // В шаблоне не было секции [DEVICE] — создаём с нуля.
        // Location= и Description= пишем всегда, даже если пустые.
        out.unshift(
            '[DEVICE]',
            `ID=${idText}`,
            `Location=${location}`,
            `Description=${description}`,
            '',
        );
    }
    return out.join('\n');
}

/** Выделяет в дереве узел только что добавленного устройства. */
export function selectNewDeviceInTree(idText: string): void {
    const found = getAllDevices().find((d) => (d.iniConfig.device ? d.iniConfig.device.id : '') === idText);
    if (!found) return;
    document.querySelectorAll('.tree-id-item.is-selected').forEach((el) => el.classList.remove('is-selected'));
    const leaf = document.querySelector(`.tree-id-item.is-leaf[data-device-id="${CSS.escape(found.id)}"]`);
    if (leaf) leaf.classList.add('is-selected');
}