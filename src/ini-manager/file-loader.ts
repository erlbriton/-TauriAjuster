// src/ini-manager/file-loader.ts

import { showIdModal, populateDeviceForm, showCompactError, openIniEditor } from '../ui/ui.js';
import { encodeToWindows1251 } from '../core/encoding.js';
import { saveDbFolderHandle } from './db-folder.js';
import { addDeviceToRegistry, deviceRegistry, setCurrentIniConfig, updateDeviceInRegistry, removeDeviceFromRegistry } from './tree-core.js';
import type { RawIniConfig, DeviceRegistryItem } from './tree-core.js';
import { renderDeviceTree } from './tree-ui.js';
import { renderModbusTable } from '../ui/tree.js';
import { IniParser as CoreIniParser, IniConfig, iniParamsToChannelConfigs } from '../core/ini/index.js';
import type { AppState } from '../core/app-state.js';
/** Геттер хранилища файлов (используется генератором отчётов) */
export function getFileStore(): Map<string, StoredFileEntry> {
    return fileStore;
}
import { decodeTextBuffer } from './textFileReader.js';

/**
 * Открывает INI-файл через File System Access API.
 * Сохраняет хэндл файла в appState для последующей записи.
 */
/** Хэндлы открытых INI-файлов (имя файла → хэндл) для записи обратно */
const iniFileHandles = new Map<string, FileSystemFileHandle>();
let currentIniFileName: string | null = null;

/**
 * Хранилище File-объектов для перечитывания INI-файлов с диска.
 * Ключ: `${location}::${id}` — совпадает с уникальностью в deviceRegistry.
 * Браузер не следит за файлами сам, но пока жива ссылка на File,
 * file.text() возвращает актуальное содержимое с диска.
 */
export interface StoredFileEntry {
    file: File;
    handle?: FileSystemFileHandle;
    /** Родительская папка файла (если известна при загрузке — например, при открытии папки) */
    parentHandle?: FileSystemDirectoryHandle;
    location: string;
    id: string;
    content: string;
    lastModified: number;
    /** Абсолютный путь к файлу на диске (для открытия во внешнем редакторе).
     *  Необязательное поле: старые записи из браузерной версии не имеют пути,
     *  новые записи из Tauri-автозагрузчика получают полный путь. */
    path?: string;
}
const fileStore: Map<string, StoredFileEntry> = new Map();

/** Возвращает хэндл файла, с которым сейчас работает аджастер */
export function getCurrentIniFileHandle(): FileSystemFileHandle | null {
  if (!currentIniFileName) return null;
  return iniFileHandles.get(currentIniFileName) ?? null;
}

