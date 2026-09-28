// src/serial/serial-manager.ts
// Центральный менеджер последовательного порта.
//
// Все транзакции (Modbus, ID-запрос, чтение/запись регистров) идут через
// serialManager.executeTransaction. Реализация — через Rust-команду
// serial_transaction: одна команда делает write+read на одном handle порта
// и возвращает все принятые байты.

import type { ISerialPort } from './ISerialPort.js';

/** Функция проверки: получен ли полный ответ на транзакцию.
 *  Оставлена в сигнатуре для совместимости; в новой архитектуре не используется. */
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

    /** Заглушка для совместимости. */
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

        // port объявляем ЗА пределами try, чтобы catch тоже его видел.
        const port = this.serial;

        try {
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

            // Фатальная ошибка транспорта — уведомляем порт.
            const msg = err instanceof Error ? err.message : String(err);
            const isFatal =
                msg.includes('фатальная ошибка') ||
                msg.includes('os error 22') ||
                msg.includes('Устройство не опознает команду') ||
                msg.includes('Порт не открыт');

            if (isFatal && port) {
                // Приведение через unknown: у ISerialPort нет notifyDisconnect
                // (это метод только TauriSerialPort), но мы вызываем его
                // опционально — если он есть у конкретной реализации.
                const maybe = port as unknown as { notifyDisconnect?: () => void };
                if (typeof maybe.notifyDisconnect === 'function') {
                    maybe.notifyDisconnect();
                }
            }

            throw err;
        } finally {
            release();
        }
    }
}

export const serialManager = new SerialManager();