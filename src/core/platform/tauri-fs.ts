// src/core/platform/tauri-fs.ts
// Нативная реализация сохранения файлов для Tauri.
// Использует плагины @tauri-apps/plugin-dialog и @tauri-apps/plugin-fs.

import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs'; // ИСПРАВЛЕНО: writeBinaryFile -> writeFile
import type { IFileSaver } from './fs.js';

/**
 * Tauri-реализация сохранения файлов.
 * Открывает нативный диалог выбора пути и записывает файл через FS API.
 */
export class TauriFileSaver implements IFileSaver {
  /**
   * Сохраняет текстовый файл.
   * @param filename Предлагаемое имя файла.
   * @param content Текстовое содержимое.
   * @param mimeType MIME-тип (используется для фильтра в диалоге).
   */
  public async saveTextFile(
    filename: string,
    content: string,
    mimeType: string = 'text/plain;charset=utf-8'
  ): Promise<void> {
    // Открываем диалог сохранения. Возвращает путь (string) или null, если отменено.
    const path = await save({
      defaultPath: filename,
      filters: [
        {
          name: 'Текстовый файл',
          extensions: ['txt', 'csv', 'log'],
        },
      ],
    });

    if (!path) {
      // Пользователь отменил сохранение
      return;
    }

    // Записываем строку в файл по указанному пути
    // Конвертируем строку в Uint8Array для совместимости с writeFile
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    
    // ИСПРАВЛЕНО: используем writeFile вместо writeBinaryFile
    await writeFile(path, data);
    console.log(`[TauriFileSaver] Файл успешно сохранен: ${path}`);
  }

  /**
   * Сохраняет бинарный файл (например, .rec).
   * @param filename Предлагаемое имя файла.
   * @param data Массив байтов (Uint8Array).
   * @param mimeType MIME-тип (для фильтра диалога).
   */
  public async saveBinaryFile(
    filename: string,
    data: Uint8Array,
    mimeType: string = 'application/octet-stream'
  ): Promise<void> {
    // Открываем диалог сохранения с фильтром для бинарных файлов
    const path = await save({
      defaultPath: filename,
      filters: [
        {
          name: 'Файл записи осциллографа',
          extensions: ['rec'],
        },
        {
          name: 'Все файлы',
          extensions: ['*'],
        },
      ],
    });

    if (!path) {
      // Пользователь отменил сохранение
      console.log('[TauriFileSaver] Сохранение отменено пользователем');
      return;
    }

    try {
      // Записываем бинарные данные в файл
      // writeFile автоматически распознает Uint8Array как бинарные данные
      await writeFile(path, data);
      console.log(`[TauriFileSaver] Бинарный файл успешно сохранен: ${path}`);
    } catch (error) {
      console.error('[TauriFileSaver] Ошибка при записи файла:', error);
      throw new Error(`Не удалось сохранить файл: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}