export async function openIniFile(appState: AppState): Promise<void> {
  try {
    const handles = await (window as any).showOpenFilePicker({
      types: [
        {
          description: 'INI Files',
          accept: { 'text/plain': ['.ini', '.txt'] },
        },
      ],
      multiple: true,
    });

    for (const fileHandle of handles) {
      const file = await fileHandle.getFile();
      const content = await readFileAsText(file);
      iniFileHandles.set(file.name, fileHandle);
      await processSingleFileContent(content, file.name, appState, file, fileHandle);
    }

    // Если до открытия ни один файл не был выбран — автоматически выбираем первый
    setTimeout(() => {
      const selected = document.querySelector('.tree-id-item.is-selected');
      if (!selected) {
        const firstLi = document.querySelector<HTMLLIElement>('.tree-id-item.is-leaf');
        if (firstLi) {
          const details = firstLi.closest('details');
          if (details && !(details as HTMLDetailsElement).open) {
            (details as HTMLDetailsElement).open = true;
          }
          firstLi.click();
          firstLi.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    }, 100);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      // Пользователь отменил выбор файла
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    showIdModal('Ошибка открытия файла: ' + msg);
    console.error('[file-loader] openIniFile error:', err);
  }
}

/**
 * Открывает папку и загружает все INI-файлы из неё (и вложенных папок).
 * Доступно только в Linux через showDirectoryPicker API.
 * Работает через тот же конвейер, что и openIniFile: processSingleFileContent.
 */
/** Хэндл директории с методом обхода (File System Access API) */
/** Часть window-API для выбора папки */
interface DirectoryPickerWindow {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
}

/** Интерфейс только для метода обхода (без наследования от FileSystemDirectoryHandle) */
interface DirectoryIterator {
    values(): AsyncIterableIterator<FileSystemHandle>;
}

/**
 * Открывает папку и загружает все INI-файлы из неё (и вложенных папок).
 * Доступно только в Linux через showDirectoryPicker API.
 * Работает через тот же конвейер, что и openIniFile: processSingleFileContent.
 */
export async function openIniFolder(appState: AppState): Promise<void> {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) {
        showIdModal('Выбор папки не поддерживается в этом браузере.');
        return;
    }

    try {
        const dirHandle = await picker();

        // Запоминаем открытую папку как общую папку базы:
        // новые файлы будут писаться в неё же (на Linux).
        await saveDbFolderHandle(dirHandle);

        // Рекурсивный обход всех вложенных папок
        const stack: FileSystemDirectoryHandle[] = [dirHandle];

        while (stack.length > 0) {
            const currentDir = stack.pop()!;

            for await (const entry of (currentDir as unknown as DirectoryIterator).values()) {
                if (entry.kind === 'directory') {
                    stack.push(entry as FileSystemDirectoryHandle);
                } else if (entry.kind === 'file') {
                    // Фильтр по расширению
                    const name = entry.name.toLowerCase();
                    if (name.endsWith('.ini') || name.endsWith('.txt')) {
                        const fileHandle = entry as FileSystemFileHandle;
                        try {
                            const file = await fileHandle.getFile();
                            const content = await readFileAsText(file);
                            iniFileHandles.set(file.name, fileHandle);
                            await processSingleFileContent(content, file.name, appState, file, fileHandle, currentDir);
                        } catch (fileErr) {
                            // Ошибка чтения одного файла не прерывает всю папку
                            console.warn(`[file-loader] Пропуск файла ${entry.name}:`, fileErr);
                        }
                    }
                }
                    }
    }

    // Если до открытия ни один файл не был выбран — автоматически выбираем первый
    setTimeout(() => {
      const selected = document.querySelector('.tree-id-item.is-selected');
      if (!selected) {
        const firstLi = document.querySelector<HTMLLIElement>('.tree-id-item.is-leaf');
        if (firstLi) {
          const details = firstLi.closest('details');
          if (details && !(details as HTMLDetailsElement).open) {
            (details as HTMLDetailsElement).open = true;
          }
          firstLi.click();
          firstLi.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    }, 100);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      // Пользователь отменил выбор папки
      return;
    }
        const msg = err instanceof Error ? err.message : String(err);
        showIdModal('Ошибка открытия папки: ' + msg);
        console.error('[file-loader] openIniFolder error:', err);
    }
}

/** Элемент списка INI-файлов для синхронизации с осциллографом */
interface OscIniFile {
  id: string;
  name: string;
  content: string;
  size: number;
  lastModified: number;
}

// setupFileHandling больше не используется — вместо неё openIniFile с File System Access API

export async function processSingleFileContent(
    content: string,
    fileName: string,
    stateObj: AppState,
    sourceFile?: File,
    sourceHandle?: FileSystemFileHandle,
    parentHandle?: FileSystemDirectoryHandle,
    /** Абсолютный путь к файлу на диске (для открытия во внешнем редакторе).
     *  Необязательный параметр: передаётся из Tauri-автозагрузчика. */
    filePath?: string
): Promise<void> {
  currentIniFileName = fileName;
  try {
    if (!content) {
      throw new Error('Файл пуст');
    }
    // Убираем BOM (Byte Order Mark), если он есть в начале файла
    // (мы добавляем его при сохранении для корректной кириллицы в Windows)
    if (content.charCodeAt(0) === 0xFEFF) {
      content = content.substring(1);
    }

    // ЕДИНЫЙ парсинг через core/ini
    const coreParser = new CoreIniParser();
    const parseResult = coreParser.parse(content);
    const iniConfig = new IniConfig(parseResult);

    // Совместимость: rawSections — тот же формат, что и старый ParsedData
    const config = parseResult.rawSections as RawIniConfig;

    if (!config || !(config['DEVICE'] || config['RAM'] || config['CD'] || config['FLASH'])) {
      throw new Error('Неверный формат INI файла (отсутствуют стандартные секции)');
    }

    // Сохраняем текущий INI-файл и его распарсенную конфигурацию
    // в глобальное состояние приложения (через параметр stateObj).
    stateObj.currentIniContent = content;
    stateObj.currentIniConfig = iniConfig;

    const isAdded = addDeviceToRegistry(iniConfig);
    setCurrentIniConfig(iniConfig);

        // Сохраняем File-объект, чтобы позже перечитать файл с диска
    console.log('[file-loader] save check:', { isAdded, hasFile: !!sourceFile, hasDevice: !!iniConfig.device });
    if (sourceFile && iniConfig.device) {
        const loc = iniConfig.device.location || 'Неизвестное место';
        const id = iniConfig.device.id || 'Без ID';
        const key = `${loc}::${id}`;
        
        // Если устройство уже есть в реестре (isAdded=false), но у нас есть handle —
        // обновляем запись в fileStore, чтобы редактирование работало.
        // Это нужно при обновлении ПО: старое устройство помечено как backup,
        // новое устройство имеет тот же ID, но новый файл с новым handle.
        fileStore.set(key, {
            file: sourceFile,
            handle: sourceHandle,
            parentHandle,
            location: loc,
            id: String(id),
            content,
            lastModified: sourceFile ? sourceFile.lastModified : Date.now(),
            path: filePath,  // Сохраняем путь к файлу на диске
        });
    }

    if (isAdded) {
      renderDeviceTree();
    }
    if (config['DEVICE']) {
      populateDeviceForm(config['DEVICE']);
    }
    renderModbusTable(iniConfig);

    // Осциллограф: используем уже распарсенный iniConfig
    const osc = window.osc;
    if (osc && typeof osc.applyChannelConfigs === 'function') {
      try {
        const ramParams = iniConfig.getSection('RAM');
        const channelConfigs = iniParamsToChannelConfigs(ramParams);
        await osc.applyChannelConfigs(channelConfigs);
      } catch (oscErr: unknown) {
        const msg = oscErr instanceof Error ? oscErr.message : String(oscErr);
        console.error('[file-loader] applyChannelConfigs error:', oscErr);
        showIdModal('Ошибка применения INI к осциллографу: ' + msg);
      }
    } else if (osc && typeof osc.loadIniContent === 'function') {
      try {
        await osc.loadIniContent(content);
      } catch (oscErr: unknown) {
        console.error('[file-loader] Oscilloscope apply error (legacy):', oscErr);
      }
    }

    syncFilesToOscilloscope();

    const deviceId = findDeviceIdByConfig(config);
    if (deviceId && window.osc?.setActiveIni) {
      try {
        window.osc.setActiveIni(deviceId);
      } catch (uiErr) {
        console.error('[file-loader] Failed to set active INI:', uiErr);
      }
    }

    // Событие "INI-файл загружен": uiManager по нему выполнит автоматический
    // опрос контроллера (как кнопка "Обновить"), если порт открыт.
    window.dispatchEvent(new CustomEvent('app:ini-file-loaded'));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    showIdModal('Ошибка обработки файла ' + fileName + ': ' + msg);
    console.error('Parser Error:', err);
  }
}

function readFileAsText(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e: ProgressEvent<FileReader>) => {
      const result = e.target?.result;
      if (typeof result === 'string') {
        resolve(result);
      } else {
        reject(new Error('Не удалось прочитать файл как текст'));
      }
    };
    reader.onerror = () => {
      reject(new Error('Ошибка чтения файла'));
    };
    reader.readAsText(file, 'windows-1251');
  });
}

