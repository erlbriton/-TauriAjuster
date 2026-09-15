// src/core/csv-export.ts
/**
 * Генератор CSV-отчёта «Отчёт о наладке оборудования».
 * Формат повторяет шаблон старого аджастера: разделитель ";", UTF-8 с BOM.
 * Не зависит от DOM и serial — готов к Tauri.
 */
import type { ReportData } from './excel-report.js';

/** Экранирует значение для CSV: оборачивает в кавычки, если содержит ; или " */
function escapeCsvField(value: string): string {
    if (value.includes(';') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}

/** Формирует строку из 9 полей (разделитель ;) */
function makeRow(fields: string[]): string {
    const padded = [...fields];
    while (padded.length < 9) padded.push('');
    return padded.slice(0, 9).map(escapeCsvField).join(';');
}

/** Сформировать .csv и вернуть как Blob (UTF-8 с BOM) */
export function buildCsvBlob(data: ReportData): Blob {
    const lines: string[] = [];

    // ── Титул ──
    lines.push(makeRow(['Отчёт о наладке оборудования']));
    lines.push(makeRow([])); // пустая строка

    // ── Шапка: №, Дата, Организация ──
    lines.push(makeRow(['№', '', data.reportNumber]));
    lines.push(makeRow(['Дата', '', data.reportDate]));
    lines.push(makeRow(['Организация', '', data.organization]));
    lines.push(makeRow([])); // пустая строка

    // ── Описание объекта ──
    lines.push(makeRow(['Описание объекта']));
    lines.push(makeRow(['Механизм', '', data.mechanism]));
    lines.push(makeRow(['Место установки', '', data.installLocation]));
    lines.push(makeRow(['Тип устройства', '', data.deviceType]));
    lines.push(makeRow(['Серийный номер', '', data.serialNumber]));
    lines.push(makeRow(['Версия ПО', '', data.softwareVersion]));
    lines.push(makeRow(['Файл базы', '', data.baseFile]));
    lines.push(makeRow(['Дата изменения базы', '', data.baseChangeDate]));
    lines.push(makeRow([])); // пустая строка

    // ── Уставки параметров ──
    lines.push(makeRow(['Уставки параметров']));
    lines.push(makeRow(['№', 'Параметр', 'Регистр', 'Коэфф', 'Комментарий', 'HEX', 'Physical', 'Ед.Изм.']));

    for (const row of data.rows) {
        lines.push(makeRow([
            row.id,
            row.name,
            row.reg,
            row.scale,
            row.comment,
            row.hex,
            row.physical,
            row.unit,
        ]));
    }

    lines.push(makeRow([])); // пустая строка

    // ── Коэффициенты ──
    lines.push(makeRow(['Коэффициенты']));
    for (const coef of data.coefficients) {
        lines.push(makeRow([coef.name, '', coef.value]));
    }

    // Собираем текст с BOM (чтобы Excel открывал кириллицу)
    const text = lines.join('\r\n');
    const BOM = '\uFEFF';
    return new Blob([BOM + text], { type: 'text/csv;charset=utf-8' });
}