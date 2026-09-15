// src/comm/Modbus.ts

export class Modbus {
    /**
     * Calculates Modbus RTU CRC16 (Polynomial 0xA001)
     */
    public static calculateCRC(buffer: Uint8Array, length?: number): number {
        let crc = 0xFFFF;
        const len = length !== undefined ? length : buffer.length;

        for (let pos = 0; pos < len; pos++) {
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
     * Builds a Modbus RTU Read Request frame (FC 03 or FC 04)
     */
    public static createReadRequest(slaveAddr: number, functionCode: number, startAddr: number, count: number): Uint8Array {
        const frame = new Uint8Array(8);
        frame[0] = slaveAddr;
        frame[1] = functionCode; // 3 or 4
        frame[2] = (startAddr >> 8) & 0xFF;
        frame[3] = startAddr & 0xFF;
        frame[4] = (count >> 8) & 0xFF;
        frame[5] = count & 0xFF;

        const crc = this.calculateCRC(frame, 6);
        frame[6] = crc & 0xFF;        // Low byte
        frame[7] = (crc >> 8) & 0xFF; // High byte

        return frame;
    }

    /**
     * Parses a Modbus RTU Read Response frame
     */
    public static parseReadResponse(buffer: Uint8Array): { slaveAddr: number; functionCode: number; registers: number[] } | null {
        if (buffer.length < 5) return null;

        const slaveAddr = buffer[0];
        const functionCode = buffer[1];
        const byteCount = buffer[2];

        if (buffer.length < 3 + byteCount + 2) return null; // Frame incomplete

        // Verify CRC
        const receivedCRC = buffer[3 + byteCount] | (buffer[3 + byteCount + 1] << 8);
        const calculatedCRC = this.calculateCRC(buffer, 3 + byteCount);

        if (receivedCRC !== calculatedCRC) {
            console.warn('Modbus CRC check failed!');
            return null;
        }

        const registers: number[] = [];
        for (let i = 0; i < byteCount; i += 2) {
            const high = buffer[3 + i];
            const low = buffer[3 + i + 1];
            // 16-bit unsigned integer (0..65535)
            const raw = ((high & 0xFF) << 8) | (low & 0xFF);
            registers.push(raw);
        }

        return { slaveAddr, functionCode, registers };
    }
}
