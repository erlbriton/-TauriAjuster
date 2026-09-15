// src/ini-manager/table-saver.ts

/** Тип функции float32ToHex из tree-core.ts */
type Float32ToHexFn = (floatVal: number, padLen?: number) => string;

/**
 * Вычисляет новое hex-значение параметра по физическому вводу.
 * Используется при инлайн-редактировании ячеек таблицы.
 */
export function calculateNewHex(
    newValStr: string,
    dataType: string,
    scale: number,
    originalHexLen: number,
    float32ToHex: Float32ToHexFn,
): string {
    newValStr = newValStr.replace(',', '.');
    if (!newValStr) newValStr = '0';

    if (dataType === 'TBit') {
        return (newValStr === '1' || newValStr.toLowerCase() === 'true') ? '1' : '0';
    } else if (dataType === 'TFloat') {
        const floatVal = parseFloat(newValStr);
        const unscaled = !isNaN(scale) && scale !== 0 ? floatVal / scale : floatVal;
        return float32ToHex(isNaN(unscaled) ? 0 : unscaled, originalHexLen);
    } else {
        const physVal = parseFloat(newValStr);
        const unscaledInt = !isNaN(scale) && scale !== 0 ? Math.round(physVal / scale) : Math.round(physVal);
        let val = isNaN(unscaledInt) ? 0 : unscaledInt;
        if (val < 0) val = (val & 0xFFFF);
        return 'x' + val.toString(16).toUpperCase().padStart(originalHexLen, '0');
    }
}