/**
 * Перечитывает все загруженные INI-файлы с диска.
 * - Файл изменён: обновляет запись в реестре и памяти.
 * - Файл удалён/перемещён: удаляет устройство из реестра.
 * - Файл не менялся: пропускает.
 */
export async function reloadIniFilesFromDisk(): Promise<{
    updated: number;
    removed: number;
    unchanged: number;
    errors: string[];
}> {
    const results = { updated: 0, removed: 0, unchanged: 0, errors: [] as string[] };
    const keys = Array.from(fileStore.keys());

    if (keys.length === 0) {
        console.log('[file-loader] reloadIniFilesFromDisk: нет файлов для перечитывания');
        return results;
    }

    for (const key of keys) {
        const entry = fileStore.get(key);
        if (!entry) continue;

        try {
            let newContent: string;
            
            // Приоритет чтения содержимого файла:
            // 1. Если есть путь на диске (Tauri-автозагрузчик) — читаем через Rust
            // 2. Если есть хэндл (браузерный File System Access API) — берём свежий File
            // 3. Иначе — используем старый снимок (изменения не обнаружим)
            if (entry.path) {
                // Читаем файл через Rust-команду: она возвращает сырые байты
                const rawBytes = await window.__TAURI__.core.invoke<number[]>('read_ini_file', {
                    path: entry.path
                });
                // Декодируем из windows-1251 через существующую функцию
                // (та же, что используется в автозагрузчике)
                const buffer = new Uint8Array(rawBytes).buffer as ArrayBuffer;
                newContent = decodeTextBuffer(buffer);
            } else if (entry.handle) {
                const freshFile = await entry.handle.getFile();
                newContent = await readFileAsText(freshFile);
            } else {
                // Нет ни пути, ни хэндла — используем снимок в памяти
                newContent = await readFileAsText(entry.file);
            }

            if (newContent === entry.content) {
                results.unchanged++;
                continue;
            }

            // Файл изменился — парсим и обновляем реестр на месте
            try {
                const coreParser = new CoreIniParser();
                const parseResult = coreParser.parse(newContent);
                const newIniConfig = new IniConfig(parseResult);
                const newConfig = parseResult.rawSections as RawIniConfig;

                if (updateDeviceInRegistry(entry.location, entry.id, newIniConfig, newConfig)) {
                    entry.content = newContent;
                    entry.lastModified = Date.now();
                    results.updated++;
                    console.log(`[file-loader] Файл обновлён: ${entry.file.name}`);
                } else {
                    fileStore.delete(key);
                    results.errors.push(`${entry.file.name}: устройство не найдено в реестре`);
                }
            } catch (parseErr) {
                const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
                results.errors.push(`${entry.file.name}: ошибка парсинга — ${msg}`);
                console.error(`[file-loader] Parse error for ${entry.file.name}:`, parseErr);
            }
        } catch (readErr) {
            // Файл удалён или перемещён
            removeDeviceFromRegistry(entry.location, entry.id);
            fileStore.delete(key);
            results.removed++;
            console.log(`[file-loader] Файл удалён/недоступен: ${entry.file.name}`);
        }
    }

    if (results.updated > 0 || results.removed > 0) {
        renderDeviceTree();
        syncFilesToOscilloscope();
        console.log(
            `[file-loader] reload: updated=${results.updated}, removed=${results.removed}, unchanged=${results.unchanged}`,
        );
    }

    return results;
}

