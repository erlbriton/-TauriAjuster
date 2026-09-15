// src/oscilloscope/comm/Serial.ts

import { Channel } from '../core/Channel';
import { Archive } from '../core/Archive';
import { Modbus } from './Modbus';
import type { WebSerialPort } from '../../serial/web-serial-types.js';
import { buildWriteMultipleRegistersRequest } from '../../serial/modbus.js';

export type SerialState = 'disconnected' | 'connecting' | 'connected' | 'error';

export class Serial {
    private state: SerialState = 'disconnected';
    private port: WebSerialPort | null = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private baudRate: number = 115200;
    private archive: Archive;
    private channels: Channel[] = [];
    private stateChangeCallbacks: ((state: SerialState, msg?: string) => void)[] = [];

    private rxBuffer: number[] = [];
    private asciiTextBuffer: string = '';
    private pollIntervalId: number | null = null;
    private lastResponseTime: number = 0;
    private hasReceivedData: boolean = false;
    private readonly TIMEOUT_MS: number = 2000;
    private pendingReadResolve: ((val: number | null) => void) | null = null;
    
    private isPaused: boolean = false;

    constructor(archive: Archive) {
        this.archive = archive;
    }

    public setChannels(channels: Channel[]): void {
        this.channels = Array.isArray(channels) ? channels : [];
    }

    public getChannels(): Channel[] {
        return this.channels;
    }

    public onStateChange(cb: (state: SerialState, msg?: string) => void): void {
        this.stateChangeCallbacks.push(cb);
    }

    private setState(state: SerialState, msg?: string): void {
        this.state = state;
        this.stateChangeCallbacks.forEach(cb => cb(state, msg));
    }

    public getState(): SerialState {
        return this.state;
    }

    public isWebSerialSupported(): boolean {
        return 'serial' in navigator;
    }

    public async connect(baudRate: number = 115200): Promise<boolean> {
        this.baudRate = baudRate;

        if (!this.isWebSerialSupported()) {
            this.setState('disconnected', 'Web Serial API не поддерживается.');
            return false;
        }

        const navSerial = navigator.serial;
        if (!navSerial) {
            this.setState('disconnected', 'Web Serial API не поддерживается.');
            return false;
        }

        try {
            this.setState('connecting', 'Выбор COM-порта...');

            const port = await navSerial.requestPort();
            this.port = port;

            await port.open({ baudRate: this.baudRate });

            this.setState('connected', `Подключено @ ${this.baudRate} baud`);
            this.lastResponseTime = Date.now();
            this.hasReceivedData = false;

            this.startReading();
            this.startModbusPolling();

            return true;
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : 'Отменено';
            this.setState('disconnected', `COM-порт не подключен (${errMsg}).`);
            return false;
        }
    }

    public attachPort(port: WebSerialPort): void {
        this.port = port;
        this.setState('connected', 'Порт подключен из внешнего проекта.');
        this.lastResponseTime = Date.now();
        this.hasReceivedData = false;

        this.startReading();
        this.startModbusPolling();
    }

    public async disconnect(): Promise<void> {
        this.stopModbusPolling();

        try {
            const reader = this.reader;
            if (reader) {
                await reader.cancel();
                reader.releaseLock();
                this.reader = null;
            }

            const port = this.port;
            if (port) {
                await port.close();
                this.port = null;
            }
        } catch (e: unknown) {
            console.error('Error closing serial port:', e);
        }

        this.setState('disconnected', 'Serial port disconnected.');
        this.hasReceivedData = false;
    }

       public pausePolling(): void {
        console.log('[Serial] pausePolling ВЫЗВАН. isPaused был:', this.isPaused, ', pollIntervalId:', this.pollIntervalId);
        this.isPaused = true;
        this.stopModbusPolling();
        console.log('[Serial] pausePolling ОТРАБОТАЛ. isPaused стал:', this.isPaused, ', pollIntervalId:', this.pollIntervalId);
    }

    public resumePolling(): void {
        this.isPaused = false;
        if (this.state === 'connected') {
            this.startModbusPolling();
            console.log('[Serial] Polling resumed.');
        }
    }

    public isPollingPaused(): boolean {
        return this.isPaused;
    }

         private startModbusPolling(): void {//////////////////////////////////////
        console.log('[Serial] startModbusPolling ВЫЗВАН. Стек:');
        console.trace();
        this.stopModbusPolling();

        this.pollIntervalId = window.setInterval(() => {
            // Добавлено условие !this.isPaused для реальной остановки опроса
            if (this.state === 'connected' && !this.isPaused) {
                if (this.hasReceivedData && (Date.now() - this.lastResponseTime > this.TIMEOUT_MS)) {
                    this.setState('error', 'Связь потеряна: тайм-аут ответа.');
                    this.disconnect();
                    return;
                }

                              if (this.channels.length > 0) {
                    console.log('[Serial] Отправка Modbus запроса. isPaused:', this.isPaused);
                    this.sendModbus03Request();
                }
            }
        }, 100);
    }

