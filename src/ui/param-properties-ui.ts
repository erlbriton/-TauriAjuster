// src/ui/param-properties-ui.ts
/**
 * Окно "Свойства параметра": открывается по двойному клику на строке таблицы
 * параметров. Заполняет поля данными параметра, даёт редактировать шкалу и
 * зависимость. "Применить" пока просто закрывает окно — логика сохранения
 * будет добавлена следующим шагом.
 */
import { markDirty } from '../ini-manager/dirty-tracker.js';
import { float32ToHex, hexToFloat32 } from '../ini-manager/tree-core.js';
import { updateCellDisplay, updateMismatchClass } from '../table-editor/controller-write.js';

/** ID параметра, для которого сейчас открыто окно свойств */
let currentParamId: string | null = null;

interface ParamInfo {
    id: string;
    name: string;
    description: string;
    unit: string;
    scale: string | number;
}

interface ScaleEntry {
    name: string;
    value: string;
}

const SCALE_TABLE: ScaleEntry[] = [
    { name: 'IntegerScale', value: '1' },
    { name: 'FracDecScale', value: '0.1' },
    { name: 'FracHundScale', value: '0.01' },
    { name: 'FracThousScale', value: '0.001' },
    { name: 'FracDecThousScale', value: '0.0001' },
];

function getScaleValue(scaleName: string): string {
    const entry = SCALE_TABLE.find((s) => s.name === scaleName);
    return entry ? entry.value : '1';
}

function scaleNameFromParam(scale: string | number): string {
    if (typeof scale === 'string') {
        if (SCALE_TABLE.some((s) => s.name === scale)) return scale;
        // Строка-число ("0.1", "0.01"...) — ищем по значению
        const byValue = SCALE_TABLE.find((s) => s.value === scale);
        if (byValue) return byValue.name;
    } else if (typeof scale === 'number') {
        const byValue = SCALE_TABLE.find((s) => s.value === String(scale));
        if (byValue) return byValue.name;
    }
    return 'IntegerScale';
}

