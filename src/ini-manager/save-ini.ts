// src/ini-manager/save-ini.ts
// Кнопка "Сохранить изменения": хирургическая правка токенов значений
// в исходном тексте INI + запись в файл в кодировке windows-1251.

import { showIdModal, populateDeviceForm } from '../ui/ui.js';
import { showConfirmDialog } from '../ui/confirm-dialog.js';
import { getCurrentIniFileHandle, getFileStore, getCurrentIniFilePath } from './file-loader.js';
import { updateDeviceInRegistry } from './tree-core.js';
import type { RawIniConfig } from './tree-core.js';
import { IniParser, IniConfig } from '../core/ini/index.js';
import type { AppState } from '../core/app-state.js';
import { clearAllDirty } from './dirty-tracker.js';


// ─────────────────────────────────────────────
// Строгая типизация для File System Access API (без any)
// ─────────────────────────────────────────────

type FileHandleType = NonNullable<ReturnType<typeof getCurrentIniFileHandle>>;

interface WindowWithFileSystem extends Window {
  showSaveFilePicker(options?: {
    suggestedName?: string;
    types?: { description?: string; accept?: Record<string, string[]> }[];
  }): Promise<FileHandleType>;
}

type AppStateWithHandle = AppState & { currentIniFileHandle?: FileHandleType };

// ─────────────────────────────────────────────
// Кодировка windows-1251 для записи
// ─────────────────────────────────────────────

let charToByte: Map<number, number> | null = null;

function getCharToByte(): Map<number, number> {
  if (charToByte) return charToByte;
  const decoder = new TextDecoder('windows-1251');
  const map = new Map<number, number>();
  const buf = new Uint8Array(1);
  for (let b = 0; b < 256; b++) {
    buf[0] = b;
    const ch = decoder.decode(buf);
    if (ch.length === 1) map.set(ch.charCodeAt(0), b);
  }
  charToByte = map;
  return map;
}

/** Кодирует строку в байты windows-1251 */
function encodeWindows1251(text: string): Uint8Array<ArrayBuffer> {
  const map = getCharToByte();
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      out[i] = code;
    } else {
      const b = map.get(code);
      out[i] = b !== undefined ? b : 0x3F; // '?' для неотображаемых
    }
  }
  return out;
}

// ─────────────────────────────────────────────
// Вспомогательные функции для проверки реальных изменений
// ─────────────────────────────────────────────

/** Получает оригинальное значение токена из исходного текста INI */
function getOriginalToken(originalText: string, key: string, hexIndex: number): string | null {
  const keyRe = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=');
  const lines = originalText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (keyRe.test(trimmed)) {
      const eq = line.indexOf('=');
      if (eq === -1) return null;
      const rawValue = line.substring(eq + 1);
      const tokens = rawValue.split('/');
      let idx = tokens.length - 1;
      if (tokens[idx] === '') idx--; // пропускаем пустой хвостовой токен
      if (hexIndex >= 0 && hexIndex <= idx) {
        return tokens[hexIndex].trim();
      }
      return null;
    }
  }
  return null;
}