       private stopModbusPolling(): void {
        console.log('[Serial] stopModbusPolling ВЫЗВАН. pollIntervalId:', this.pollIntervalId);
        if (this.pollIntervalId !== null) {
            clearInterval(this.pollIntervalId);
            this.pollIntervalId = null;
            console.log('[Serial] Интервал остановлен.');
        }
    }

        private async sendModbus03Request(slaveAddr: number = 1): Promise<void> {
        console.trace('[Serial] sendModbus03Request вызван. Стек вызовов:');
        const port = this.port;
        if (!port || !port.writable || this.state !== 'connected') {
            return;
        }

        let maxReg = 10;

        this.channels.forEach(ch => {
            if (!ch.modbusReg) return;

            const match = ch.modbusReg.match(/r([0-9a-fA-F]+)/i);
            if (!match) return;

            const regIdx = parseInt(match[1], 16);

            const typeUpper = (ch.dataType || '').toUpperCase();
            const is32Bit =
                typeUpper === 'TFLOAT' ||
                typeUpper === 'TFLOAT32' ||
                typeUpper === 'FLOAT' ||
                typeUpper === 'TDWORD' ||
                typeUpper === 'TLONG' ||
                typeUpper === 'TINT32';

            const count = is32Bit ? 2 : 1;

            if (!isNaN(regIdx) && regIdx + count > maxReg) {
                maxReg = regIdx + count;
            }
        });

        maxReg = Math.min(125, maxReg);

        try {
            const writer = port.writable.getWriter();
            const frame = Modbus.createReadRequest(slaveAddr, 0x03, 0, maxReg);

            await writer.write(frame);
            writer.releaseLock();
        } catch (err) {
            console.error('Failed to send Modbus 0x03 request frame:', err);
        }
    }

    private async startReading(): Promise<void> {
        const port = this.port;
        if (!port || !port.readable) return;

        try {
            while (port.readable && this.state === 'connected') {
                const reader = port.readable.getReader();
                this.reader = reader;

                try {
                    while (true) {
                        const { value, done } = await reader.read();

                        if (done) break;

                        if (value) {
                            this.processIncomingBytes(value);
                        }
                    }
                } catch (readErr) {
                    console.error('Serial stream read error:', readErr);
                } finally {
                    reader.releaseLock();
                    this.reader = null;
                }
            }
        } catch (err) {
            console.error('Port reading loop failed:', err);
            this.setState('error', 'Serial communication error');
        }
    }

    public async readRegister(slaveId: number, address: number): Promise<number | null> {
        const port = this.port;
        
        console.log('[Serial] readRegister check:', {
            hasPort: !!port,
            hasWritable: !!port?.writable,
            state: this.state,
            portType: port?.constructor?.name || 'unknown'
        });
        
        if (!port) {
            console.warn('[Serial] Cannot read: port is null.');
            return null;
        }
        if (!port.writable) {
            console.warn('[Serial] Cannot read: port.writable is null.');
            return null;
        }
        if (this.state !== 'connected') {
            console.warn(`[Serial] Cannot read: state is "${this.state}", expected "connected".`);
            return null;
        }

        const promise = new Promise<number | null>(resolve => {
            this.pendingReadResolve = resolve;
            setTimeout(() => {
                if (this.pendingReadResolve) {
                    this.pendingReadResolve(null);
                    this.pendingReadResolve = null;
                }
            }, 1000);
        });

        try {
            const writer = port.writable.getWriter();
            const frame = Modbus.createReadRequest(slaveId, 0x03, address, 1);
            await writer.write(frame);
            writer.releaseLock();
        } catch (err: unknown) {
            console.error('[Serial] Failed to send Modbus read request:', err);
            if (this.pendingReadResolve) {
                this.pendingReadResolve(null);
                this.pendingReadResolve = null;
            }
        }

        return promise;
    }

    public async writeRegister(slaveId: number, address: number, values: number[]): Promise<boolean> {
        const port = this.port;
        if (!port || !port.writable || this.state !== 'connected') {
            console.warn('[Serial] Cannot write: port not connected or not writable.');
            return false;
        }

        try {
            const writer = port.writable.getWriter();
            const frame = buildWriteMultipleRegistersRequest(slaveId, address, values);
            
            await writer.write(frame);
            writer.releaseLock();
            
            console.log(`[Serial] Modbus 0x10 write sent: addr=${address}, values=${values}`);
            return true;
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[Serial] Failed to send Modbus 0x10 write request:', errMsg);
            return false;
        }
    }