// Пункт "Открыть файл для редактирования" контекстного меню дерева
window.addEventListener('app:edit-device-requested', (e: Event) => {
    const detail = (e as CustomEvent<{ id?: string }>).detail;
    if (!detail || detail.id == null) return;
    void editDeviceIniFile(String(detail.id));
});

// Пункт "Удалить" контекстного меню дерева: убираем файл из хранилища
// и синхронизируем список с осциллографом
window.addEventListener('app:device-removed', (e: Event) => {
    const detail = (e as CustomEvent<{ id?: string }>).detail;
    if (!detail || detail.id == null) return;
    const idStr = String(detail.id);
    for (const key of Array.from(fileStore.keys())) {
        const entry = fileStore.get(key);
        if (entry && entry.id === idStr) {
            fileStore.delete(key);
        }
    }
    syncFilesToOscilloscope();
});

/**
 * Открывает встроенный редактор для INI-файла, соответствующего устройству с заданным id.
 * После сохранения пишет файл в windows-1251 через FileSystemFileHandle,
 * обновляет файл в хранилище и в реестре, перерисовывает дерево и осциллограф.
 */
export async function editDeviceIniFile(deviceId: string): Promise<void> {
    let entry: StoredFileEntry | undefined;
    for (const key of Array.from(fileStore.keys())) {
        const e = fileStore.get(key);
        if (e && e.id === deviceId) {
            entry = e;
            break;
        }
    }

    if (!entry) {
        showCompactError(`Файл устройства ${deviceId} не найден в хранилище.`);
        return;
    }

    // Проверка на наличие handle не нужна для внешнего редактора:
    // внешний редактор открывает файл напрямую через путь на диске,
    // а не через браузерный File System Access API.
    // Поэтому убираем проверку if (!entry.handle).

    // Гарантированно получаем самое свежее содержимое с диска перед открытием редактора,
    // чтобы избежать показа устаревших данных из кэша entry.content.
    // Читаем напрямую через entry.file (File.text()), а не через handle.
    let contentToEdit = entry.content;
    try {
        contentToEdit = await readFileAsText(entry.file);
        // Синхронизируем кэш, чтобы последующие операции имели актуальные данные
        entry.content = contentToEdit;
        entry.lastModified = Date.now();
    } catch (err) {
        console.warn('[file-loader] Не удалось прочитать свежий файл перед редактированием, используем кэш:', err);
    }

    // Используем сохранённый абсолютный путь к файлу на диске.
    // Поле path заполняется автозагрузчиком Tauri при загрузке файла.
    if (!entry.path) {
        console.error(`[file-loader] У файла ${entry.file.name} нет сохранённого пути на диске.`);
        showCompactError('Не удалось определить путь к файлу для редактирования.');
        return;
    }

    // Открываем файл в редакторе по умолчанию операционной системы.
    // Внешний редактор редактирует файл напрямую на диске.
    // После редактирования пользователь нажмёт "Обновить список устройств",
    // и приложение перечитает все INI-файлы и покажет изменения.
    try {
        await window.__TAURI__.core.invoke<void>('open_in_default_editor', {
            path: entry.path
        });
    } catch (err) {
        console.error('[file-loader] Ошибка открытия файла во внешнем редакторе:', err);
        showIdModal('Ошибка открытия файла: ' + (err instanceof Error ? err.message : String(err)));
    }
    
    // Больше не записываем изменения и не перечитываем файл здесь —
    // это произойдёт при нажатии кнопки "Обновить список устройств"
    return;
}
function syncFilesToOscilloscope(): void {
  const osc = window.osc;
  if (!osc || typeof osc.setIniFiles !== 'function') return;

  const allFiles: OscIniFile[] = [];

  for (const location in deviceRegistry) {
    const group = deviceRegistry[location];
    if (!Array.isArray(group)) continue;
    group.forEach((dev: DeviceRegistryItem) => {
      try {
        if (!dev || dev.id == null) return;
        const configStr = serializeConfig(dev.fullConfig);
        allFiles.push({
          id: String(dev.id),
          name: dev.displayText ?? String(dev.id),
          content: configStr,
          size: new Blob([configStr]).size,
          lastModified: Date.now()
        });
      } catch (err) {
        console.warn('[file-loader] Failed to serialize device config:', err);
      }
    });
  }

  try {
    osc.setIniFiles(allFiles);
  } catch (err) {
    console.error('[file-loader] Failed to sync INI files to oscilloscope:', err);
  }
}

