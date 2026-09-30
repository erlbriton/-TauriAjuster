// src/serial/serial-manager.ts
// Центральный менеджер последовательного порта.
//
// Все транзакции (Modbus, ID-запрос, чтение/запись регистров) идут через
// serialManager.executeTransaction. Реализация — через Rust-команду
// serial_transaction: одна команда делает write+read на одном handle порта
// и возвращает все принятые байты.

import type { ISerialPort } from './ISerialPort.js';
import { calculateCRC } from './serial-actions.js';

/** Функция проверки: получен ли полный ответ на транзакцию.
 *  Оставлена в сигнатуре для совместимости; в новой архитектуре не используется. */
export type CheckCompleteFn = (buffer: Uint8Array) => boolean;

/**
 * Структурированный результат транзакции. Используется там, где нужно
 * различать ситуации «устройство молчит» и «устройство ответило мусором»
 * (например, в окне «Командная строка»). Обычные потребители (read-loop,
 * device_updater) продолжают пользоваться старым executeTransaction,
 * которая возвращает только валидный ответ или пустой массив.
 */
export type TransactionResult =
    | { kind: 'ok'; bytes: Uint8Array }
    | { kind: 'bad_crc'; bytes: Uint8Array; expected: number; actual: number }
    | { kind: 'too_short'; bytes: Uint8Array }
    | { kind: 'timeout' }
    | { kind: 'error'; message: string };

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

    /**
     * Базовая транзакция: lock + invoke в Rust + возврат сырых байт.
     * Не анализирует содержимое: пустой массив — значит Rust ничего не получил
     * за timeoutMs; непустой — значит пришли байты как есть (включая мусор).
     * При фатальной ошибке транспорта — бросает исключение.
     */
    private async _transaction(packet: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
        const oldLock = this.lock;
        let release: () => void = () => { };
        this.lock = new Promise((r) => { release = r; });
        await oldLock;

        const port = this.serial;

        try {
            if (!port) {
                throw new Error("[SerialManager] Порт не инициализирован для транзакции.");
            }

            // Выбор Rust-команды по типу транспорта:
            //  - 'tcp'    → tcp_transaction (Modbus RTU over TCP/IP, сокет);
            //  - 'serial' или undefined → serial_transaction (COM-порт).
            // Поле transportKind объявлено в ISerialPort как необязательное,
            // поэтому старые реализации (TauriSerialPort без этого поля)
            // продолжают работать через serial_transaction.
            const commandName = port.transportKind === 'tcp'
                ? 'tcp_transaction'
                : 'serial_transaction';

            const dataArray = Array.from(packet);
            const response = await invoke<number[]>(commandName, {
                data: dataArray,
                timeoutMs,
            });

            return new Uint8Array(response);
        } catch (err) {
            console.error("[SerialManager] Ошибка транзакции:", err);

            const msg = err instanceof Error ? err.message : String(err);

            // Fatal-ошибки — те, после которых handle порта/сокета
            // считается мёртвым и требуется переоткрытие. Для serial
            // и TCP наборы сообщений разные, но проверяем все вместе:
            // ложное срабатывание notifyDisconnect безвредно (он просто
            // сбросит isConnected в false).
            const isFatal =
                // serial
                msg.includes('фатальная ошибка') ||
                msg.includes('os error 22') ||
                msg.includes('Устройство не опознает команду') ||
                msg.includes('Порт не открыт') ||
                // TCP
                msg.includes('TCP-соединение не открыто') ||
                msg.includes('Соединение разорвано') ||
                msg.includes('Ошибка записи в сокет') ||
                msg.includes('Ошибка чтения из сокета');

            if (isFatal && port) {
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

    /**
     * Обычная транзакция — как была. Возвращает все байты, полученные от
     * устройства за timeoutMs (включая потенциально битые). Пустой массив —
     * значит устройство молчало. При фатальной ошибке транспорта — бросает
     * исключение (как и раньше).
     */
    public async executeTransaction(
        packet: Uint8Array,
        _checkCompleteFn: CheckCompleteFn,
        timeoutMs: number = 1000
    ): Promise<Uint8Array> {
        return this._transaction(packet, timeoutMs);
    }

    /**
     * Транзакция с диагностикой. Отличается от обычной тем, что не бросает
     * исключение при ошибке транспорта, а возвращает структурированный
     * результат. Используется в окне «Командная строка», где пользователю
     * важно видеть, что именно ответило устройство — даже если CRC битый.
     */
    public async executeTransactionVerbose(
        packet: Uint8Array,
        timeoutMs: number = 1000
    ): Promise<TransactionResult> {
        let bytes: Uint8Array;
        try {
            bytes = await this._transaction(packet, timeoutMs);
        } catch (err) {
            return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
        }

        // 0 байт — устройство молчало всё время.
        if (bytes.length === 0) {
            return { kind: 'timeout' };
        }

        // Modbus RTU: минимальный валидный ответ — 4 байта (slave + FC + CRC×2).
        // Короче — это не ответ, а обрывок.
        if (bytes.length < 4) {
            return { kind: 'too_short', bytes };
        }

        // CRC в Modbus RTU: два последних байта, младший первым.
        const payload = bytes.slice(0, bytes.length - 2);////////////////////////////////
        const expected = calculateCRC(payload);
        const actual = bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8);

        if (expected !== actual) {
            return { kind: 'bad_crc', bytes, expected, actual };
        }

        return { kind: 'ok', bytes };
    }//////////////////////////////////////////////////////////////////////////////////////

//         const payload = bytes.slice(0, bytes.length - 2);
//     // ВРЕМЕННО: намеренно портим вычисленный CRC, чтобы любой валидный
//     // ответ устройства выглядел как bad_crc. Только для проверки UI.
//     // УДАЛИТЬ после теста!
//     const expected = calculateCRC(payload) ^ 0xFFFF;
//     const actual = bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8);

//     if (expected !== actual) {
//         return { kind: 'bad_crc', bytes, expected, actual };
//     }
//     return { kind: 'ok', bytes };
// }

}

export const serialManager = new SerialManager();