// src/core/platform/fs.ts
// Платформенно-независимый контракт файловой системы.

export interface SelectedFile {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly lastModified: number;
  readonly content: string;
}

export interface FileFilter {
  readonly name: string;
  readonly extensions: string[];
}

export interface IFileSystem {
  selectFiles(options?: {
    multiple?: boolean;
    filters?: FileFilter[];
  }): Promise<SelectedFile[]>;

  selectDirectory(): Promise<SelectedFile[] | null>;

  readTextFile(path: string): Promise<string>;

  writeTextFile(path: string, content: string): Promise<void>;
}

export interface ISerialPortPlatform {
  readonly isConnected: boolean;
  connect(baudRate?: number): Promise<void>;
  readChunk(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  getPortInfo(): { usbVendorId?: number; usbProductId?: number };
  onDisconnect(cb: () => void): void;
  release(): void;
}

/**
 * Контракт сохранения файлов (CSV, INI, REC).
 * Браузер:  Blob + URL.createObjectURL + <a download>
 *           или showSaveFilePicker (диалог "Сохранить как")
 * Нативный: диалог сохранения через FS-плагин
 */
export interface IFileSaver {
  saveTextFile(filename: string, content: string, mimeType?: string): Promise<void>;
  saveBinaryFile(filename: string, data: Uint8Array, mimeType?: string): Promise<void>;
}