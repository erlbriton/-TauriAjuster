// src/serial/serial.ts

import type { ISerialPort, SerialPortInfo } from './ISerialPort.js';
import type { WebSerialPort } from './web-serial-types.js';

/**
 * Бросается, когда пользователь закрыл окно выбора COM-порта,
 * не выбрав ни одного порта. Это штатная ситуация, а не ошибка.
 */
export class PortCancelledError extends Error {
    constructor() {
        super('Выбор порта отменён пользователем.');
        this.name = 'PortCancelledError';
    }
}

export class SerialConnection implements ISerialPort {
  public port: WebSerialPort | null;
  public reader: ReadableStreamDefaultReader<Uint8Array> | null;
  public readableStream: ReadableStream<Uint8Array> | null;
  public isConnected: boolean;
  private onDisconnectCallback?: () => void;
      private isReadingRegister: boolean = false;
  private pendingReadResolve: ((val: number | null) => void) | null = null;

  constructor() {
    this.port = null;
    this.reader = null;
    this.readableStream = null;
    this.isConnected = false;
  }

  /**
   * Подписка на событие обрыва связи (вызывается при release()).
   */
  public onDisconnect(cb: () => void): void {
    this.onDisconnectCallback = cb;
  }

  /**
   * Информация об устройстве (VID/PID) для определения чипа.
   */
  public getPortInfo(): SerialPortInfo {
    if (this.port && typeof this.port.getInfo === 'function') {
      return this.port.getInfo();
    }
    return {};
  }

