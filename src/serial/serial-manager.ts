// src/serial/serial-manager.ts
// Центральный менеджер последовательного порта.
//
// Все транзакции (Modbus, ID-запрос, чтение/запись регистров) идут через
// serialManager.executeTransaction. Реализация — через Rust-команду
// serial_transaction: одна команда делает write+read на одном handle порта
// и возвращает все принятые байты.
//
// Архитектура "фоновый читатель + emit/listen" осталась в прошлом:
// на Windows она давала 80 мс задержки на write из-за сериализации
// read/write драйвером COM-порта. Транзакционная модель убирает эту проблему.

import type { ISerialPort } from './ISerialPort.js';

/** Функция проверки: получен ли полный ответ на транзакцию.
 *  Оставлена в сигнатуре для совместимости; в новой архитектуре не используется —
 *  Rust возвращает всё, что успел прочитать за timeout_ms. */
export type CheckCompleteFn = (buffer: Uint8Array) => boolean;

// Глобальный объект Tauri API.
const invoke = window.__TAURI__.core.invoke;

// === ЦЕНТРАЛЬНЫЙ МЕНЕДЖЕР ПОРТА ===
export class SerialManager {
    public serial: ISerialPort | null;
    private lock: Promise<void>;

    constructor() {
        this.serial = null;
        this.lock = Promise.resolve();
    }

    public init(serial: ISerialPort): void {
        this.serial = serial;
    }

    /** Заглушка для совместимости: раньше запускала фоновый читающий цикл.
     *  Сейчас чтение делает Rust по запросу, отдельного цикла нет. */
    public startReader(): void {
        // no-op
    }

    public async executeTransaction(
        packet: Uint8Array,
        _checkCompleteFn: CheckCompleteFn,
        timeoutMs: number = 1000
    ): Promise<Uint8Array> {
        const oldLock = this.lock;
        let release: () => void = () => { };
        this.lock = new Promise((r) => { release = r; });
        await oldLock;

        try {
            const port = this.serial;
            if (!port) {
                throw new Error("[SerialManager] Порт не инициализирован для транзакции.");
            }

            // Одна Rust-команда делает и write, и read на одном handle.
            const dataArray = Array.from(packet);
            const response = await invoke<number[]>('serial_transaction', {
                data: dataArray,
                timeoutMs,
            });

            return new Uint8Array(response);
        } catch (err) {
            console.error("[SerialManager] Ошибка транзакции:", err);
            throw err;
        } finally {
            release();
        }
    }
}

export const serialManager = new SerialManager();