export function initParamPropertiesUI(): void {
    const overlay = document.getElementById('paramPropsOverlay');
    if (!overlay) return;

    const scaleSelect = document.getElementById('paramPropsScaleSelect') as HTMLSelectElement | null;
    const scaleValue = document.getElementById('paramPropsScaleValue') as HTMLInputElement | null;

    // Автообновление числового эквивалента при смене шкалы
    scaleSelect?.addEventListener('change', () => {
        if (scaleValue) scaleValue.value = getScaleValue(scaleSelect.value);
    });

    const closeBtn = document.getElementById('paramPropsCloseBtn');
    const applyBtn = document.getElementById('paramPropsApplyBtn');
    const cancelBtn = document.getElementById('paramPropsCancelBtn');

    const hide = (): void => {
        overlay.classList.add('hidden');
    };

    closeBtn?.addEventListener('click', hide);
        applyBtn?.addEventListener('click', () => {
      if (currentParamId) {
        const row = document.querySelector<HTMLTableRowElement>(
          `#grid-data-rows tr[data-key="${CSS.escape(currentParamId)}"]`
        );
        if (row) {
          let parts: string[] = [];
          try { parts = JSON.parse(row.dataset.parts || '[]'); } catch {}

          const coefficientInput = document.getElementById('paramPropsCoefficient') as HTMLInputElement | null;
          const newCoef = (coefficientInput?.value ?? '').trim().replace(',', '.');
          const dependsOn = (parts[8] ?? '').trim();
          const hasDep = dependsOn !== '' && dependsOn !== '0';
          const dataType = (row.getAttribute('data-type') || '').toUpperCase();
          const hexIndex = parseInt(row.getAttribute('data-hex-index') || '-1', 10);
          const tds = row.querySelectorAll('td');

          if (newCoef) {
            if (hasDep) {
              // Коэффициент = множитель: пишем в parts[9], значение = база × множитель
              parts[9] = newCoef;
              const mult = parseFloat(newCoef);
              const baseRow = document.querySelector<HTMLTableRowElement>(
                `#grid-data-rows tr[data-name="${CSS.escape(dependsOn)}"]`
              );
              if (baseRow && !isNaN(mult)) {
                const basePhysText = (baseRow.querySelectorAll('td')[5]?.textContent || '').trim();
                const baseValue = parseFloat(basePhysText.replace(',', '.'));
                if (!isNaN(baseValue)) {
                  const newValue = baseValue * mult;
                  const newValueStr = parseFloat(newValue.toFixed(6)).toString();

                  let scale = 1.0;
                  const ps = parseFloat((parts[6] || '').replace(',', '.'));
                  if (!isNaN(ps) && ps !== 0) scale = ps;

                  const is32Bit = dataType.includes('FLOAT') || dataType.includes('DWORD') ||
                      dataType.includes('LONG') || dataType.includes('INT32');
                  let newHex: string;
                  if (dataType.includes('FLOAT')) {
                    newHex = 'x' + float32ToHex(newValue / scale).toUpperCase();
                  } else {
                    const rawVal = Math.round(newValue / scale);
                    newHex = is32Bit
                      ? 'x' + (rawVal >>> 0).toString(16).toUpperCase().padStart(8, '0')
                      : 'x' + (rawVal & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
                  }

                  if (hexIndex >= 0 && hexIndex < parts.length) parts[hexIndex] = newHex;
                  updateCellDisplay(tds[4], newHex);
                  updateCellDisplay(tds[5], newValueStr);
                  console.log(`[PARAM-PROPS] ${currentParamId}: множитель=${newCoef}, значение пересчитано = ${newValueStr}`);
                }
              } else {
                console.warn(`[PARAM-PROPS] Базовый параметр "${dependsOn}" не найден или множитель не читается`);
              }
            } else {
              // Зависимости нет: коэффициент = шкала: пишем в parts[6], Physical = hex × шкала
              parts[6] = newCoef;
              const scale = parseFloat(newCoef);
              if (!isNaN(scale) && scale !== 0 && hexIndex >= 0 && hexIndex < parts.length) {
                const hexStr = (parts[hexIndex] || '').replace(/^x/i, '');
                const dec = parseInt(hexStr, 16);
                let raw = dec;
                if (dataType.includes('FLOAT')) {
                  raw = hexToFloat32(hexStr);
                } else if (dataType === 'TSHORT' || dataType === 'TINT16' || dataType === 'TINTEGER') {
                  if (dec > 32767) raw = dec - 65536;
                } else if (dataType === 'TLONG' || dataType === 'TINT32') {
                  if (dec > 2147483647) raw = dec - 4294967296;
                }
                const phys = raw * scale;
                updateCellDisplay(tds[5], parseFloat(phys.toFixed(6)).toString());
                console.log(`[PARAM-PROPS] ${currentParamId}: шкала=${newCoef}, Physical пересчитан = ${parseFloat(phys.toFixed(6))}`);
              }
              const scaleValue = document.getElementById('paramPropsScaleValue') as HTMLInputElement | null;
              if (scaleValue) scaleValue.value = newCoef;
            }
            row.dataset.parts = JSON.stringify(parts);
            updateMismatchClass(row, dataType);
            markDirty(currentParamId);
          }
        }
      }
      hide();
    });
    cancelBtn?.addEventListener('click', hide);

    overlay.addEventListener('click', (e: MouseEvent) => {
        if (e.target === overlay) hide();
    });

    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (!overlay.classList.contains('hidden') && e.key === 'Escape') {
            hide();
        }
    });

    // --- Перетаскивание окна за шапку ---
    const win = overlay.querySelector<HTMLElement>('.param-props-window');
    const header = overlay.querySelector<HTMLElement>('.param-props-header');

    if (win && header) {
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;

        header.addEventListener('mousedown', (e: MouseEvent) => {
            // Игнорируем клик по кнопке закрытия
            if ((e.target as HTMLElement).closest('.param-props-close-btn')) return;

            // Переключаем окно с flex-центрирования на absolute-позиционирование,
            // сохраняя текущие координаты — чтобы окно визуально не «прыгнуло».
            const rect = win.getBoundingClientRect();
            win.style.position = 'fixed';
            win.style.left = `${rect.left}px`;
            win.style.top = `${rect.top}px`;
            win.style.margin = '0';

            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            startLeft = rect.left;
            startTop = rect.top;

            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e: MouseEvent) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            win.style.left = `${startLeft + dx}px`;
            win.style.top = `${startTop + dy}px`;
        });

        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            document.body.style.userSelect = '';
        });
    }
}

/**
 * Открывает окно свойств параметра, заполняя поля данными param.
 * allSiblings — остальные параметры той же секции (для списка "Зависит от").
 */