  /**
   * Запрос разрешения у пользователя и открытие физического COM-порта.
   */
   public async connect(baudRate: number = 115200): Promise<void> {
    const serialApi = navigator.serial;
    if (!serialApi) {
      throw new Error(
        "Ваш браузер не поддерживает Web Serial API. Используйте Chrome или Edge."
      );
    }
    try {
      let port: WebSerialPort | null = null;
      
      // Пробуем получить ранее разрешённый порт (без диалога)
      try {
        const ports = await serialApi.getPorts();
        if (ports.length > 0) {
          port = ports[0]; // Берём первый запомненный порт
          console.log('[Serial] Используем запомненный порт (без диалога).');
        }
      } catch (err) {
        console.warn('[Serial] Не удалось получить список запомненных портов:', err);
      }
      
      // Если запомненного порта нет — запрашиваем через диалог
      if (!port) {
        console.log('[Serial] Запомненный порт не найден, показываю диалог выбора.');
        port = await serialApi.requestPort();
        if (!port) {
          throw new Error("Порт не выбран.");
        }
      }
      
      await port.open({ baudRate });
      const readable = port.readable;
      if (readable) {
        this.readableStream = readable;
        this.reader = readable.getReader();
      } else {
        this.readableStream = null;
        this.reader = null;
      }
      this.port = port;
      this.isConnected = true;
      console.log(`[Serial] Порт успешно открыт на скорости ${baudRate} бод.`);
    } catch (error: unknown) {
      this.isConnected = false;
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Serial] Ошибка открытия порта:", message);
      throw error;
    }
  }

  /**
   * Асинхронное чтение очередной порции сырых байт из буфера.
   */
     public async readChunk(): Promise<Uint8Array | null> {
        const reader = this.reader;
        if (!this.isConnected || !reader) {
            return null;
        }
        try {
            const { value, done } = await reader.read();
            if (done) {
                if (!this.isReadingRegister) {
                    this.release();
                }
                return null;
            }
            return value ?? null;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("[Serial] Ошибка критического чтения из порта:", message);
            if (!this.isReadingRegister) {
                this.release();
            }
            throw error;
        }
    }

      /**
     * Читает один регистр (для RMW битовых параметров).
     * Возвращает Promise, который разрешится, когда придёт ответ.
     */
       /**
     * Читает один регистр (для RMW битовых параметров).
     * Временно освобождает основной reader, создает временный для чтения ответа, затем возвращает основной.
     */
        /**
     * Читает один регистр (для RMW битовых параметров).
     */
    public async readRegister(slaveId: number, address: number): Promise<number | null> {
        // Сохраняем ссылку на порт ДО любых операций
        const port = this.port;
        if (!this.isConnected || !port || !port.writable || !port.readable) {
            console.warn('[SerialConnection] Cannot read: not connected or port unavailable.');
            return null;
        }

        this.isReadingRegister = true;

        // Формируем запрос Modbus FC 0x03 на 1 регистр
        const frame = new Uint8Array(8);
        frame[0] = slaveId;
        frame[1] = 0x03;
        frame[2] = (address >> 8) & 0xFF;
        frame[3] = address & 0xFF;
        frame[4] = 0x00;
        frame[5] = 0x01;

        let crc = 0xFFFF;
        for (let pos = 0; pos < 6; pos++) {
            crc ^= frame[pos];
            for (let i = 8; i !== 0; i--) {
                if ((crc & 0x0001) !== 0) { crc >>= 1; crc ^= 0xA001; }
                else { crc >>= 1; }
            }
        }
        frame[6] = crc & 0xFF;
        frame[7] = (crc >> 8) & 0xFF;

        try {
            // 1. Освобождаем текущий reader
            await this.unlockReader();

            // 2. Восстанавливаем port если release() его обнулил
            if (!this.port) {
                this.port = port;
                this.isConnected = true;
            }

            // 3. Создаем временный reader через сохранённую ссылку
            const tempReader = port.readable.getReader();

            // 4. Отправляем запрос
            const writer = port.writable.getWriter();
            await writer.write(frame);
            writer.releaseLock();

            // 5. Читаем ответ
            let buffer: number[] = [];
            const startTime = Date.now();
            while (Date.now() - startTime < 500) {
                const { value, done } = await tempReader.read();
                if (done) break;
                if (value) {
                    for (let i = 0; i < value.length; i++) {
                        buffer.push(value[i]);
                    }
                }

                if (buffer.length >= 5 && buffer[1] === 0x03) {
                    const byteCount = buffer[2];
                    const expectedLength = 3 + byteCount + 2;
                    if (buffer.length >= expectedLength) {
                        const val = (buffer[3] << 8) | buffer[4];
                        tempReader.releaseLock();
                        await this.lockReader();
                        this.isReadingRegister = false;
                        return val;
                    }
                }
            }

            tempReader.releaseLock();
            await this.lockReader();
            console.warn('[SerialConnection] readRegister: таймаут или неполный ответ');
            this.isReadingRegister = false;
            return null;
        } catch (err) {
            console.error('[SerialConnection] readRegister error:', err);
            try {
                if (!this.port) {
                    this.port = port;
                    this.isConnected = true;
                }
                await this.lockReader();
            } catch (e) {
                console.error('[SerialConnection] Failed to lock reader after error:', e);
            }
            this.isReadingRegister = false;
            return null;
        }
    }
    /**
     * Разрешает ожидающий запрос на чтение (вызывается из readLoop).
     */
    public resolvePendingRead(value: number): void {
        if (this.pendingReadResolve) {
            this.pendingReadResolve(value);
            this.pendingReadResolve = null;
        }
    }

    private buildReadRequest(slaveAddr: number, startAddr: number, count: number): Uint8Array {
        const frame = new Uint8Array(8);
        frame[0] = slaveAddr;
        frame[1] = 0x03;
        frame[2] = (startAddr >> 8) & 0xFF;
        frame[3] = startAddr & 0xFF;
        frame[4] = (count >> 8) & 0xFF;
        frame[5] = count & 0xFF;
        const crc = this.calculateCRC(frame, 6);
        frame[6] = crc & 0xFF;
        frame[7] = (crc >> 8) & 0xFF;
        return frame;
    }

    private calculateCRC(buffer: Uint8Array, length: number): number {
        let crc = 0xFFFF;
        for (let pos = 0; pos < length; pos++) {
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
   * Смена скорости уже открытого порта без переоткрытия.
   * Используется командной строкой для автономного выбора BPS.
   * Если порт не открыт — игнорируем (скорость подставится при connect).
   */
  public async updateBaudRate(baudRate: number): Promise<void> {
    const port = this.port;
    if (!this.isConnected || !port) {
      return;
    }
    try {
      // Web Serial API: port.update() меняет параметры на лету
      await (port as unknown as { update: (opts: { baudRate: number }) => Promise<void> }).update({ baudRate });
      console.log(`[Serial] Скорость порта изменена на ${baudRate} бод.`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Serial] Не удалось сменить скорость порта:", message);
    }
  }

  /**
   * Отправка массива байт в устройство.
   */
  public async write(data: Uint8Array): Promise<void> {
    const port = this.port;
    if (!this.isConnected || !port || !port.writable) {
      return;
    }
    const writer = port.writable.getWriter();
    await writer.write(data);
    writer.releaseLock();
  }

      /**
     * Читает один регистр (для RMW битовых параметров).
     * Временно освобождает reader, чтобы перехватить ответ, затем возвращает его.
     */

  /**
   * Освобождает reader без закрытия порта.
   */
  public async unlockReader(): Promise<void> {
    const reader = this.reader;
    if (!reader) {
      return;
    }
    try {
      await reader.cancel();
      reader.releaseLock();
    } catch {
      // ignore
    }
    this.reader = null;
  }

  /**
   * Возвращает reader себе.
   */
  public async lockReader(): Promise<void> {
    const port = this.port;
    if (!port || !port.readable) {
      this.readableStream = null;
      this.reader = null;
      return;
    }
    const readable = port.readable;
    this.readableStream = readable;
    this.reader = readable.getReader();
  }

  /**
   * Корректное освобождение ресурсов.
   */
 public release(): void {
    const wasConnected = this.isConnected;
    this.isConnected = false;
    
    const reader = this.reader;
    if (reader) {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
    this.reader = null;
    this.readableStream = null;

    // Закрываем сам порт Web Serial API, чтобы освободить его для других приложений
    if (this.port) {
      try {
        void this.port.close();
      } catch (err) {
        console.warn('[Serial] Ошибка при закрытии порта:', err);
      }
      this.port = null;
    }

    if (wasConnected && this.onDisconnectCallback) {
      this.onDisconnectCallback();
    }
}
}