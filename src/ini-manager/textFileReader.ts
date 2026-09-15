// ini-manager/textFileReader.ts

/**
 * Платформенно-независимое чтение текстовых файлов с автоопределением кодировки.
 *
 * Стратегия определения кодировки:
 *   1. Строгий UTF-8 (fatal) — если файл валидный UTF-8, читаем как UTF-8.
 *   2. Строгий windows-1251 (fatal) — для INI-файлов контроллера в кириллице.
 *   3. windows-1251 с заменой невалидных байтов — финальный fallback
 *      (выбран windows-1251, т.к. INI-файлы контроллера в основном в этой кодировке).
 *
 * Разделение на две функции — это платформенный шов для переноса в Tauri:
 *   - decodeTextBuffer() — чистая логика декодирования, переносится без изменений;
 *   - readTextFile()     — в браузере читает через File.arrayBuffer();
 *                          в нативном проекте источник байтов будет заменён
 *                          на FS-плагин Tauri, сигнатура останется прежней.
 */

/**
 * Декодирует буфер байтов в строку с автоопределением кодировки.
 * Чистая функция — не зависит от платформы и DOM.
 */
export function decodeTextBuffer(buffer: ArrayBuffer): string {
    // 1. Пробуем строгий UTF-8
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        // не UTF-8 — пробуем следующую кодировку
    }

    // 2. Пробуем строгий windows-1251 (кириллица контроллера)
    try {
        return new TextDecoder('windows-1251', { fatal: true }).decode(buffer);
    } catch {
        // не windows-1251 — идём в финальный fallback
    }

    // 3. Финальный fallback: windows-1251 без fatal (невалидные байты заменяются)
    return new TextDecoder('windows-1251').decode(buffer);
}

/**
 * Читает файл как текст с автоопределением кодировки.
 * Браузерная реализация: File.arrayBuffer() + decodeTextBuffer().
 */
export async function readTextFile(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    return decodeTextBuffer(buffer);
}