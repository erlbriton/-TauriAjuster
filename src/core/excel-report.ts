// src/core/excel-report.ts
/**
 * Генератор отчёта «Отчёт о наладке оборудования» (.xlsx) на ExcelJS.
 * Формат повторяет шаблон старого аджастера: титул, шапка,
 * «Описание объекта», «Уставки параметров», «Коэффициенты», пустые Лист2/Лист3.
 * Не зависит от DOM и serial — готов к Tauri.
 */
import ExcelJS from 'exceljs';

/** Строка таблицы «Уставки параметров». Все значения — готовые строки */
export interface ReportRow {
    id: string;        // p10000
    name: string;      // IstStart
    reg: string;       // r2000
    scale: string;     // 0,001
    comment: string;   // Пуск по току статора
    hex: string;       // x0014
    physical: string;  // 20
    unit: string;      // A
}

/** Коэффициент (AINK / CINScale) */
export interface ReportCoefficient {
    name: string;
    value: string;
}

/** Все данные отчёта. Собирает UI-слой, этот модуль только формирует xlsx */
export interface ReportData {
    reportNumber: string;
    reportDate: string;
    organization: string;
    mechanism: string;
    installLocation: string;
    deviceType: string;
    serialNumber: string;
    softwareVersion: string;
    memorySector: string;
    baseFile: string;
    baseChangeDate: string;
    rows: ReportRow[];
    coefficients: ReportCoefficient[];
}

const THIN: ExcelJS.Border = { style: 'thin', color: { argb: 'FF000000' } };
const CELL_BORDER: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };

/** Сформировать .xlsx и вернуть как Blob */
export async function buildReportBlob(data: ReportData): Promise<Blob> {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Лист1');

    ws.columns = [
        { width: 12 }, // A — № / метки
        { width: 16 }, // B — Параметр
        { width: 10 }, // C — Регистр
        { width: 12 }, // D — Коэфф
        { width: 62 }, // E — Комментарий
        { width: 12 }, // F — HEX
        { width: 12 }, // G — Physical
        { width: 9 },  // H — Ед.Изм.
    ];

    let r = 1;

    // ── Титул ──
    ws.mergeCells(r, 1, r, 8);
    const title = ws.getCell(r, 1);
    title.value = 'Отчёт о наладке оборудования';
    title.font = { bold: true, size: 14 };
    title.alignment = { horizontal: 'center', vertical: 'middle' };
    r += 2;

    // ── Шапка: №, Дата, Организация ──
    r = addLabelValueRows(ws, r, [
        ['№', data.reportNumber],
        ['Дата', data.reportDate],
        ['Организация', data.organization],
    ]);

    r += 1; // пустая строка

    // ── Описание объекта ──
    ws.mergeCells(r, 1, r, 8);
    const objHeader = ws.getCell(r, 1);
    objHeader.value = 'Описание объекта';
    objHeader.font = { bold: true };
    r += 1;

    r = addLabelValueRows(ws, r, [
        ['Механизм', data.mechanism],
        ['Место установки', data.installLocation],
        ['Тип устройства', data.deviceType],
        ['Серийный номер', data.serialNumber],
        ['Версия ПО', data.softwareVersion],
        ['Сектор памяти', data.memorySector],
        ['Файл базы', data.baseFile],
        ['Дата изменения базы', data.baseChangeDate],
    ]);

    r += 1; // пустая строка

    // ── Уставки параметров ──
    ws.mergeCells(r, 1, r, 8);
    const ustHeader = ws.getCell(r, 1);
    ustHeader.value = 'Уставки параметров';
    ustHeader.font = { bold: true };
    r += 1;

    const headValues = ['№', 'Параметр', 'Регистр', 'Коэфф', 'Комментарий', 'HEX', 'Physical', 'Ед.Изм.'];
    const headRow = ws.getRow(r);
    headValues.forEach((h, i) => {
        const c = headRow.getCell(i + 1);
        c.value = h;
        c.font = { bold: true };
        c.border = CELL_BORDER;
        c.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    r += 1;

    for (const row of data.rows) {
        const values = [row.id, row.name, row.reg, row.scale, row.comment, row.hex, row.physical, row.unit];
        const bodyRow = ws.getRow(r);
        values.forEach((v, i) => {
            const c = bodyRow.getCell(i + 1);
            c.value = v;
            c.border = CELL_BORDER;
            c.alignment = { vertical: 'middle', wrapText: i === 4 };
        });
        r += 1;
    }

    r += 1; // пустая строка

    // ── Коэффициенты ──
    ws.mergeCells(r, 1, r, 8);
    const coefHeader = ws.getCell(r, 1);
    coefHeader.value = 'Коэффициенты';
    coefHeader.font = { bold: true };
    r += 1;

    r = addLabelValueRows(ws, r, data.coefficients.map((c) => [c.name, c.value] as [string, string]));

    // Пустые листы — как в шаблоне
    workbook.addWorksheet('Лист2');
    workbook.addWorksheet('Лист3');

    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer;
    return new Blob([new Uint8Array(buffer)], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
}

/** Строки «метка (A:B) + значение (C:H)». Возвращает номер следующей строки */
function addLabelValueRows(
    ws: ExcelJS.Worksheet,
    startRow: number,
    pairs: Array<[string, string]>,
): number {
    let r = startRow;
    for (const [label, value] of pairs) {
        ws.mergeCells(r, 1, r, 2);
        ws.mergeCells(r, 3, r, 8);
        const lc = ws.getCell(r, 1);
        lc.value = label;
        lc.font = { bold: true };
        const vc = ws.getCell(r, 3);
        vc.value = value;
        r += 1;
    }
    return r;
}