function findDeviceIdByConfig(config: RawIniConfig): string | null {
  if (!config) return null;

  for (const location in deviceRegistry) {
    const group = deviceRegistry[location];
    if (!Array.isArray(group)) continue;
    for (const dev of group) {
      if (dev && dev.fullConfig === config && dev.id != null) {
        return String(dev.id);
      }
    }
  }

  try {
    const target = serializeConfig(config);
    for (const location in deviceRegistry) {
      const group = deviceRegistry[location];
      if (!Array.isArray(group)) continue;
      for (const dev of group) {
        if (dev && dev.id != null && serializeConfig(dev.fullConfig) === target) {
          return String(dev.id);
        }
      }
    }
  } catch (err) {
    console.warn('[file-loader] Failed to find device by serialized config:', err);
  }
  return null;
}

function serializeConfig(config: RawIniConfig): string {
  if (!config || typeof config !== 'object') return '';
  let out = '';
  for (const section in config) {
    out += `[${section}]\n`;
    const data = config[section];
    if (data && typeof data === 'object') {
      for (const key in data) {
        const val = data[key];
        out += `${key}=${Array.isArray(val) ? val.join('/') : val}\n`;
      }
    }
    out += '\n';
  }
  return out;
}
/**
 * Старый способ открытия файла через <input type="file">.
 * Временно оставляем для совместимости, пока не переключимся на openIniFile.
 */
export function setupFileHandling(fileInput: HTMLInputElement, appState: AppState): void {
  let processingQueue: Promise<void> = Promise.resolve();

  fileInput.addEventListener('change', (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (!target || !target.files) return;
    const files: File[] = Array.from(target.files);
    if (files.length === 0) return;
    target.value = '';
    files.forEach((file: File) => {
      processingQueue = processingQueue
        .then(async () => {
          const content = await readFileAsText(file);
          await processSingleFileContent(content, file.name, appState, file);
        })
        .catch((err: unknown) => {
          console.error('[file-loader] Unhandled file processing error:', err);
        });
    });
  });
}