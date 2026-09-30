// src/serial/tauri-tcp.ts
//
// Нативная реализация TCP-транспорта для Modbus RTU over TCP/IP.
// Реализует контракт ISerialPort, поэтому может быть подставлена
// в SerialManager вместо TauriSerialPort без изменений в остальном коде.
//
// Важно: это НЕ стандартный Modbus TCP (с MBAP-заголовком).
// Кадр остаётся RTU-формата (slave + FC + data + CRC16), просто
// передаётся через TCP-сокет как поток байт.
//
// Внутри:
//   - connect()  → Rust-команда open_tcp_connection
//   - release()  → Rust-команда close_tcp_connection
//   - transaction (через SerialManager) → Rust-команда tcp_transaction
//   - notifyDisconnect() → вызывается SerialManager при фатальной ошибке
//
// transportKind = 'tcp' — сигнал SerialManager'у использовать tcp_transaction
// вместо serial_transaction.

import type { ISerialPort } from './ISerialPort.js';

const invoke = window.__TAURI__.core.invoke;

export class TauriTcpPort implements ISerialPort {
    /** Текущий статус: открыт ли сокет. */
    public isConnected: boolean = false;

    /** Признак для SerialManager: использовать tcp_transaction. */
    public readonly transportKind = 'tcp' as const;

    /** IP-адрес контроллера. */
    private host: string;

    /** TCP-порт контроллера. */
    private port: number;

    /** Колбэк, вызываемый при обрыве соединения. */
    private disconnectCallback: (() => void) | null = null;

    /** Promise незавершённого закрытия — чтобы close шёл строго перед open. */
    private pendingClose: Promise<void> | null = null;

    constructor(host: string, port: number) {
        this.host = host;
        this.port = port;
    }

    /**
     * Обновить endpoint (host + port) до вызова connect().
     * Используется UI, когда пользователь меняет IP/Port в полях.
     */
    public setEndpoint(host: string, port: number): void {
        this.host = host;
        this.port = port;
    }

    public getEndpoint(): { host: string; port: number } {
        return { host: this.host, port: this.port };
    }

    /**
     * Открыть TCP-соединение через Rust-команду open_tcp_connection.
     * Параметр baudRate игнорируется — для TCP он не имеет смысла.
     */
    public async connect(_baudRate?: number): Promise<void> {
        if (!this.host) {
            throw new Error('TCP: не задан IP-адрес');
        }
        if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) {
            throw new Error(`TCP: неверный порт ${this.port}`);
        }

        if (this.pendingClose) {
            await this.pendingClose;
            this.pendingClose = null;
        }

        await invoke('open_tcp_connection', {
            host: this.host,
            port: this.port,
        });

        this.isConnected = true;
    }

    /**
     * Заглушка для совместимости с контрактом ISerialPort.
     * В транзакционной модели чтение делает tcp_transaction,
     * отдельного readChunk нет.
     */
    public async readChunk(): Promise<Uint8Array | null> {
        return null;
    }

    /**
     * Прямая запись байт в сокет не поддерживается — все обмены идут
     * через transaction (tcp_transaction). Метод оставлен, чтобы
     * соблюсти интерфейс, но при вызове бросает исключение.
     */
    public async write(_data: Uint8Array): Promise<void> {
        throw new Error('TCP: прямая запись не поддерживается, используйте transaction');
    }

    /**
     * Информация об устройстве (VID/PID). Для TCP не применима.
     */
    public getPortInfo(): { usbVendorId?: number; usbProductId?: number } {
        return {};
    }

    /**
     * Подписка на обрыв соединения. Колбэк вызывается один раз.
     */
    public onDisconnect(cb: () => void): void {
        this.disconnectCallback = cb;
    }

    /**
     * Уведомить порт о фатальной ошибке транспорта.
     * Вызывается SerialManager, когда invoke('tcp_transaction') падает
     * с ошибкой обрыва. Сбрасывает isConnected и запускает disconnectCallback.
     */
    public notifyDisconnect(): void {
        if (!this.isConnected) return;
        console.log('[TauriTcpPort] notifyDisconnect: помечаем соединение отключённым.');
        this.isConnected = false;
        if (this.disconnectCallback) {
            this.disconnectCallback();
        }
    }

    /**
     * Освободить ресурсы: закрыть сокет через Rust.
     */
    public release(): void {
        if (this.isConnected) {
            this.pendingClose = invoke<void>('close_tcp_connection').catch((err) => {
                console.error('[TauriTcpPort] Ошибка закрытия TCP:', err);
            });
        }
        this.isConnected = false;
    }
}