// src/ui/tree.ts

import { showParamPropertiesModal } from './param-properties-ui.js';
import { populateDeviceForm } from './ui.js';
import { currentIniConfig, hexToFloat32, float32ToHex } from '../ini-manager/tree-core.js';
import {
    clearAnyActiveCellEditors,
    initHexCellEditor,
    initPhysicalCellEditor,
} from '../ini-manager/table-editor.js';
import { updateRowValues } from '../ini-manager/tree-ui.js';
import { IniConfig } from '../core/ini/index.js';
import type { TableEditorState } from '../ini-manager/table-editor.js'; // Импортируем тип состояния
import { isDirty } from '../ini-manager/dirty-tracker.js';

declare global {
    interface Window {
        initTableResizers?: () => void;
        appState?: TableEditorState; // Для совместимости, если где-то еще используется
    }
}

/**
 * Отрисовка таблицы Modbus.
 * Профессиональный подход: явная передача состояния (appState) для независимости от глобального window.
 * 
 * @param config Конфигурация устройства (INI)
 * @param appState Состояние приложения (адрес ведомого, флаги и т.д.)
 */
export function renderModbusTable(config?: IniConfig, appState?: TableEditorState): void {
    const tableBody = document.getElementById('grid-data-rows');
    if (!tableBody) return;

    // Если состояние не передано явно, пытаемся получить его из window (fallback для браузера)
    // В нативном приложении этот fallback не сработает, поэтому передача аргумента обязательна.
    const currentState = appState || (window.appState as TableEditorState) || { slaveAddress: 0x01 };

    const modeSelect = document.querySelector<HTMLSelectElement>('.toolbar-device-mode-select');
    const selectedMode = modeSelect && modeSelect.value ? modeSelect.value : 'FLASH';

    tableBody.innerHTML = '';

    if (!config || !config.isValid) return;

    const params = config.getSection(selectedMode);
    if (params.length === 0) return;

    for (const param of params) {
        try {
            const tr = document.createElement('tr');
            tr.setAttribute('data-type', param.dataType);
            tr.setAttribute('data-section', selectedMode);
            tr.setAttribute('data-key', param.id);
            tr.setAttribute('data-name', param.name);

            if (param.registerAddress !== null) {
                tr.setAttribute('data-reg', param.registerAddress.toString(16));
                if (param.bitIndex !== null) {
                    tr.setAttribute('data-sub', param.bitIndex.toString(16));
                }
            }
            
            // Для TByte и TPrmList: извлекаем модификатор байта (L/H) из регистра и сохраняем в data-sub.
            // Это гарантирует, что при повторном редактировании мы его не потеряем,
            // даже если device_updater обновит parts.
            if (param.dataType && (param.dataType.toUpperCase() === 'TBYTE' || param.dataType.toUpperCase() === 'TPRMLIST')) {
                let byteMod = '';
                for (const p of param.rawParts) {
                    const m = /^r[0-9A-Fa-f]+\.([LHlh])$/.exec((p || '').trim());
                    if (m) {
                        byteMod = m[1].toUpperCase();
                        break;
                    }
                }
                if (byteMod) {
                    tr.setAttribute('data-sub', byteMod);
                }
            }

            let hexIndex = -1;
            if (param.isBit) {
                hexIndex = param.rawParts.length - 1;
            } else {
                for (let j = param.rawParts.length - 1; j >= 3; j--) {
                    const part = (param.rawParts[j] ?? '').trim();
                    if (!part.includes('#') && part.startsWith('x')) {
                        hexIndex = j;
                        break;
                    }
                }
            }
                        tr.setAttribute('data-hex-index', hexIndex.toString());
            tr.dataset.parts = JSON.stringify(param.rawParts);

            tr.innerHTML = `
                <td>${param.id}</td>
                <td class="param-name" title="${param.name}">${param.name}</td>
                <td class="param-desc" title="${param.description}">${param.description}</td>
                <td>—</td>
                <td class="hex-val">—</td>
                <td>—</td>
                <td class="hex-val">—</td>
                <td>—</td>
            `;

            // Если параметр уже помечен как несохранённый — добавляем звёздочку
            if (isDirty(param.id)) {
                const firstTd = tr.querySelector('td');
                if (firstTd) {
                    const star = document.createElement('span');
                    star.className = 'dirty-star';
                    star.textContent = ' *';
                    star.title = 'Есть несохранённые изменения';
                    firstTd.appendChild(star);
                }
            }

            const unitsDisplay = param.isBit ? '.' : (param.unit === '*' ? '—' : param.unit);
            const tds = tr.querySelectorAll('td');
            if (tds[3]) {
                tds[3].textContent = unitsDisplay;
            }

            let originalHexLen = 4;
            if (hexIndex !== -1 && param.rawParts[hexIndex] !== undefined) {
                const hexStr = String(param.rawParts[hexIndex]);
                if (hexStr.startsWith('x')) {
                    originalHexLen = hexStr.slice(1).length;
                }
            }

            const prmListOptions: Record<string, string> = {};
            for (let j = param.rawParts.length - 1; j >= 3; j--) {
                const part = (param.rawParts[j] ?? '').trim();
                if (part.includes('#')) {
                    const [h, t] = part.split('#');
                    if (h && t) {
                        prmListOptions[h.toLowerCase()] = t;
                    }
                }
            }

            updateRowValues(
                tr,
                param.rawParts,
                param.dataType,
                param.scale,
                hexIndex,
                originalHexLen,
                prmListOptions,
                hexToFloat32,
                float32ToHex,
            );

                        // --- ИНИЦИАЛИЗАЦИЯ РЕДАКТОРОВ (БАЗА + КОНТРОЛЛЕР) ---
            
            // 1. Редакторы для БАЗЫ (колонки 4 и 5) — только UI, без отправки
            if (tds[4] && tds[5]) {
                initHexCellEditor(
                    tds[4], 
                    tr, 
                    param.rawParts, 
                    hexIndex,
                    updateRowValues, 
                    param.dataType, 
                    param.scale,
                    originalHexLen, 
                    prmListOptions,
                    currentState, 
                    4             // Индекс колонки Базы Hex
                );
                
                initPhysicalCellEditor(
                    tds[5], 
                    tr, 
                    param.rawParts, 
                    param.dataType,
                    param.scale, 
                    hexIndex, 
                    originalHexLen,
                    prmListOptions, 
                    updateRowValues,
                    hexToFloat32, 
                    float32ToHex,
                    currentState, 
                    5             // Индекс колонки Базы Physical
                );
            }

            // 2. Редакторы для КОНТРОЛЛЕРА (колонки 6 и 7)
            // Запись в устройство и обратное чтение будут реализованы
            // в processControllerWrite в следующих шагах
            if (tds[6] && tds[7]) {
                initHexCellEditor(
                    tds[6], 
                    tr, 
                    param.rawParts, 
                    hexIndex,
                    updateRowValues, 
                    param.dataType, 
                    param.scale,
                    originalHexLen, 
                    prmListOptions,
                    currentState, 
                    6             // Индекс колонки Контроллера Hex
                );
                
                initPhysicalCellEditor(
                    tds[7], 
                    tr, 
                    param.rawParts, 
                    param.dataType,
                    param.scale, 
                    hexIndex, 
                    originalHexLen,
                    prmListOptions, 
                    updateRowValues,
                    hexToFloat32, 
                    float32ToHex,
                    currentState, 
                    7             // Индекс колонки Контроллера Physical
                );
            }

            // --- ДВОЙНОЙ КЛИК ПО СТРОКЕ → окно "Свойства параметра" ---
            // Игнорируем двойной клик по 4-м правым ячейкам (там свои редакторы).
            tr.addEventListener('dblclick', (event: MouseEvent) => {
                const target = event.target as HTMLElement;
                const clickedCell = target.closest('td');
                if (clickedCell && (clickedCell === tds[4] || clickedCell === tds[5] || clickedCell === tds[6] || clickedCell === tds[7])) {
                    return;
                }
                showParamPropertiesModal(
                    {
                        id: param.id,
                        name: param.name,
                        description: param.description,
                        unit: param.unit,
                        scale: param.scale,
                    },
                    params.map((p) => ({
                        id: p.id,
                        name: p.name,
                        description: p.description,
                        unit: p.unit,
                        scale: p.scale,
                    })),
                );
            });

            // --- ЛОГИКА ВЫДЕЛЕНИЯ СТРОКИ (ДЛЯ КЛИКОВ СЛЕВА) ---
            tr.addEventListener('click', (event: MouseEvent) => {
                const target = event.target as HTMLElement;
                const clickedCell = target.closest('td');
                
                // Если клик был по одной из 4-х правых ячеек, игнорируем этот слушатель
                if (clickedCell && (clickedCell === tds[4] || clickedCell === tds[5] || clickedCell === tds[6] || clickedCell === tds[7])) {
                    return; 
                }

                const prevSelectedRow = document.querySelector('#grid-data-rows tr.selected');
                if (prevSelectedRow && prevSelectedRow !== tr) {
                    prevSelectedRow.classList.remove('selected');
                    clearAnyActiveCellEditors();
                }
                tr.classList.add('selected');
                
                document.querySelectorAll('#grid-data-rows td.cell-active').forEach(el => el.classList.remove('cell-active'));
            });

            // --- ЛОГИКА ДЛЯ 4-Х ПРАВЫХ ЯЧЕЕК (ВЫДЕЛЕНИЕ + ПОДСВЕТКА) ---
            const dataCells = [tds[4], tds[5], tds[6], tds[7]];
            
            dataCells.forEach((cell) => {
                if (!cell) return;
                cell.style.cursor = 'pointer';

                cell.addEventListener('click', (e) => {
                    e.stopPropagation();

                    // 1. Синхронизация выделения строки (голубой фон)
                    const prevSelectedRow = document.querySelector('#grid-data-rows tr.selected');
                    if (prevSelectedRow && prevSelectedRow !== tr) {
                        prevSelectedRow.classList.remove('selected');
                        clearAnyActiveCellEditors();
                    }
                    tr.classList.add('selected');

                    // 2. Подсветка активной ячейки (желтый фон)
                    document.querySelectorAll('#grid-data-rows td.cell-active').forEach(el => {
                        el.classList.remove('cell-active');
                    });

                    cell.classList.add('cell-active');
                });
            });

            tableBody.appendChild(tr);
        } catch (e) {
            console.error('Ошибка при отрисовке строки:', param.id, e);
        }
    }

    if (typeof window.initTableResizers === 'function') {
        window.initTableResizers();
    }
}///////////////////////////////////////////////////////////////////////////////////////////////////////\

document.addEventListener('DOMContentLoaded', () => {
    const modeSelect = document.querySelector<HTMLSelectElement>('.toolbar-device-mode-select');
    if (modeSelect) {
        modeSelect.addEventListener('change', () => {
            clearAnyActiveCellEditors();
            // При смене режима передаем текущий конфиг и (опционально) состояние, если оно доступно глобально
            // В идеале вызвать renderModbusTable(currentIniConfig, window.appState)
            if (currentIniConfig) {
                renderModbusTable(currentIniConfig, window.appState);
                // Автоопрос контроллера при смене секции памяти (как после загрузки INI-файла)
                window.dispatchEvent(new CustomEvent('app:ini-file-loaded'));
            }
        });
    }
    document.addEventListener('click', () => {
        clearAnyActiveCellEditors();
    });
});