// src/serial/serial-manager.ts
// Центральный менеджер последовательного порта (архитектура «единый читатель»).
//
// Единственное место, где читается порт. Все транзакции (Modbus, ID-запрос,
// запись/чтение регистров) выполняются через serialManager.executeTransaction.
// Это исключает конфликты чтения из порта разными частями приложения.

import type { ISerialPort } from './ISerialPort.js';

/** Колбэк для одного принятого «куска» данных из порта. */
type ChunkHandler = (chunk: Uint8Array) => void;

/** Функция проверки: получен ли полный ответ на транзакцию. */
export type CheckCompleteFn = (buffer: Uint8Array) => boolean;

// === ЦЕНТРАЛЬНЫЙ МЕНЕДЖЕР ПОРТА (АРХИТЕКТУРА «ЕДИНЫЙ ЧИТАТЕЛЬ») ===
export class SerialManager {
    public serial: ISerialPort | null;
    public readerPromise: Promise<void> | null;
    public currentHandler: ChunkHandler | null;
    private lock: Promise<void>;

    constructor() {
        this.serial = null;
        this.readerPromise = null;
        this.currentHandler = null;
        this.lock = Promise.resolve();
    }

    public init(serial: ISerialPort): void {
        this.serial = serial;
        this.startReader();
    }

    public startReader(): void {
        if (this.readerPromise || !this.serial || !this.serial.isConnected) return;
        this.readerPromise = (async () => {
            console.log("[SerialManager] Центральный единый ридер успешно запущен.");
            while (this.serial && this.serial.isConnected) {
                try {
                    const chunk: Uint8Array | null = await this.serial.readChunk();
                    if (chunk && chunk.length > 0) {
                        if (this.currentHandler) {
                            this.currentHandler(chunk);
                        }
                    } else {
                        await new Promise((r) => setTimeout(r, 5));
                    }
                } catch (e) {
                    console.error("[SerialManager] Критическая ошибка в едином ридере:", e);
                    break;
                }
            }
            this.readerPromise = null;
            console.log("[SerialManager] Центральный единый ридер остановлен.");
        })();
    }

    public async executeTransaction(
        packet: Uint8Array,
        checkCompleteFn: CheckCompleteFn,
        timeoutMs: number = 1000
    ): Promise<Uint8Array> {
        const oldLock = this.lock;
        let release: () => void = () => { };
        this.lock = new Promise((r) => { release = r; });
        await oldLock;
        try {
            this.startReader();
            const port = this.serial;
            if (!port) {
                throw new Error("[SerialManager] Порт не инициализирован для транзакции.");
            }
            await port.write(packet);
            return await new Promise<Uint8Array>((resolve) => {
                let buffer = new Uint8Array(0);
                let timeoutId: ReturnType<typeof setTimeout> | null = null;
                const cleanUp = () => {
                    if (timeoutId) clearTimeout(timeoutId);
                    if (this.currentHandler === handleChunk) {
                        this.currentHandler = null;
                    }
                };
                const handleChunk: ChunkHandler = (chunk: Uint8Array) => {
                    let newBuffer = new Uint8Array(buffer.length + chunk.length);
                    newBuffer.set(buffer);
                    newBuffer.set(chunk, buffer.length);
                    buffer = newBuffer;
                    if (checkCompleteFn(buffer)) {
                        cleanUp();
                        resolve(buffer);
                    }
                };
                this.currentHandler = handleChunk;
                timeoutId = setTimeout(() => {
                    cleanUp();
                    resolve(buffer);
                }, timeoutMs);
            });
        } catch (err) {
            console.error("[SerialManager] Ошибка транзакции:", err);
            throw err;
        } finally {
            release();
        }
    }
}

export const serialManager = new SerialManager();