// src/ini-manager/hex-utils.ts
// Утилиты преобразования между hex-строкой и 32-битными значениями
// (Float32, для 16-битных — прямая работа с parseInt).
//
// Файл выделен из tree-core.ts: функции чистые, не зависят от DOM,
// deviceRegistry и вообще от какого-либо состояния модуля. Их использует
// 7 файлов (tree-row-values, ChannelRow, device_updater, ui/tree,
// param-properties-ui, value-write), а также planControllerWrite внутри
// tree-core — поэтому после выноса они импортируются из нового файла
// и реэкспортируются из tree-core для обратной совместимости.

/**
 * Преобразует hex-строку в 32-битное значение Float32.
 * При невалидном входе возвращает NaN.
 *
 * @param hexStr hex-строка (может содержать или не содержать префикс 'x').
 * @returns Число с плавающей точкой или NaN.
 */
export function hexToFloat32(hexStr: string): number {
  if (!hexStr) return NaN;
  const intVal = parseInt(hexStr, 16);
  if (isNaN(intVal)) return NaN;
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, intVal, false);
  return view.getFloat32(0, false);
}

/**
 * Преобразует число Float32 в hex-строку с префиксом 'x'.
 *
 * @param floatVal Число с плавающей точкой.
 * @param padLen Длина hex-строки без префикса (по умолчанию 8).
 * @returns Строка вида "x47359000".
 */
export function float32ToHex(floatVal: number, padLen: number = 8): string {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, floatVal, false);
  const intVal = view.getUint32(0, false);
  return 'x' + intVal.toString(16).toUpperCase().padStart(padLen, '0');
}