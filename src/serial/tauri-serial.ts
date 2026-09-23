// src/serial/tauri-serial.ts

// Импорт интерфейса контракта: все реализации порта должны его соблюдать
import type { ISerialPort } from './ISerialPort.js';

// Глобальный объект Tauri API (доступен благодаря withGlobalTauri = true в tauri.conf.json)
const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

/**
 * Нативная реализация последовательного порта через Tauri (Rust).
 * Реализует контракт ISerialPort, поэтому может быть подставлена
 * вместо браузерного SerialConnection без изменений в остальном коде
 * (осциллограф, serialManager, executeDeviceIdentification и т.д.).
 *
 * Внутри:
 *  - connect()     → Rust-команда open_serial_port
 *  - write()       → Rust-команда write_serial_port
 *  - release()     → Rust-команда close_serial_port
 *  - readChunk()   → читает из внутреннего буфера, который пополняется
 *                    событием "serial-data" от Rust (push-модель)
 */
export class TauriSerialPort implements ISerialPort {
    /** Текущий статус: открыт ли порт. Readonly снаружи, меняется внутри. */
    public isConnected: boolean = false;

    /** Путь к открытому порту (например, "/dev/ttyUSB0" или "COM3"). */
    private portPath: string = '';

    /** Текущая скорость обмена. Храним, чтобы можно было пересоздать порт. */
    private baudRate: number = 115200;

    /**
     * Внутренний буфер принятых байтов.
     * Rust шлёт байты событием "serial-data" в любой момент,
     * а serialManager запрашивает их через readChunk() по мере необходимости.
     * Буфер сглаживает эту разницу во времени.
     */
    private rxBuffer: number[] = [];

    /** Функция отписки от события Rust (возвращается из listen()). */
    private unlisten: (() => void) | null = null;

    /** Promise незавершённого закрытия порта. Нужен, чтобы строго
     *  упорядочить команды: сначала close полностью завершился,
     *  и только потом начался open. */
    private pendingClose: Promise<void> | null = null;

    /** Колбэк, вызываемый при обрыве связи (кабель выдернули и т.п.). */
    private disconnectCallback: (() => void) | null = null;

    /**
     * Конструктор.
     * @param portPath Имя порта из списка (например, "/dev/ttyUSB0").
     *                 Если не указано — порт будет задан через setPortPath() перед connect().
     * @param baudRate Скорость обмена (по умолчанию 115200).
     */
    constructor(portPath: string = '', baudRate: number = 115200) {
        this.portPath = portPath;
        this.baudRate = baudRate;
    }

    /** Установить путь к порту (вызывается перед connect, если порт не задан в конструкторе). */
    public setPortPath(path: string): void {
        this.portPath = path;
    }

    /**
     * Открыть порт через Rust и запустить читающий поток на стороне Rust.
     * После открытия подписывается на событие "serial-data" — Rust сам
     * толкает принятые байты во фронтенд (push-модель).
     */
    public async connect(baudRate?: number): Promise<void> {
        if (!this.portPath) {
            throw new Error('Порт не указан');
        }

        // Если закрытие порта ещё в полёте — дожидаемся его завершения.
        // Без этого команда close могла бы прийти в Rust ПОСЛЕ open
        // и убить только что созданный читающий поток нового порта.
        if (this.pendingClose) {
            await this.pendingClose;
            this.pendingClose = null;
        }

        const rate = baudRate ?? this.baudRate;
        this.baudRate = rate;

        // Открываем порт через Rust-команду.
        // Rust физически открывает устройство и запускает поток чтения,
        // который будет слать байты событием "serial-data".
        await invoke('open_serial_port', {
            path: this.portPath,
            baudRate: rate
        });

        this.isConnected = true;
        this.rxBuffer = [];

        // Подписываемся на поток байтов от Rust.
        // listen возвращает функцию отписки, сохраняем её для release().
        this.unlisten = await listen<number[]>('serial-data', (event) => {
            // event.payload — массив чисел (байты), принятые Rust от устройства.
            // Добавляем их во внутренний буфер, откуда их заберёт readChunk().
            const bytes = event.payload;
            for (const b of bytes) {
                this.rxBuffer.push(b);
            }
        });

        // Дополнительно слушаем событие ошибок порта (кабель выдернули и т.п.)
        await listen<string>('serial-error', () => {
            // При ошибке связи считаем порт отключённым
            this.isConnected = false;
            if (this.disconnectCallback) {
                this.disconnectCallback();
            }
        });
    }

    /**
     * Прочитать очередную порцию байт из внутреннего буфера.
     * Возвращает все накопившиеся байты одним Uint8Array.
     * Если буфер пуст — возвращает null (данных нет).
     *
     * Эта функция вызывается serialManager в цикле чтения.
     * Байты в буфер попадают асинхронно через событие "serial-data".
     */
    public async readChunk(): Promise<Uint8Array | null> {
        if (!this.isConnected || this.rxBuffer.length === 0) {
            return null;
        }

        // Забираем всё содержимое буфера и очищаем его
        const data = new Uint8Array(this.rxBuffer);
        this.rxBuffer = [];
        return data;
    }

    /**
     * Записать байты в порт через Rust-команду write_serial_port.
     * Используется для отправки запросов устройству (Modbus, ID и т.д.).
     */
    public async write(data: Uint8Array): Promise<void> {
        if (!this.isConnected) {
            throw new Error('Порт не открыт');
        }

        // Преобразуем Uint8Array в обычный массив чисел для передачи через JSON.
        // Vec<u8> в Rust десериализуется из JSON-массива чисел автоматически.
        const bytes = Array.from(data);
        await invoke('write_serial_port', { data: bytes });
    }

    /**
     * Информация об устройстве (VID/PID). В нативной реализации пока недоступна,
     * возвращаем пустой объект — контракт требует этот метод.
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
     * Освободить ресурсы: отписаться от событий и закрыть порт через Rust.
     * После вызова порт считается закрытым.
     */
    public release(): void {
        // Отписываемся от события "serial-data", чтобы не получать байты после закрытия
        if (this.unlisten) {
            this.unlisten();
            this.unlisten = null;
        }

        // Закрываем порт через Rust (останавливает поток чтения и освобождает дескриптор).
        // Запоминаем promise, чтобы connect() перед открытием нового порта
        // дождался завершения этого закрытия (строгий порядок close → open).
        if (this.isConnected) {
            // invoke<void> — явно указываем тип результата (void, то есть "ничего").
            // Без этого invoke вернёт Promise<unknown>, который нельзя
            // присвоить полю типа Promise<void>.
            this.pendingClose = invoke<void>('close_serial_port').catch((err) => {
                console.error('[TauriSerialPort] Ошибка закрытия порта:', err);
            });
        }

        this.isConnected = false;
        this.rxBuffer = [];
    }
}