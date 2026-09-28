// src/serial/tauri-serial.ts

// Импорт интерфейса контракта: все реализации порта должны его соблюдать
import type { ISerialPort } from './ISerialPort.js';

// Глобальный объект Tauri API (доступен благодаря withGlobalTauri = true в tauri.conf.json)
const invoke = window.__TAURI__.core.invoke;

/**
 * Нативная реализация последовательного порта через Tauri (Rust).
 * Реализует контракт ISerialPort, поэтому может быть подставлена
 * вместо браузерного SerialConnection без изменений в остальном коде.
 *
 * Внутри:
 *  - connect()     → Rust-команда open_serial_port
 *  - write()       → Rust-команда write_serial_port
 *  - release()     → Rust-команда close_serial_port
 *  - readChunk()   → не используется в транзакционной модели
 *  - notifyDisconnect() → вызывается SerialManager при фатальной ошибке
 */
export class TauriSerialPort implements ISerialPort {
    /** Текущий статус: открыт ли порт. */
    public isConnected: boolean = false;

    /** Путь к открытому порту (например, "/dev/ttyUSB0" или "COM3"). */
    private portPath: string = '';

    /** Текущая скорость обмена. */
    private baudRate: number = 115200;

    /** Promise незавершённого закрытия порта — чтобы строго
     *  упорядочить close перед open. */
    private pendingClose: Promise<void> | null = null;

    /** Колбэк, вызываемый при обрыве связи (кабель выдернули и т.п.). */
    private disconnectCallback: (() => void) | null = null;

    constructor(portPath: string = '', baudRate: number = 115200) {
        this.portPath = portPath;
        this.baudRate = baudRate;
    }

    /** Установить путь к порту (вызывается перед connect). */
    public setPortPath(path: string): void {
        this.portPath = path;
    }

    /**
     * Открыть порт через Rust-команду open_serial_port.
     */
    public async connect(baudRate?: number): Promise<void> {
        if (!this.portPath) {
            throw new Error('Порт не указан');
        }

        if (this.pendingClose) {
            await this.pendingClose;
            this.pendingClose = null;
        }

        const rate = baudRate ?? this.baudRate;
        this.baudRate = rate;

        await invoke('open_serial_port', {
            path: this.portPath,
            baudRate: rate
        });

        this.isConnected = true;
    }

    /**
     * Заглушка для совместимости с контрактом ISerialPort.
     * В транзакционной модели чтение делает serial_transaction,
     * отдельного readChunk нет.
     */
    public async readChunk(): Promise<Uint8Array | null> {
        return null;
    }

    /**
     * Записать байты в порт через Rust-команду write_serial_port.
     * Используется редко — обычно всё идёт через serial_transaction.
     */
    public async write(data: Uint8Array): Promise<void> {
        if (!this.isConnected) {
            throw new Error('Порт не открыт');
        }
        const bytes = Array.from(data);
        await invoke('write_serial_port', { data: bytes });
    }

    /**
     * Информация об устройстве (VID/PID) — заглушка.
     */
    public getPortInfo(): { usbVendorId?: number; usbProductId?: number } {
        return {};
    }

    /**
     * Подписка на обрыв связи. Колбэк вызывается один раз при потере порта.
     */
    public onDisconnect(cb: () => void): void {
        this.disconnectCallback = cb;
    }

    /**
     * Уведомить порт о фатальной ошибке транспорта (обрыв USB и т.п.).
     *
     * Вызывается из SerialManager, когда invoke('serial_transaction')
     * падает с ошибкой, означающей смерть handle порта. Сбрасывает
     * isConnected в false и запускает disconnectCallback — благодаря чему
     * UI сбрасывает выпадающий список и пользователь может переоткрыть порт.
     */
    public notifyDisconnect(): void {
        if (!this.isConnected) return;
        console.log('[TauriSerialPort] notifyDisconnect: помечаем порт как отключённый.');
        this.isConnected = false;
        if (this.disconnectCallback) {
            this.disconnectCallback();
        }
    }

    /**
     * Освободить ресурсы: закрыть порт через Rust.
     */
    public release(): void {
        if (this.isConnected) {
            this.pendingClose = invoke<void>('close_serial_port').catch((err) => {
                console.error('[TauriSerialPort] Ошибка закрытия порта:', err);
            });
        }
        this.isConnected = false;
    }
}