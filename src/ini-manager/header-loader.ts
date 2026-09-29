// src/ini-manager/header-loader.ts
// «Лёгкая» регистрация устройств по первым 5 строкам [DEVICE].
//
// Зачем: при старте приложения Rust-команда scan_devices_folder возвращает
// только первые 5 строк каждого INI-файла (секция [DEVICE] по стандарту
// прошивки). Полный файл содержит сотни параметров RAM/XRAM/CD/FLASH, и
// парсить его целиком для каждого из сотен устройств — долго.
//
// Поэтому при старте мы регистрируем устройство в реестре и в fileStore
// по «лёгкой» записи (флаг isHeaderOnly = true), без отрисовки таблицы.
// Полный файл читается отдельно, при первом клике по устройству в дереве.
//
// Что НЕ делает этот модуль:
//  - НЕ рисует таблицу Modbus (renderModbusTable);
//  - НЕ обновляет осциллограф (applyChannelConfigs);
//  - НЕ трогает populateDeviceForm и прочий UI.
//
// Всё это делает существующий processSingleFileContent, который
// вызывается из обработчика клика по дереву после полного чтения файла.

import { IniParser as CoreIniParser, IniConfig } from '../core/ini/index.js';
import { addDeviceToRegistry } from './tree-core.js';
import { fileStore } from './file-store.js';

/**
 * Регистрирует устройство по «лёгкому» пути: парсит только [DEVICE],
 * создаёт IniConfig с пустыми секциями, кладёт запись в deviceRegistry
 * и в fileStore (для доступа к path при клике).
 *
 * Возвращает true, если устройство добавлено в реестр (не было дубликатом).
 * Возвращает false, если файл не содержит [DEVICE], либо устройство
 * с таким location::id уже есть в реестре.
 */
export function registerDeviceFromHeader(
    headerContent: string,
    fileName: string,
    fullPath: string,
    lastModifiedMs: number,
): boolean {
    try {
        // Парсим только то, что пришло: 5 строк с [DEVICE].
        // IniParser толерантен к отсутствию RAM/XRAM/CD/FLASH — они
        // просто не попадут в sections, и isValid вернёт false.
        const parser = new CoreIniParser();
        const parseResult = parser.parse(headerContent);
        const iniConfig = new IniConfig(parseResult);

        const dev = iniConfig.device;
        if (!dev) {
            // Нет секции [DEVICE] — файл не по формату.
            return false;
        }

        const location = dev.location || 'Неизвестное место';
        const id = dev.id || 'Без ID';

        // Регистрируем в deviceRegistry с пометкой isHeaderOnly + path.
        const isAdded = addDeviceToRegistry(iniConfig, {
            isHeaderOnly: true,
            path: fullPath,
        });
        if (!isAdded) {
            // Устройство с таким location::id уже есть — не дублируем.
            return false;
        }

        // Кладём «лёгкую» запись в fileStore, чтобы обработчик клика
        // мог найти запись по location::id и получить path.
        const file = new File([headerContent], fileName, {
            lastModified: lastModifiedMs,
        });
        const key = `${location}::${id}`;
        fileStore.set(key, {
            file,
            location,
            id,
            // Пока в content только 5 строк — полное содержимое
            // подгрузится при первом клике по устройству в дереве.
            content: headerContent,
            lastModified: lastModifiedMs,
            path: fullPath,
        });

        return true;
    } catch (err) {
        console.error('[header-loader] Ошибка регистрации:', fileName, err);
        return false;
    }
}