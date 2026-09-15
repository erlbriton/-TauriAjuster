// src/serial/ISerialPort.ts

/**
 * Информация об USB-устройстве (для определения имени чипа по VID/PID).
 */
export interface SerialPortInfo {
    usbVendorId?: number;
    usbProductId?: number;
}

/**
 * Платформенно-независимый интерфейс последовательного порта.
 *
 * Реализации:
 *  - браузер: SerialConnection (Web Serial API), src/serial/serial.ts;
 *  - нативное приложение (Tauri): адаптер, обращающийся к Rust-бэкенду
 *    через IPC (крейт `serialport`) — будет создан в нативном проекте.
 *
 * Правило подготовки к портированию:
 * вся бизнес-логика (SerialManager, readLoop, идентификация устройства)
 * должна зависеть ТОЛЬКО от этого интерфейса, а не от конкретной реализации.
 */
export interface ISerialPort {
    /** Открыт ли порт в данный момент. */
    readonly isConnected: boolean;

    /** Открыть порт (в браузере — с диалогом выбора порта пользователем). */
    connect(baudRate?: number): Promise<void>;

    /** Прочитать очередную порцию байт. null — данных нет или порт закрыт. */
    readChunk(): Promise<Uint8Array | null>;

    /** Записать байты в порт. */
    write(data: Uint8Array): Promise<void>;

    /** Информация об устройстве (VID/PID). Пустой объект, если недоступна. */
    getPortInfo(): SerialPortInfo;

    /** Подписка на обрыв связи (вызывается один раз при потере порта). */
    onDisconnect(cb: () => void): void;

    /** Освободить ресурсы; после вызова порт считается закрытым. */
    release(): void;
}