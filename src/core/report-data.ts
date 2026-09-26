// src/core/report-data.ts
/**
 * Сбор данных для отчёта из состояния приложения.
 * Читает:
 *  - текущую секцию таблицы (Flash/CD/RAM) из селекта;
 *  - устройство (DEVICE), параметры секции и vars из currentIniConfig;
 *  - имя файла и дату модификации из fileStore (по ключу устройства);
 *  - серийный номер из баннера ID;
 *  - актуальные HEX/Physical из DOM таблицы (колонки контроллера 6-7).
 */
import type { IniConfig } from './ini/index.js';
import type { IniParameter } from './ini/types.js';
import type { AppState } from './app-state.js';
import type { ReportData, ReportRow, ReportCoefficient } from './excel-report.js';

interface StoredFileEntryForReport {
    file: File;
    handle?: unknown;
}

/** Внешний доступ к хранилищу файлов и к его типу */
export interface ReportDataSource {
    appState: AppState;
    fileStore: Map<string, StoredFileEntryForReport>;
    organization: string;
    reportNumber: string;
}

/**
 * Форматирование даты в формате "ДД.ММ.ГГГГ ЧЧ:ММ:СС" (локальное время)
 */
function formatDateTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return (
        `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
}

/**
 * Дата изменения базы — берём из entry.file.lastModified.
 * В нативном режиме (Tauri) поле handle всегда undefined, поэтому
 * ветка через handle удалена: она всё равно уходила в fallback.
 */
async function getBaseChangeDate(entry: StoredFileEntryForReport | undefined): Promise<string> {
    if (!entry) return '';
    try {
        if (entry.file && typeof entry.file.lastModified === 'number' && entry.file.lastModified > 0) {
            return formatDateTime(entry.file.lastModified);
        }
    } catch (err) {
        console.warn('[report-data] не удалось получить дату модификации файла:', err);
    }
    return '';
}

/**
 * Читает актуальные HEX/Physical из ячеек контроллера (колонки 6 и 7) таблицы.
 * Сопоставляет по параметру (по id): берёт текст из соответствующей строки.
 */
function readRowValuesFromTable(param: IniParameter): { hex: string; physical: string } {
    const row = document.querySelector(`#grid-data-rows tr[data-key="${param.id}"]`) as HTMLElement | null;
    if (!row) {
        return { hex: '', physical: '' };
    }
    const tds = row.querySelectorAll('td');
    // Колонка 6 (hex контроллера) = индекс 6, колонка 7 (physical) = индекс 7
    const hexCell = tds[6] as HTMLElement | undefined;
    const physCell = tds[7] as HTMLElement | undefined;
    const hex = (hexCell?.textContent ?? '').trim();
    const physical = (physCell?.textContent ?? '').trim();
    return { hex: hex === '—' ? '' : hex, physical: physical === '—' ? '' : physical };
}

/**
 * Собирает все данные для отчёта. Возвращает ReportData, готовый к передаче в buildReportBlob.
 */
