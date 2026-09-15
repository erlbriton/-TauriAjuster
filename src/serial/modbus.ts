// src/serial/modbus.ts

export class ModbusParser {
    private buffer: Uint8Array;

    constructor() {
        this.buffer = new Uint8Array(0);
    }

    public appendData(chunk: Uint8Array): void {
        if (!chunk || chunk.length === 0) return;
        const newBuffer = new Uint8Array(this.buffer.length + chunk.length);
        newBuffer.set(this.buffer, 0);
        newBuffer.set(chunk, this.buffer.length);
        this.buffer = newBuffer;
    }

        public parsePacket(): number[] | null {
        const MIN_PACKET_LENGTH = 5;
        while (this.buffer.length >= MIN_PACKET_LENGTH) {
            // Проверяем только код функции (0x03 = Read Holding Registers),
            // адрес устройства (buffer[0]) не проверяем — принимаем ответ от любого адреса (1–247)
            if (this.buffer[1] === 0x03) {
                const bytesOfData = this.buffer[2]; 
                const fullPacketLength = 3 + bytesOfData + 2; 
                if (this.buffer.length < fullPacketLength) return null;
                const packet = this.buffer.subarray(0, fullPacketLength);
                const calculatedCrc = this.calculateCRC(packet.subarray(0, fullPacketLength - 2));
                const receivedCrc = (packet[fullPacketLength - 1] << 8) | packet[fullPacketLength - 2];
                if (calculatedCrc === receivedCrc) {
                    const results: number[] = [];
                    for (let i = 0; i < bytesOfData; i += 2) {
                        results.push((packet[3 + i] << 8) | packet[4 + i]);
                    }
                    this.buffer = this.buffer.subarray(fullPacketLength);
                    return results;
                }
            }
            this.buffer = this.buffer.subarray(1);
        }
        return null;
    }

    private calculateCRC(buffer: Uint8Array): number {
        let crc = 0xFFFF;
        for (let pos = 0; pos < buffer.length; pos++) {
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
}

/**
 * Собирает Modbus-запрос на запись нескольких регистров (Function 0x10).
 * @param slaveId Адрес устройства (например, 1)
 * @param startAddress Начальный адрес регистра (например, 1)
 * @param values Массив 16-битных значений для записи (Big-endian)
 * @returns Uint8Array готовый пакет для отправки
 */
export function buildWriteMultipleRegistersRequest(
    slaveId: number,
    startAddress: number,
    values: number[]
): Uint8Array {
    const byteCount = values.length * 2;
    const length = 1 + 1 + 2 + 2 + 1 + byteCount + 2; // slave + func + addr(2) + qty(2) + bytes + data + crc(2)
    const buffer = new Uint8Array(length);
    let offset = 0;

    buffer[offset++] = slaveId;
    buffer[offset++] = 0x10; // Function code: Write Multiple Registers
    buffer[offset++] = (startAddress >> 8) & 0xFF;
    buffer[offset++] = startAddress & 0xFF;
    buffer[offset++] = (values.length >> 8) & 0xFF;
    buffer[offset++] = values.length & 0xFF;
    buffer[offset++] = byteCount;

     for (const val of values) {
        // Big-endian: старший байт первым
        buffer[offset++] = (val >> 8) & 0xFF;
        buffer[offset++] = val & 0xFF;
    }

    // Вычисляем CRC для всего буфера, кроме последних 2 байт
    const crc = calculateModbusCRC(buffer.subarray(0, length - 2));
    // CRC в Modbus передаётся в Little-endian
    buffer[offset++] = crc & 0xFF;
    buffer[offset++] = (crc >> 8) & 0xFF;

    return buffer;
}

/**
 * Вычисляет CRC-16 (Modbus) для буфера.
 * Вынесена отдельно, чтобы её можно было использовать и для сборки, и для парсинга.
 */
export function calculateModbusCRC(buffer: Uint8Array): number {
    let crc = 0xFFFF;
    for (let pos = 0; pos < buffer.length; pos++) {
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
