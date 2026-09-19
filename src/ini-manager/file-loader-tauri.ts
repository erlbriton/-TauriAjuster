/**
 * Модуль работы с файловой системой для нативного приложения (Tauri v2).
 * Заменяет браузерный API (showOpenFilePicker) на команды Tauri.
 */

// Исправленные импорты для Tauri v2 (используем плагины напрямую)
import { open } from '@tauri-apps/plugin-dialog';
// ИСПРАВЛЕНО: readTextFile → readFile (читаем СЫРЫЕ байты, чтобы правильно декодировать windows-1251).
// readTextFile всегда декодирует как UTF-8, из-за чего кириллица в INI превращалась в кракозябры.
import { readFile, readDir } from '@tauri-apps/plugin-fs';

import type { AppState } from '../core/app-state.js';
import { processSingleFileContent } from './file-loader.js';
// ИСПРАВЛЕНО: добавлен импорт декодера с автоопределением кодировки.
// Он сначала пробует строгий UTF-8, затем строгий windows-1251,
// и в крайнем случае — windows-1251 с заменой невалидных байтов.
import { decodeTextBuffer } from './textFileReader.js';

/**
 * Читает файл как массив байтов и декодирует с автоопределением кодировки.
 * Используется вместо readTextFile, который принудительно читает как UTF-8.
 * @param path Полный путь к файлу в файловой системе.
 * @returns Декодированная строка с корректной кириллицей.
 */
async function readFileWithAutoEncoding(path: string): Promise<string> {
  // readFile возвращает Uint8Array (сырые байты без декодирования).
  // TextDecoder принимает ArrayBufferView, но decodeTextBuffer ожидает ArrayBuffer,
  // поэтому извлекаем чистый ArrayBuffer из Uint8Array с учётом смещения
  // (на случай, если байты лежат в shared ArrayBuffer).
  const bytes = await readFile(path);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  );
  return decodeTextBuffer(buffer);
}

/**
 * Открывает диалог выбора одного или нескольких INI-файлов.
 * Читает их содержимое через Tauri FS и передает в обработчик.
 */
export async function openIniFileTauri(appState: AppState): Promise<void> {
  try {
    // Открываем диалог выбора файла
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: 'INI Files',
          extensions: ['ini', 'txt'],
        },
      ],
      title: 'Выберите файл(ы) конфигурации',
    });

    if (!selected) {
      console.log('[TauriLoader] Выбор отменен пользователем.');
      return;
    }

    // selected может быть строкой (один файл) или массивом строк (несколько файлов)
    const paths = Array.isArray(selected) ? selected : [selected];

    for (const path of paths) {
      if (typeof path !== 'string') continue;

      try {
        // ИСПРАВЛЕНО: читаем сырые байты и декодируем с автоопределением кодировки.
        // Раньше readTextFile читал как UTF-8, из-за чего кириллица превращалась в кракозябры.
        const content = await readFileWithAutoEncoding(path);
        
        // Извлекаем имя файла из полного пути
        const fileName = path.split('/').pop()?.split('\\').pop() || 'unknown.ini';
        
        // Создаем фейковый объект File для совместимости сигнатуры функции
        const fakeFile = new File([content], fileName, { type: 'text/plain' });
        
        // Обрабатываем файл. 
        // ВАЖНО: передаем undefined вместо null для последнего аргумента (FileSystemFileHandle)
        await processSingleFileContent(content, fileName, appState, fakeFile, undefined);
        
        console.log(`[TauriLoader] Файл успешно загружен: ${path}`);
      } catch (err) {
        console.error(`[TauriLoader] Ошибка чтения файла ${path}:`, err);
      }
    }
  } catch (err) {
    console.error('[TauriLoader] Ошибка открытия диалога файла:', err);
  }
}

/**
 * Открывает диалог выбора папки.
 * Сканирует папку на наличие .ini файлов и загружает их.
 */
export async function openIniFolderTauri(appState: AppState): Promise<void> {
  try {
    // Открываем диалог выбора директории
    const selectedDir = await open({
      directory: true,
      title: 'Выберите папку с конфигурациями',
    });

    if (!selectedDir || typeof selectedDir !== 'string') {
      console.log('[TauriLoader] Выбор папки отменен.');
      return;
    }

    console.log(`[TauriLoader] Выбрана папка: ${selectedDir}`);

    try {
      // Читаем содержимое папки через Tauri FS
      const entries = await readDir(selectedDir);
      
      let loadedCount = 0;
      let errorCount = 0;

      for (const entry of entries) {
        if (entry.isFile && (entry.name.endsWith('.ini') || entry.name.endsWith('.txt'))) {
          // Формируем полный путь. Tauri возвращает нативные пути, склейка через '/' обычно работает кроссплатформенно в JS,
          // но для надежности можно использовать path.join, если бы это был Node. В браузере/Tauri JS такая склейка допустима.
          const fullPath = `${selectedDir}/${entry.name}`; 
          
          try {
            // ИСПРАВЛЕНО: читаем сырые байты и декодируем с автоопределением кодировки.
            const content = await readFileWithAutoEncoding(fullPath);
            const fakeFile = new File([content], entry.name, { type: 'text/plain' });
            
            // Передаем undefined вместо null
            await processSingleFileContent(content, entry.name, appState, fakeFile, undefined);
            loadedCount++;
          } catch (err) {
            console.error(`Ошибка чтения ${entry.name}:`, err);
            errorCount++;
          }
        }
      }

      if (loadedCount > 0) {
        console.log(`[TauriLoader] Загружено файлов: ${loadedCount}`);
      } else {
        console.warn('[TauriLoader] INI файлы в папке не найдены.');
      }
      
      if (errorCount > 0) {
        console.warn(`[TauriLoader] Ошибок при чтении: ${errorCount}`);
      }

    } catch (dirErr) {
      console.error('[TauriLoader] Ошибка чтения содержимого папки:', dirErr);
    }

  } catch (err) {
    console.error('[TauriLoader] Ошибка открытия диалога папки:', err);
  }
}