export async function collectReportData(src: ReportDataSource, modeOverride?: string): Promise<ReportData> {
    const { appState, fileStore, organization, reportNumber } = src;

    // Текущая секция (или принудительно заданная — для CSV это RAM)
    const modeSelect = document.querySelector<HTMLSelectElement>('.toolbar-device-mode-select');
    const currentMode = (modeOverride ?? (modeSelect && modeSelect.value ? modeSelect.value : 'FLASH')).toUpperCase();

    // Конфигурация устройства
    const config: IniConfig | null = appState.currentIniConfig ?? null;
    if (!config || !config.isValid) {
        throw new Error('Нет активной конфигу INI для формирования отчёта.');
    }

    const device = config.device;
    const params = config.getSection(currentMode) ?? [];

    // Поиск файла в хранилище по ключу устройства
    const key = device ? `${device.location}::${device.id}` : '';
    const entry = key ? fileStore.get(key) : undefined;
    const baseChangeDate = await getBaseChangeDate(entry);
    const baseFile = entry?.file?.name ?? '';
    // ─── Парсинг строки ID ──────────────────────────────────────────────────
    // Формат строки (баннер или INI):
    //   "ID: 00444444 DExS.SMFCB v1.10.6.1 18.07.2022 www.intmash.ru"
    // Слова после удаления "ID:":
    //   [0] = серийный номер (00444444)
    //   [1] = тип устройства (DExS.SMFCB)
    //   [2] = версия ПО (v1.10.6.1 → 1.10.6.1)
    // Приоритет: баннер (актуальный с устройства). Фолбэк: device.id из INI.
    const idSource = ((): string => {
        const banner = document.querySelector('.id-banner span');
        const bannerText = (banner?.textContent ?? '').trim();
        if (bannerText) return bannerText;
        return device?.id ?? '';
    })();

    const parsedId = parseDeviceIdString(idSource);
    const serialNumber = parsedId.serial;
    const deviceType = parsedId.deviceType;
    const softwareVersion = parsedId.version;

    // Сектор памяти: Flash / CD / RAM (как в образце)
    const memorySector = currentMode === 'FLASH' ? 'Flash' : currentMode;

    // Строки таблицы "Уставки параметров"
    const rows: ReportRow[] = [];
    for (const p of params) {
        const { hex, physical } = readRowValuesFromTable(p);
        rows.push({
            id: p.id,
            name: p.name,
            reg: p.modbusReg,
            scale: formatScale(p.scale),
            comment: p.description,
            hex,
            physical,
            unit: p.isBit ? '.' : (p.unit === '*' ? '—' : p.unit),
        });
    }

    // Все коэффициенты из [vars]
    const coefficients: ReportCoefficient[] = [];
    const vars = config.vars ?? {};
    for (const name of Object.keys(vars)) {
        const raw = vars[name];
        // Если значение — число, форматируем (точка → запятая);
        // если строка (например "500A|75mV / 0,1640625") — оставляем как есть.
        const value = typeof raw === 'number' ? formatScale(raw) : String(raw ?? '');
        coefficients.push({ name, value });
    }

    return {
        reportNumber,
        reportDate: formatDateTime(Date.now()),
        organization,
        mechanism: device?.description ?? '',
        installLocation: device?.location ?? '',
        deviceType: device?.id ?? '',
        serialNumber,
        softwareVersion,
        memorySector,
        baseFile,
        baseChangeDate,
        rows,
        coefficients,
    };
}

/** Форматирование числа в "0,001" / "1" / "0.01" — как в исходной таблице */
function formatScale(v: number | undefined): string {
    if (v === undefined || v === null || Number.isNaN(v)) return '';
    // Если это целое — без дробной части
    if (Number.isInteger(v)) return String(v);
    // Иначе — с запятой как разделителем (европейский формат, как в шаблоне)
    const s = String(v);
    return s.replace('.', ',');
}

/**
 * Парсит строку ID устройства.
 * Извлекает: серийный номер, тип устройства (короткий), версию ПО (без "v").
 * 
 * Примеры входных строк:
 *   "ID: 00444444 DExS.SMFCB v1.10.6.1 18.07.2022 www.intmash.ru"
 *   "00000396 DExS.SMFCB v1.10 30.08.2018 www.intmash.ru"
 */
export function parseDeviceIdString(raw: string): { serial: string; deviceType: string; version: string } {
    let s = (raw ?? '').trim();
    
    // Убираем префикс "ID:" если есть
    if (s.toUpperCase().startsWith('ID:')) {
        s = s.substring(3).trim();
    }
    
    // Разбиваем на слова
    const parts = s.split(/\s+/);
    
    const serial = parts[0] ?? '';           // 00444444
    const deviceType = parts[1] ?? '';       // DExS.SMFCB
    const versionRaw = parts[2] ?? '';       // v1.10.6.1
    const version = versionRaw.replace(/^[vV]\s*/, '');  // 1.10.6.1
    
    return { serial, deviceType, version };
}
/**
 * Собирает данные для CSV-экспорта: значения на момент маркера осциллографа.
 * Вместо чтения из DOM таблицы берёт значения из архива каналов.
 */
