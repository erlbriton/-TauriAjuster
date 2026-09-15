// src/serial/web-serial-types.ts
// Минимальные типы Web Serial API.
// lib.dom не содержит эти типы, объявляем их сами.
// Готово к Tauri: нативный адаптер реализует ISerialPort, а не WebSerialPort.

export interface WebSerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface WebSerialPortOpenOptions {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd';
  bufferSize?: number;
  flowControl?: 'none' | 'hardware';
}

export interface WebSerialPortRequestOptions {
  filters?: Array<{
    usbVendorId?: number;
    usbProductId?: number;
  }>;
}

export interface WebSerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): WebSerialPortInfo;
  open(options: WebSerialPortOpenOptions): Promise<void>;
  close(): Promise<void>;
}

export interface WebSerial extends EventTarget {
    // 1. Специфичные перегрузки (дают строгую типизацию и автодополнение для "connect" и "disconnect")
    addEventListener(
        type: "connect" | "disconnect",
        listener: (this: WebSerial, event: Event & { target: WebSerialPort }) => void,
        options?: boolean | AddEventListenerOptions
    ): void;

    removeEventListener(
        type: "connect" | "disconnect",
        listener: (this: WebSerial, event: Event & { target: WebSerialPort }) => void,
        options?: boolean | EventListenerOptions
    ): void;

    // 2. Базовые сигнатуры из EventTarget (ОБЯЗАТЕЛЬНЫ для устранения ошибки ts(2430))
    addEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
    ): void;

    removeEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions
    ): void;

    // 3. Основные методы Web Serial API
    requestPort(options?: PortFilter[]): Promise<WebSerialPort>;
    getPorts(): Promise<WebSerialPort[]>;
}

// Убедитесь, что у вас также объявлен интерфейс PortFilter (если его еще нет)
export interface PortFilter {
    usbVendorId?: number;
    usbProductId?: number;
}

declare global {
  interface Navigator {
    readonly serial?: WebSerial;
  }
}

// Экспорт для использования в других модулях без side-effects
export {};