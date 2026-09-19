// src/core/platform/tauri-fs.ts
// Нативная реализация сохранения файлов для Tauri.
// Записывает файлы молча в папку "Records" рядом с исполняемым файлом.
// Если папки нет — спрашивает пользователя, создавать ли её.

import { ask } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
// exists и mkdir больше не нужны — проверка и создание папки вынесены в Rust-команду
// executableDir тоже не нужен — путь определяется на Rust-стороне
import type { IFileSaver } from './fs.js';

/**
 * Tauri-реализация сохранения файлов.
 * Пишет файлы в папку "Records" рядом с исполняемым файлом без диалога выбора.
 * Если папки "Records" не существует — спрашивает пользователя, создавать ли её.
 * При отказе — тихо выходит (файл не сохраняется).
 */
export class TauriFileSaver implements IFileSaver {
  /**
   * Возвращает путь к папке "Records" рядом с исполняемым файлом.
   * Если папки не существует — спрашивает пользователя, создавать ли её.
   * При согласии — создаёт папку. При отказе — возвращает null.
   *
   * Вся логика проверки/создания вынесена в Rust-команду ensure_records_dir,
   * чтобы обойти ограничения скоупа плагина fs (который запрещает операции
   * с произвольными путями без явного разрешения каждого пути).
   * Rust-сторона не имеет скоупов и работает с любыми путями.
   */
  private async getOrCreateRecordsDir(): Promise<string | null> {
    try {
      // Вызываем Rust-команду: сначала пытаемся получить путь БЕЗ создания
      const invoke = (window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__.core.invoke;
      
      try {
        // invoke из window.__TAURI__.core не принимает generic-параметр,
        // поэтому явно приводим результат (который Rust возвращает как String)
        // к типу string через as string.
        const recordsDir = (await invoke('ensure_records_dir', { create: false })) as string;
        return recordsDir;
      } catch (error) {
        // Проверяем, это наша специальная ошибка "папки нет" или реальная ошибка
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (errorMsg !== 'RECORDS_DIR_NOT_FOUND') {
          // Реальная ошибка (нет прав, проблема с файловой системой) — пробрасываем
          throw error;
        }

        // Папки нет — спрашиваем пользователя, создавать ли её
        const shouldCreate = await ask(
          `Папка Records не найдена рядом с приложением.\n\nСоздать папку Records?`,
          {
            title: 'Папка Records',
            kind: 'info',
          }
        );

        if (!shouldCreate) {
          // Пользователь отказался — тихо выходим
          console.log('[TauriFileSaver] Пользователь отказался создавать папку Records');
          return null;
        }

        // Создаём папку (вызываем Rust-команду с create: true)
        // invoke из window.__TAURI__.core не принимает generic-параметр,
        // поэтому явно приводим результат к типу string через as string.
        const recordsDir = (await invoke('ensure_records_dir', { create: true })) as string;
        console.log(`[TauriFileSaver] Папка создана: ${recordsDir}`);
        return recordsDir;
      }
    } catch (error) {
      console.error('[TauriFileSaver] Ошибка при получении/создании папки Records:', error);
      throw new Error(`Не удалось получить доступ к папке Records: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Сохраняет текстовый файл в папку "Records" рядом с исполняемым файлом.
   * @param filename Предлагаемое имя файла.
   * @param content Текстовое содержимое.
   * @param mimeType MIME-тип (не используется в Tauri-режиме, сохранён для совместимости интерфейса).
   */
  public async saveTextFile(
    filename: string,
    content: string,
    mimeType: string = 'text/plain;charset=utf-8'
  ): Promise<void> {
    // Получаем путь к папке Records (создаём при необходимости)
    const recordsDir = await this.getOrCreateRecordsDir();
    if (!recordsDir) {
      // Пользователь отказался создавать папку — тихо выходим
      return;
    }

    // Формируем полный путь к файлу
    const filePath = `${recordsDir}/${filename}`;

    // Конвертируем строку в Uint8Array для совместимости с writeFile
    const encoder = new TextEncoder();
    const data = encoder.encode(content);

    try {
      // Записываем файл молча, без диалога
      await writeFile(filePath, data);
      console.log(`[TauriFileSaver] Текстовый файл успешно сохранен: ${filePath}`);
    } catch (error) {
      console.error('[TauriFileSaver] Ошибка при записи файла:', error);
      throw new Error(`Не удалось сохранить файл: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Сохраняет бинарный файл (например, .rec) в папку "Records" рядом с исполняемым файлом.
   * @param filename Предлагаемое имя файла.
   * @param data Массив байтов (Uint8Array).
   * @param mimeType MIME-тип (не используется в Tauri-режиме, сохранён для совместимости интерфейса).
   */
  public async saveBinaryFile(
    filename: string,
    data: Uint8Array,
    mimeType: string = 'application/octet-stream'
  ): Promise<void> {
    // Получаем путь к папке Records (создаём при необходимости)
    const recordsDir = await this.getOrCreateRecordsDir();
    if (!recordsDir) {
      // Пользователь отказался создавать папку — тихо выходим
      return;
    }

    // Формируем полный путь к файлу
    const filePath = `${recordsDir}/${filename}`;

    try {
      // Записываем файл молча, без диалога
      await writeFile(filePath, data);
      console.log(`[TauriFileSaver] Бинарный файл успешно сохранен: ${filePath}`);
    } catch (error) {
      console.error('[TauriFileSaver] Ошибка при записи файла:', error);
      throw new Error(`Не удалось сохранить файл: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}