export async function collectCsvData(
    src: ReportDataSource,
    markerTime: number,
    archive: { getRawAtTime: (id: string, t: number) => number | null; getValueAtTime: (id: string, t: number) => number | null },
    channels: Array<{ id: string; modbusReg?: string }>,
): Promise<ReportData> {
    const { appState, fileStore, organization, reportNumber } = src;

    const config: IniConfig | null = appState.currentIniConfig ?? null;
    if (!config || !config.isValid) {
        throw new Error('Нет активной конфигу INI для формирования CSV.');
    }

    const device = config.device;
    const params = config.getSection('RAM') ?? [];

    const key = device ? `${device.location}::${device.id}` : '';
    const entry = key ? fileStore.get(key) : undefined;
    const baseChangeDate = await getBaseChangeDate(entry);
    const baseFile = entry?.file?.name ?? '';

    const idSource = ((): string => {
        const banner = document.querySelector('.id-banner span');
        const bannerText = (banner?.textContent ?? '').trim();
        if (bannerText) return bannerText;
        return device?.id ?? '';
    })();
    const parsedId = parseDeviceIdString(idSource);

    const rows: ReportRow[] = [];
    for (const p of params) {
        // Ищем канал осциллографа с таким же id
        const channel = channels.find((ch) => ch.id === p.id);
        let hex = '';
        let physical = '';
        if (channel) {
            const raw = archive.getRawAtTime(p.id, markerTime);
            const val = archive.getValueAtTime(p.id, markerTime);
            if (raw !== null) {
                const isIpAddr = p.dataType?.toUpperCase() === 'TIPADDR';
                const mask = isIpAddr ? 0xFFFFFFFF : 0xFFFF;
                const padLen = isIpAddr ? 8 : 4;
                hex = 'x' + (raw & mask).toString(16).toUpperCase().padStart(padLen, '0');
            }
            if (val !== null) {
                physical = formatScale(val);
            }
        }
        rows.push({
            id: p.id,
            name: p.name,
            reg: p.modbusReg,
            scale: formatScale(p.scale),
            comment: p.description,
            hex,
            physical,
            unit: p.isBit ? '.' : (p.unit === '*' ? '—' : p.unit),
        });
    }

    const coefficients: ReportCoefficient[] = [];
    const vars = config.vars ?? {};
    for (const name of Object.keys(vars)) {
        const raw = vars[name];
        const value = typeof raw === 'number' ? formatScale(raw) : String(raw ?? '');
        coefficients.push({ name, value });
    }

    return {
        reportNumber,
        reportDate: formatDateTime(Date.now()),
        organization,
        mechanism: device?.description ?? '',
        installLocation: device?.location ?? '',
        deviceType: device?.id ?? '',
        serialNumber: parsedId.serial,
        softwareVersion: parsedId.version,
        memorySector: 'RAM',
        baseFile,
        baseChangeDate,
        rows,
        coefficients,
    };
}
/** Извлекает полную информацию из ID-строки для модального окна обновления прошивки */
export function parseDeviceIdFull(raw: string): {
    idLine: string;
    serial: string;
    deviceType: string;
    deviceVersion: string;
    firmwareVersion: string;
    firmwareDate: string;
} {
    let s = (raw ?? '').trim();
    if (s.toUpperCase().startsWith('ID:')) {
        s = s.substring(3).trim();
    }
    const parts = s.split(/\s+/);
    const serial = parts[0] ?? '';
    const deviceType = parts[1] ?? '';
    const versionRaw = parts[2] ?? '';
    const deviceVersion = versionRaw.replace(/^[vV]\s*/, '');
    const firmwareVersion = parts[3] ?? '';
    const firmwareDate = parts.slice(4).join(' ');

    return {
        idLine: raw,
        serial,
        deviceType,
        deviceVersion,
        firmwareVersion,
        firmwareDate,
    };
}