export function showParamPropertiesModal(param: ParamInfo, allSiblings: ParamInfo[]): void {
    const overlay = document.getElementById('paramPropsOverlay');
    if (!overlay) return;

    // Запоминаем, какой параметр открыт — нужно для кнопки Apply
    currentParamId = param.id;

    const nameInput = document.getElementById('paramPropsName') as HTMLInputElement | null;
    const descInput = document.getElementById('paramPropsDescription') as HTMLInputElement | null;
    const unitInput = document.getElementById('paramPropsUnit') as HTMLInputElement | null;
    const scaleSelect = document.getElementById('paramPropsScaleSelect') as HTMLSelectElement | null;
    const scaleValue = document.getElementById('paramPropsScaleValue') as HTMLInputElement | null;
    const dependsView = document.getElementById('paramPropsDependsSelect') as HTMLElement | null;
    const dependsSideInput = document.getElementById('paramPropsDependsSide') as HTMLInputElement | null;
    const coefficient = document.getElementById('paramPropsCoefficient') as HTMLInputElement | null;

    if (nameInput) nameInput.value = param.name ?? '';
    if (descInput) descInput.value = param.description ?? '';
    if (unitInput) unitInput.value = (param.unit ?? '').replace('*', '—');

    // Шкала: выбираем по имени, число справа — эквивалент.
    const scaleName = scaleNameFromParam(param.scale);
    if (scaleSelect) scaleSelect.value = scaleName;
    if (scaleValue) scaleValue.value = getScaleValue(scaleName);

    // Получаем parts из строки таблицы
    const row = document.querySelector<HTMLTableRowElement>(
        `#grid-data-rows tr[data-key="${CSS.escape(param.id)}"]`
    );
    let parts: string[] = [];
    if (row) {
        try { parts = JSON.parse(row.dataset.parts || '[]'); } catch {}
    }

    const dependsOn = (parts[8] ?? '').trim();
    const hasDep = dependsOn !== '' && dependsOn !== '0';
    const multiplier = hasDep ? (parts[9] ?? '').trim() : '';
    
    console.log(`[PARAM-PROPS] ${param.id}: parts[${parts.length}] =`, parts);
    console.log(`[PARAM-PROPS] scale из param.scale =`, param.scale);
    console.log(`[PARAM-PROPS] parts[8]=${parts[8]}, parts[9]=${parts[9]}`);

    // "Зависит от": только отображение имени параметра-родителя.
    // Пользователь не может изменить — зависимость задаётся только в INI.
    if (dependsView) {
        dependsView.textContent = dependsOn || '—';
    }

    // Справа от «Зависит от» — значение по умолчанию родителя в формате
    // "x<HEX> = <PHYS> <UNIT>", например "x189C = 6300 B".
    // Физическое значение = raw-значение (parts[10]) × scale родителя.
    if (dependsSideInput) {
        dependsSideInput.value = '';
        if (hasDep) {
            const parentRow = document.querySelector<HTMLTableRowElement>(
                `#grid-data-rows tr[data-name="${CSS.escape(dependsOn)}"]`
            );
            if (parentRow) {
                const parentParts = JSON.parse(parentRow.dataset.parts || '[]');
                const rawHex = (parentParts[10] ?? '').trim();       // "x189C"
                const unit = (parentParts[5] ?? '').trim();          // "B"
                if (rawHex) {
                    const hexClean = rawHex.replace(/^x/i, '');
                    const rawDec = parseInt(hexClean, 16);
                    if (!isNaN(rawDec)) {
                        // Scale родителя — уже разрешённое число из allSiblings.
                        const parentParam = allSiblings.find((p) => p.name === dependsOn);
                        const parentScale =
                            parentParam && typeof parentParam.scale === 'number'
                            && isFinite(parentParam.scale) && parentParam.scale > 0
                                ? parentParam.scale
                                : 1;
                        const physical = rawDec * parentScale;
                        const physicalStr = physical.toString().replace('.', ',');
                        dependsSideInput.value = `${rawHex} = ${physicalStr} ${unit}`.trim();
                    }
                }
            } else {
                console.warn(`[PARAM-PROPS] parent ${dependsOn} не найден в таблице`);
            }
        }
    }

    // Коэффициент: при наличии зависимости — множитель (parts[9]);
    // при отсутствии — прочерк (шкала уже отображается в поле «Шкала» выше).
    if (coefficient) {
        coefficient.value = hasDep ? multiplier.replace('.', ',') : '—';
    }

    // Вид параметра: нередактируемое поле, значение — тип из строки таблицы (TWORD, TPrmList…)
    const typeView = document.getElementById('paramPropsTypeView') as HTMLInputElement | null;
    if (typeView) {
        typeView.value = row?.getAttribute('data-type') ?? '';
    }

    // Сброс позиции окна: при каждом открытии окно снова центрируется
    // (перетаскивание действует только в течение текущего показа).
    const win = overlay.querySelector<HTMLElement>('.param-props-window');
    if (win) {
        win.style.position = '';
        win.style.left = '';
        win.style.top = '';
        win.style.margin = '';
    }

    overlay.classList.remove('hidden');
}