    private processIncomingBytes(data: Uint8Array): void {
        const now = Date.now();

        this.lastResponseTime = now;
        this.hasReceivedData = true;

        const textChunk = new TextDecoder().decode(data);
        this.asciiTextBuffer += textChunk;

        if (this.asciiTextBuffer.includes('\n')) {
            const lines = this.asciiTextBuffer.split('\n');
            this.asciiTextBuffer = lines.pop() || '';

            for (const line of lines) {
                const matches = line.trim().match(/-?\d+(?:\.\d+)?/g);

                if (matches) {
                    matches.forEach((strVal, idx) => {
                        const val = parseFloat(strVal);

                       if (!isNaN(val) && idx < this.channels.length) {
                            const ch = this.channels[idx];
                            ch.updateRawValue(val);
                            this.archive.addSample(ch.id, now, ch.scaledValue, ch.rawDecValue);
                        }
                    });
                }
            }
        }

        for (let i = 0; i < data.length; i++) {
            this.rxBuffer.push(data[i]);
        }

        if (this.rxBuffer.length >= 5) {
            const modbusRes = Modbus.parseReadResponse(new Uint8Array(this.rxBuffer));

            if (modbusRes && (modbusRes.functionCode === 0x03 || modbusRes.functionCode === 0x04)) {
                if (this.pendingReadResolve && modbusRes.registers.length >= 1) {
                    this.pendingReadResolve(modbusRes.registers[0]);
                    this.pendingReadResolve = null;
                } else {
                    this.channels.forEach((ch, idx) => {
                        let val: number | null = null;

                        if (ch.modbusReg) {
                            const bitMatch = ch.modbusReg.match(/r([0-9a-fA-F]+)\.([0-9a-fA-F]+)/i);
                            const regMatch = ch.modbusReg.match(/r([0-9a-fA-F]+)/i);

                            if (bitMatch) {
                                const regIdx = parseInt(bitMatch[1], 16);
                                const bitIdx = parseInt(bitMatch[2], 16);

                                if (regIdx < modbusRes.registers.length) {
                                    val = (modbusRes.registers[regIdx] >>> bitIdx) & 1;
                                }
                            } else if (regMatch) {
                                const regIdx = parseInt(regMatch[1], 16);
                                const typeUpper = (ch.dataType || '').toUpperCase();

                                if (
                                    typeUpper === 'TFLOAT' ||
                                    typeUpper === 'TFLOAT32' ||
                                    typeUpper === 'FLOAT' ||
                                    typeUpper === 'REAL'
                                ) {
                                    if (regIdx + 1 < modbusRes.registers.length) {
                                        const w1 = modbusRes.registers[regIdx] & 0xFFFF;
                                        const w2 = modbusRes.registers[regIdx + 1] & 0xFFFF;

                                        const buf = new ArrayBuffer(4);
                                        const view = new DataView(buf);

                                        view.setUint16(0, w1, false);
                                        view.setUint16(2, w2, false);

                                        const fVal = view.getFloat32(0, false);
                                        val = isNaN(fVal) || !isFinite(fVal) ? 0 : fVal;
                                    }
                                } else if (
                                    typeUpper === 'TDWORD' ||
                                    typeUpper === 'TLONG' ||
                                    typeUpper === 'TINT32'
                                ) {
                                    if (regIdx + 1 < modbusRes.registers.length) {
                                        const w1 = modbusRes.registers[regIdx] & 0xFFFF;
                                        const w2 = modbusRes.registers[regIdx + 1] & 0xFFFF;

                                        val = (w1 << 16) | w2;
                                    }
                                } else if (
                                    typeUpper === 'TSHORT' ||
                                    typeUpper === 'TINT16' ||
                                    typeUpper === 'TINTEGER' ||
                                    typeUpper === 'INT'
                                ) {
                                    if (regIdx < modbusRes.registers.length) {
                                        let s16 = modbusRes.registers[regIdx] & 0xFFFF;

                                        if (s16 & 0x8000) {
                                            s16 -= 0x10000;
                                        }

                                        val = s16;
                                    }
                                } else {
                                    if (regIdx < modbusRes.registers.length) {
                                        val = modbusRes.registers[regIdx] & 0xFFFF;
                                    }
                                }
                            }
                        }

                        if (val === null && idx < modbusRes.registers.length) {
                            val = modbusRes.registers[idx] & 0xFFFF;
                        }

                        if (val !== null) {
                            ch.updateRawValue(val);
                            this.archive.addSample(ch.id, now, ch.scaledValue, ch.rawDecValue);
                        }
                    });
                }

                this.rxBuffer = [];
            }
        }

        if (this.rxBuffer.length > 512) {
            this.rxBuffer = this.rxBuffer.slice(-256);
        }
    }
}