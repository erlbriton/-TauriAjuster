// src/ini-manager/tree-core.ts

import type { IniConfig } from '../core/ini/index.js';

// Реэкспорт для обратной совместимости: 7 внешних модулей
// (tree-row-values, ChannelRow, device_updater, ui/tree, param-properties-ui,
// value-write) импортируют эти функции из tree-core.js. Чтобы не менять
// их импорты, оставляем реэкспорт из нового места.
export { hexToFloat32, float32ToHex } from './hex-utils.js';

// Реэкспорт плана записи контроллера: 3 внешних модуля (base-write,
// controller-write, copy-ops) импортируют planControllerWrite из tree-core.js.
// Чтобы не менять их импорты, оставляем реэкспорт.
export { planControllerWrite, type ControllerWritePlan } from './controller-write-plan.js';

// Реэкспорт группировки дерева: 5 внешних модулей (tree-render,
// search-navigation, device-management, uiManager) импортируют эти
// символы из tree-core.js. Чтобы не менять их импорты, оставляем реэкспорт.
export {
    type TreeGroupMode,
    setTreeGroupMode,
    getTreeGroupMode,
    getDeviceGroupKey,
    getDeviceLeafText,
} from './tree-grouping.js';

/** Тип сырого INI-конфига (совместим с AppState.currentDeviceConfig) */
export type RawIniConfig = Record<string, Record<string, string | string[]>>;

/** Элемент реестра устройств */
export interface DeviceRegistryItem {
  id: string;
  displayText: string;
  iniConfig: IniConfig;
  /** Сырой конфиг для обратной совместимости со старым кодом */
  fullConfig: RawIniConfig;
  /** Флаг: это резервная копия (файл перенесён в BackUp) */
  isBackup?: boolean;
  /**
   * Имя файла в папке BackUp, к которому относится эта резервная копия.
   * Заполняется только у записей с isBackup === true. Нужно, чтобы при
   * синхронизации с диском (кнопка «Обновить список») удалять из дерева
   * те красные записи, чьих файлов в BackUp больше нет.
   *
   * У старых записей (созданных до появления этого поля) значение undefined —
   * при синхронизации они будут удалены, если в BackUp нет совпадения
   * по имени или если их не удастся сопоставить.
   */
  backupFileName?: string;
  /**
   * Флаг: запись создана по «лёгкому» пути (только первые 5 строк [DEVICE]).
   * iniConfig в этом случае содержит только секцию [DEVICE], без RAM/XRAM/CD/FLASH.
   * При первом клике по устройству в дереве полный файл читается с диска
   * (read_ini_file), парсится, и флаг сбрасывается в false.
   */
  isHeaderOnly?: boolean;
  /**
   * Абсолютный путь к INI-файлу на диске. Заполняется при регистрации
   * из tauri-autoloader и при синхронизации с диском. Нужен для того,
   * чтобы при клике по «лёгкой» записи прочитать файл целиком.
   */
  path?: string;
}

/** Реестр: локации → массив устройств */
export const deviceRegistry: Record<string, DeviceRegistryItem[]> = {};

export let currentIniConfig: IniConfig | null = null;

export function setCurrentIniConfig(config: IniConfig | null): void {
  currentIniConfig = config;
}

// Вспомогательная функция для парсинга адресов
export function parseRegisterAddress(addrString: string): { reg: number | null; sub: string | null } {
  if (!addrString || addrString === '*') return { reg: null, sub: null };
  const cleanStr = addrString.toLowerCase().replace('r', '');
  const parts = cleanStr.split('.');
  let valStr = parts[0];
  let base = 16; // Default to hex
  if (valStr.startsWith('x')) {
    valStr = valStr.substring(1);
  } else if (valStr.startsWith('0x')) {
    valStr = valStr.substring(2);
  }
  return {
    reg: parseInt(valStr, base),
    sub: parts[1] ? parts[1].toUpperCase() : null
  };
}

// Регистрация устройства.
//
// extra — необязательные поля для «лёгкой» записи (isHeaderOnly, path).
// Стандартные вызовы (addDeviceToRegistry(cfg)) не передают extra и
// ведут себя как раньше.
export function addDeviceToRegistry(
  iniConfig: IniConfig,
  extra?: { isHeaderOnly?: boolean; path?: string },
): boolean {
  if (!iniConfig || !iniConfig.device) return false;
  const dev = iniConfig.device;
  const location = dev.location || 'Неизвестное место';
  const id = dev.id || 'Без ID';
  const displayComponents = [id, dev.version, dev.date].filter(Boolean);
  const deviceDisplayText = displayComponents.join(' ');
  if (!deviceRegistry[location]) deviceRegistry[location] = [];
  const isDuplicate = deviceRegistry[location].some(item => item.id === id);
  if (!isDuplicate) {
    deviceRegistry[location].push({
      id,
      displayText: deviceDisplayText,
      iniConfig,
      fullConfig: iniConfig.parseResult.rawSections as RawIniConfig,
      isHeaderOnly: extra?.isHeaderOnly,
      path: extra?.path,
    });
    return true;
  }
  return false;
}
/**
 * Обновляет существующее устройство в реестре (на месте, без перестройки списка).
 * Используется при перечитывании изменённых INI-файлов с диска.
 */
export function updateDeviceInRegistry(
    location: string,
    id: string,
    iniConfig: IniConfig,
    fullConfig: RawIniConfig,
): boolean {
    const group = deviceRegistry[location];
    if (!Array.isArray(group)) return false;
    const idx = group.findIndex(item => item.id === id);
    if (idx === -1) return false;

    const dev = iniConfig.device;
    const displayComponents = [id, dev?.version, dev?.date].filter(Boolean);
    group[idx].iniConfig = iniConfig;
    group[idx].fullConfig = fullConfig;
    group[idx].displayText = displayComponents.join(' ');
    return true;
}
/**
 * Удаляет устройство из реестра по location и id.
 * Используется, когда INI-файл был удалён или перемещён на диске.
 */
export function removeDeviceFromRegistry(location: string, id: string): boolean {
    const group = deviceRegistry[location];
    if (!Array.isArray(group)) return false;
    const idx = group.findIndex(item => item.id === id);
    if (idx === -1) return false;
    group.splice(idx, 1);
    if (group.length === 0) {
        delete deviceRegistry[location];
    }
    return true;
}

/** Удаляет устройство из реестра по ссылке на его запись (для контекстного меню) */
export function removeDeviceItemFromRegistry(item: DeviceRegistryItem): boolean {
    for (const location in deviceRegistry) {
        const group = deviceRegistry[location];
        if (!Array.isArray(group)) continue;
        const idx = group.indexOf(item);
        if (idx !== -1) {
            group.splice(idx, 1);
            if (group.length === 0) {
                delete deviceRegistry[location];
            }
            return true;
        }
    }
    return false;
}

/** Все устройства реестра в порядке загрузки */
export function getAllDevices(): DeviceRegistryItem[] {
    const all: DeviceRegistryItem[] = [];
    for (const location in deviceRegistry) {
        const group = deviceRegistry[location];
        if (Array.isArray(group)) all.push(...group);
    }
    return all;
}