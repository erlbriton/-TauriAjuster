// src/core/platform/browser-fs.ts
// Браузерные реализации платформенных контрактов.

import type { IFileSaver, IFileSystem, SelectedFile, FileFilter } from './fs.js';
import { decodeTextBuffer } from '../../ini-manager/textFileReader.js';

/**
 * Браузерная реализация сохранения файлов.
 * Использует Blob + URL.createObjectURL + <a download>.
 * Для бинарных файлов предпочитает showSaveFilePicker
 * (системный диалог "Сохранить как" с выбором имени и папки).
 */
export class BrowserFileSaver implements IFileSaver {
  public async saveTextFile(
    filename: string,
    content: string,
    mimeType: string = 'text/plain;charset=utf-8'
  ): Promise<void> {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  public async saveBinaryFile(
    filename: string,
    data: Uint8Array,
    mimeType: string = 'application/octet-stream'
  ): Promise<void> {
    // Копируем данные в НОВЫЙ ArrayBuffer, чтобы тип стал
    // Uint8Array<ArrayBuffer> — этого требует Blob в TypeScript 5.7+
    const safe = new Uint8Array(data);

    // Пытаемся открыть системный диалог "Сохранить как"
    const w = window as unknown as {
      showSaveFilePicker?: (options: unknown) => Promise<{
        createWritable(): Promise<{
          write(d: Uint8Array): Promise<void>;
          close(): Promise<void>;
        }>;
      }>;
    };

    if (typeof w.showSaveFilePicker === 'function') {
      try {
        const handle = await w.showSaveFilePicker({
          suggestedName: filename,
          types: [
            {
              description: 'Файл записи осциллографа',
              accept: { 'application/octet-stream': ['.rec'] },
            },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(safe);
        await writable.close();
        return;
      } catch (err) {
        // Пользователь отменил диалог — тихо выходим
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        // Иначе падаем в fallback ниже
      }
    }

    // Fallback: обычное скачивание
    const blob = new Blob([safe], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

/**
 * Браузерная реализация файловой системы.
 * Использует File API (input type="file") и FileReader.
 * В Tauri будет заменена на tauri-plugin-dialog + tauri-plugin-fs.
 */
export class BrowserFileSystem implements IFileSystem {
  public async selectFiles(options?: {
    multiple?: boolean;
    filters?: FileFilter[];
  }): Promise<SelectedFile[]> {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = options?.multiple ?? false;

      if (options?.filters && options.filters.length > 0) {
        const extensions = options.filters
          .flatMap(f => f.extensions)
          .map(ext => `.${ext}`)
          .join(',');
        input.accept = extensions;
      }

      input.addEventListener('change', async () => {
        if (!input.files || input.files.length === 0) {
          resolve([]);
          return;
        }

        const files: SelectedFile[] = [];
        for (const file of Array.from(input.files)) {
          try {
            const buffer = await file.arrayBuffer();
            const content = decodeTextBuffer(buffer);
            files.push({
              name: file.name,
              path: file.name, // в браузере путь недоступен
              size: file.size,
              lastModified: file.lastModified,
              content,
            });
          } catch (err) {
            console.error(`[BrowserFileSystem] Failed to read ${file.name}:`, err);
          }
        }
        resolve(files);
      });

      input.addEventListener('cancel', () => resolve([]));
      input.click();
    });
  }

  public async selectDirectory(): Promise<SelectedFile[] | null> {
    // В браузере нет стандартного API для выбора папки с чтением файлов.
    // Используем webkitdirectory как fallback.
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;

      input.addEventListener('change', async () => {
        if (!input.files || input.files.length === 0) {
          resolve(null);
          return;
        }

        const files: SelectedFile[] = [];
        for (const file of Array.from(input.files)) {
          try {
            const buffer = await file.arrayBuffer();
            const content = decodeTextBuffer(buffer);
            files.push({
              name: file.name,
              path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
              size: file.size,
              lastModified: file.lastModified,
              content,
            });
          } catch (err) {
            console.error(`[BrowserFileSystem] Failed to read ${file.name}:`, err);
          }
        }
        resolve(files);
      });

      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
  }

  public async readTextFile(path: string): Promise<string> {
    // В браузере нет доступа к файлам по пути.
    // Этот метод используется только в нативном режиме.
    throw new Error('readTextFile не поддерживается в браузерном режиме. Используйте selectFiles().');
  }

  public async writeTextFile(path: string, content: string): Promise<void> {
    // В браузере нет записи файлов по пути.
    // Этот метод используется только в нативном режиме.
    throw new Error('writeTextFile не поддерживается в браузерном режиме. Используйте BrowserFileSaver.');
  }
}