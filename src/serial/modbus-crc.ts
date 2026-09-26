// src/serial/modbus-crc.ts
// Утилиты Modbus: вычисление CRC16 и оптимизация запросов (группировка
// адресов регистров в батчи). Чистые функции без побочных эффектов.

import type { IniConfig } from '../core/ini/index.js';

/** Диапазон регистров для одного Modbus-запроса. */
export interface RegisterBatch {
    start: number;
    count: number;
}

/**
 * Вычисление Modbus RTU CRC16.
 */
export function calculateCRC(buffer: Uint8Array): number {
    let crc = 0xFFFF;
    for (let pos = 0; pos < buffer.length; pos++) {
        crc ^= buffer[pos];
        for (let i = 8; i !== 0; i--) {
            if ((crc & 0x0001) !== 0) {
                crc >>= 1;
                crc ^= 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    return crc;
}

/**
 * Оптимизация Modbus запросов: группировка адресов регистров в батчи.
 * Разбивает запросы при дырах между адресами > maxGap или при превышении maxRegisters (125 регистров Modbus).
 */
export function getOptimizedBatches(
    config: IniConfig,
    sectionName: string = 'RAM',
    maxGap: number = 10,
    maxRegistersPerBatch: number = 125
): RegisterBatch[] {
    // Единый INI-слой уже содержит уникальные адреса с учётом 32-битных типов
    const sorted = config.getUniqueRegisterAddresses(sectionName);
    if (sorted.length === 0) return [];
    const batches: RegisterBatch[] = [];
    let currentStart = sorted[0];
    let currentEnd = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        const addr = sorted[i];
        const gap = addr - currentEnd - 1;
        const newCount = (addr - currentStart + 1);
        if (gap > maxGap || newCount > maxRegistersPerBatch) {
            batches.push({
                start: currentStart,
                count: currentEnd - currentStart + 1
            });
            currentStart = addr;
            currentEnd = addr;
        } else {
            currentEnd = addr;
        }
    }
    batches.push({
        start: currentStart,
        count: currentEnd - currentStart + 1
    });
    return batches;
}