/** Проверяет, существует ли ключ баннера в исходном тексте INI */
function hasBannerKeyInOriginal(originalText: string, key: string): boolean {
  const keyRe = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=');
  const lines = originalText.split(/\r?\n/);
  for (const line of lines) {
    if (keyRe.test(line.trim())) {
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────
// Сохранение
// ─────────────────────────────────────────────

export async function saveIniChanges(appState: AppState): Promise<boolean> {
  const original = appState.currentIniContent;
  let fileHandle = getCurrentIniFileHandle();
  const filePath = getCurrentIniFilePath();
  const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

  if (!original) {
    showIdModal('Нет данных для сохранения');
    return false;
  }

  // В Tauri режиме fileHandle всегда null, используем filePath
  if (!isTauri && !fileHandle) {
    try {
      // Исправление TS2352: безопасное приведение типа через unknown
      const win = window as unknown as WindowWithFileSystem;
      fileHandle = await win.showSaveFilePicker({
        suggestedName: 'config.ini',
        types: [
          {
            description: 'INI Files',
            accept: { 'text/plain': ['.ini'] },
          },
        ],
      });
      
      // Безопасное сохранение хендла в appState
      (appState as AppStateWithHandle).currentIniFileHandle = fileHandle;
      
    } catch (err) {
      // Пользователь нажал "Отмена" в диалоге сохранения
      return false;
    }
  }

  // Явная проверка: в браузере нужен fileHandle, в Tauri - filePath
  if (!isTauri && !fileHandle) {
    showIdModal('Ошибка: не удалось получить дескриптор файла');
    return false;
  }
  if (isTauri && !filePath) {
    showIdModal('Ошибка: не известен путь к файлу в Tauri');
    return false;
  }

  // 1. Собираем изменения из таблицы: key → весь массив parts
  const rows = Array.from(
    document.querySelectorAll<HTMLTableRowElement>('#grid-data-rows tr'),
  );
  const changes: { key: string; hexValue: string; hexIndex: number; multiplier: string }[] = [];

  for (const tr of rows) {
    const key = tr.getAttribute('data-key') || '';
    if (!key) continue;

    const tds = tr.querySelectorAll('td');
    if (tds.length < 8) continue;

    const dataType = (tr.getAttribute('data-type') || '').toUpperCase();
    const baseText = (tds[4]?.textContent || '').trim();
    if (!baseText || baseText === '—') continue;

    let parts: string[] = [];
    try { parts = JSON.parse(tr.dataset.parts || '[]'); } catch { continue; }

    const hexIndex = parseInt(tr.getAttribute('data-hex-index') || '-1', 10);
    if (hexIndex < 0 || hexIndex >= parts.length) continue;

    let hexValue = (parts[hexIndex] || '').trim();

    if (dataType === 'TPRMLIST') {
      hexValue = '';
      for (const p of parts) {
        const part = (p || '').trim();
        if (part.includes('#')) {
          const [h, t] = part.split('#');
          if (h && t && t.trim() === baseText) { hexValue = h.trim(); break; }
        }
      }
    }

    if (!hexValue) continue;

    // КРИТИЧЕСКИ ВАЖНО: Проверяем, действительно ли значение изменилось
    const originalHexValue = getOriginalToken(original, key, hexIndex);
    if (originalHexValue === hexValue) {
      continue; // Значение не изменилось, не трогаем эту строку!
    }

    const multiplier = parts.length > 9 ? (parts[9] ?? '').trim() : '';
    changes.push({ key, hexValue, hexIndex, multiplier });
  }

  // 2. Собираем изменения из баннеров (Механизм, Место установки, Дата)
  const mechanismInput = document.querySelector<HTMLInputElement>('.mechanism-input');
  const locationInput = document.querySelector<HTMLInputElement>('.location-input');
  const dateInput = document.querySelector<HTMLInputElement>('.date-input');

  const bannerUpdates = [
    { key: 'Description', value: mechanismInput?.value.trim() ?? '' },
    { key: 'Location', value: locationInput?.value.trim() ?? '' },
    { key: 'Date', value: dateInput?.value.trim() ?? '' }
  ].filter(update => {
    // ИСПРАВЛЕНИЕ: Обновляем баннер ТОЛЬКО если этот ключ УЖЕ существует в исходном файле.
    // Это предотвратит появление "Date=..." в конце файла, если его там не было.
    if (!hasBannerKeyInOriginal(original, update.key)) {
      return false; 
    }
    
    // И проверяем, что значение действительно отличается от оригинала
    const keyRe = new RegExp('^' + update.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=');
    const lines = original.split(/\r?\n/);
    for (const line of lines) {
      if (keyRe.test(line.trim())) {
        const eq = line.indexOf('=');
        const originalVal = line.substring(eq + 1).trim();
        return update.value !== originalVal;
      }
    }
    return false;
  });

  if (changes.length === 0 && bannerUpdates.length === 0) {
    showIdModal('Нет изменений для сохранения');
    return false;
  }

  console.log('[SAVE] Собранные изменения:', JSON.stringify(changes.slice(0, 10)));

  // 3. Хирургическая правка: обновляем строки в содержимом INI
  const sep = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  let applied = 0;

  // 3.1. Применяем изменения из таблицы
  for (const change of changes) {
    const keyRe = new RegExp(
      '^' + change.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=',
    );
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!keyRe.test(trimmed)) continue;

      const eq = line.indexOf('=');
      const rawValue = line.substring(eq + 1);
      const tokens = rawValue.split('/');
      let idx = tokens.length - 1;
      if (tokens[idx] === '') idx--; 
      if (idx < 0) break;

      const targetIdx = change.hexIndex < tokens.length ? change.hexIndex : idx;
      tokens[targetIdx] = change.hexValue;
      if (change.multiplier !== '' && tokens.length > 9) {
        tokens[9] = change.multiplier;
      }

      // Сохраняем оригинальное форматирование ДО знака '=', меняем только значение
      lines[i] = line.substring(0, eq + 1) + tokens.join('/');
      applied++;
      break;
    }
  }

  // 3.2. Применяем изменения из баннеров
  for (const update of bannerUpdates) {
    const keyRe = new RegExp(
      '^' + update.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=',
    );
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (keyRe.test(trimmed)) {
        const eq = line.indexOf('=');
        // Сохраняем оригинальные пробелы ДО знака '=', меняем только то, что ПОСЛЕ
        lines[i] = line.substring(0, eq + 1) + update.value;
        applied++;
        break;
      }
    }
    // Обратите внимание: блок lines.push() здесь полностью удален. 
    // Мы больше никогда не добавляем ключи баннеров в конец файла.
  }

  if (applied === 0) {
    showIdModal('Не удалось применить изменения');
    return false;
  }

  const newContent = lines.join(sep);

  try {
    if (isTauri && filePath) {
      // Нативное сохранение через Tauri FS
      const { writeFile } = await import('@tauri-apps/plugin-fs');
      // encodeWindows1251 определена в этом же файле и возвращает Uint8Array, что идеально для writeFile
      const encodedContent = encodeWindows1251(newContent);
      await writeFile(filePath, encodedContent);
    } else if (fileHandle) {
      // Браузерное сохранение через File System Access API
      const writable = await fileHandle.createWritable();
      await writable.write(encodeWindows1251(newContent));
      await writable.close();
    }

    appState.currentIniContent = newContent;
    clearAllDirty();
    
    // 4. КРИТИЧЕСКИ ВАЖНО: Обновляем внутренний реестр (deviceRegistry / fileStore)
    const store = getFileStore();
    let matchingEntry = null;
    for (const entry of store.values()) {
      // В Tauri ищем по пути, в браузере - по handle
      if ((isTauri && entry.path === filePath) || (!isTauri && entry.handle === fileHandle)) {
        matchingEntry = entry;
        break;
      }
    }

    if (matchingEntry) {
      const parser = new IniParser();
      const parseResult = parser.parse(newContent);
      const newIniConfig = new IniConfig(parseResult);
      const newConfig = parseResult.rawSections as RawIniConfig;

      matchingEntry.content = newContent;
      matchingEntry.lastModified = Date.now();

      updateDeviceInRegistry(matchingEntry.location, matchingEntry.id, newIniConfig, newConfig);
      
      const deviceConfig = newConfig['DEVICE'] as Record<string, string> | undefined;
      if (deviceConfig) {
        populateDeviceForm(deviceConfig);
      }
    }

    showIdModal(`Сохранено: ${applied} параметров`);
    console.log(`[SAVE] Файл сохранён (windows-1251), обновлено: ${applied}`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    showIdModal('Ошибка записи файла: ' + msg);
    console.error('[SAVE] Write error:', err);
    return false;
  }
}

/**
 * Подключает обработчик к кнопке "Сохранить изменения" (#save-btn).
 */
export function setupSaveButton(appState: AppState): void {
  const btn = document.getElementById('save-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const ok = await showConfirmDialog('Сохранить изменения в INI-файл?');
    if (ok) {
      await saveIniChanges(appState);
    }
  });
  console.log('[SAVE] Кнопка "Сохранить изменения" подключена.');
}