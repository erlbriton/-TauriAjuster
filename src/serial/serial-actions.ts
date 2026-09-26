// src/serial/serial-actions.ts
// Фасад для обратной совместимости импортов.
//
// Раньше этот модуль содержал всё: SerialManager, CRC, подключение, цикл опроса
// и Modbus-функции. Сейчас код разнесён по пяти файлам:
//   - serial-manager.ts       — центральный менеджер порта;
//   - modbus-crc.ts           — CRC16 и оптимизация батчей;
//   - device-connection.ts    — подключение и идентификация (ID);
//   - modbus-functions.ts     — декодеры и FC03/FC16;
//   - read-loop.ts            — главный цикл опроса.
//
// Этот файл реэкспортирует публичные символы, чтобы внешние модули
// (modbus-scanner, table-editor, device_updater, cmdline-ui, controller-write,
// copy-ops, main) продолжали импортировать их из './serial-actions.js'
// без изменений.

// SerialManager и его экземпляр serialManager вынесены в serial-manager.ts.
export { serialManager } from './serial-manager.js';
export type { CheckCompleteFn } from './serial-manager.js';

// calculateCRC и getOptimizedBatches вынесены в modbus-crc.ts.
// RegisterBatch переехал туда же (используется сигнатурой getOptimizedBatches).
export { calculateCRC, getOptimizedBatches } from './modbus-crc.js';
export type { RegisterBatch } from './modbus-crc.js';

// updateComInterfaceName, executeDeviceConnection, executeDeviceIdentification
// вынесены в device-connection.ts.
export {
    updateComInterfaceName,
    executeDeviceConnection,
    executeDeviceIdentification,
} from './device-connection.js';

// writeRegistersFC16 и readHoldingRegistersFC03 вынесены в modbus-functions.ts.
// Декодеры (decode32BitValue, decode16BitValue) там же, но снаружи не нужны —
// их использует только readLoop.
export { writeRegistersFC16, readHoldingRegistersFC03 } from './modbus-functions.js';

// readLoop вынесена в read-loop.ts.
export { readLoop } from './read-loop.js';