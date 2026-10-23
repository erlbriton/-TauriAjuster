// src/oscilloscope/scope/OscilloscopeCommands.ts
// Обработка команд записи в регистры Modbus.

import { parseModbusReg } from "../core/Channel.js";
import { buildWriteMultipleRegistersRequest } from "../../serial/modbus.js";
import type { Channel } from "../core/Channel";
import type { BottomPanels } from "../ui/BottomPanels";
import { parseIpToRegisters } from "../../serial/ip-utils.js";
import { serialManager } from "../../serial/serial-manager.js";
import { calculateCRC } from "../../serial/modbus-crc.js";
import type { CheckCompleteFn } from "../../serial/serial-manager.js";

/** Зависимости для обработки команд */
export interface CommandContext {
  selectedChannel: Channel | null;
  externalSerial: { write(data: Uint8Array): Promise<void> } | null;
  slaveAddress: number;
  bottomPanels: BottomPanels;
}

/**
 * Обрабатывает команду записи значения в регистр.
 * Вызывается при отправке команды из нижней панели.
 */
export async function handleCommandSubmit(
  ctx: CommandContext,
  text: string,
): Promise<void> {
  const ch = ctx.selectedChannel;
  if (!ch || !ch.modbusReg) {
    console.warn("[Oscilloscope] No channel selected or missing modbusReg.");
    return;
  }

  const parsedReg = parseModbusReg(ch.modbusReg);
  if (!parsedReg) {
    console.warn(`[Oscilloscope] Invalid modbusReg format: ${ch.modbusReg}`);
    return;
  }

  if (!ctx.externalSerial) {
    console.warn(
      "[Oscilloscope] No external serial port attached for write.",
    );
    return;
  }

  const parts = text.split("=");
  if (parts.length < 2) {
    console.warn('[Oscilloscope] No "=" found in command.');
    return;
  }

  const valueStr = parts.slice(1).join("=").trim();

  let valueToWrite: number;
  if (valueStr.toLowerCase().startsWith("x")) {
    valueToWrite = parseInt(valueStr.substring(1), 16);
  } else {
    valueToWrite = parseInt(valueStr, 10);
  }

  if (isNaN(valueToWrite)) {
    console.warn("[Oscilloscope] Invalid number format.");
    return;
  }

  if (parsedReg.bit !== null) {
    // Формируем запрос чтения одного holding-регистра (FC 0x03)
    const readFrame = new Uint8Array(8);
    readFrame[0] = ctx.slaveAddress & 0xFF;
    readFrame[1] = 0x03;
    readFrame[2] = (parsedReg.address >> 8) & 0xFF;
    readFrame[3] = parsedReg.address & 0xFF;
    readFrame[4] = 0x00;
    readFrame[5] = 0x01;
    const readCrc = calculateCRC(readFrame.subarray(0, 6));
    readFrame[6] = readCrc & 0xFF;
    readFrame[7] = (readCrc >> 8) & 0xFF;

    // Ответ FC 0x03 на 1 регистр: [slave, 0x03, 0x02, dataHi, dataLo, crcLo, crcHi]
    const checkReadComplete: CheckCompleteFn = (buf: Uint8Array) => {
      if (buf.length < 3) return false;
      if (buf[1] === 0x83) return true; // exception
      const byteCount = buf[2];
      return buf.length >= 3 + byteCount + 2;
    };

    let reply: Uint8Array;
    try {
      reply = await serialManager.executeTransaction(readFrame, checkReadComplete, 500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Oscilloscope] Failed to read register for RMW:", msg);
      return;
    }

    if (!reply || reply.length < 5 || reply[1] !== 0x03) {
      console.error("[Oscilloscope] Invalid read reply for RMW.");
      return;
    }

    const currentVal = (reply[3] << 8) | reply[4];

    let newVal = currentVal;
    if (valueToWrite !== 0) {
      newVal |= 1 << parsedReg.bit;
    } else {
      newVal &= ~(1 << parsedReg.bit);
    }

    console.log(
      `[Oscilloscope] Bit RMW: addr=${parsedReg.address}, bit=${parsedReg.bit}, old=${currentVal}, new=${newVal}`,
    );

    const packet = buildWriteMultipleRegistersRequest(
      ctx.slaveAddress,
      parsedReg.address,
      [newVal],
    );
    const hexDump = Array.from(packet)
      .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
      .join(" ");
    console.log(`[Oscilloscope] Bit RMW packet HEX: ${hexDump}`);

    await ctx.externalSerial.write(packet);
    console.log("[Oscilloscope] Bit RMW write sent successfully.");

    ctx.bottomPanels.focusCommand();
    return;
  }

    const typeUpper = (ch.dataType || "").toUpperCase();
  
  // === ОБРАБОТКА IP-АДРЕСОВ (TIPADDR) ===
  if (typeUpper === 'TIPADDR') {
    const registers = parseIpToRegisters(valueStr);
    
    if (!registers) {
      alert('Неверный формат IP-адреса');
      ctx.bottomPanels.focusCommand();
      return;
    }

    try {
      const packet = buildWriteMultipleRegistersRequest(
        ctx.slaveAddress,
        parsedReg.address,
        registers, // [lowWord, highWord]
      );
      const hexDump = Array.from(packet)
        .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
        .join(" ");
      console.log(`[Oscilloscope] IP write packet HEX (${packet.length} bytes): ${hexDump}`);
      await ctx.externalSerial.write(packet);
      console.log("[Oscilloscope] IP write packet sent successfully.");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[Oscilloscope] Failed to send IP write packet:", errMsg);
    }

    ctx.bottomPanels.focusCommand();
    return;
  }
  
  // === СУЩЕСТВУЮЩАЯ ЛОГИКА ДЛЯ 32-БИТНЫХ И 16-БИТНЫХ ЗНАЧЕНИЙ ===
  const is32Bit =
    typeUpper.includes("FLOAT") ||
    typeUpper.includes("DWORD") ||
    typeUpper.includes("LONG") ||
    typeUpper.includes("INT32");

  let values: number[];
  if (is32Bit) {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);

    if (typeUpper.includes("FLOAT")) {
      view.setFloat32(0, valueToWrite, false);
    } else {
      view.setUint32(0, valueToWrite, false);
    }

    const reg1 = view.getUint16(0, false);
    const reg2 = view.getUint16(2, false);
    values = [reg2, reg1];

    console.log(
      `[Oscilloscope] 32-bit write: addr=${parsedReg.address}, val=${valueToWrite}, regs=[${reg1}, ${reg2}]`,
    );
  } else {
    const val16 = valueToWrite & 0xffff;
    values = [val16];
    console.log(
      `[Oscilloscope] 16-bit write: addr=${parsedReg.address}, val=${val16}`,
    );
  }

  try {
    const packet = buildWriteMultipleRegistersRequest(
      ctx.slaveAddress,
      parsedReg.address,
      values,
    );
    const hexDump = Array.from(packet)
      .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
      .join(" ");
    console.log(`[Oscilloscope] Write packet HEX (${packet.length} bytes): ${hexDump}`);
    await ctx.externalSerial.write(packet);
    console.log("[Oscilloscope] Write packet sent successfully.");
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[Oscilloscope] Failed to send write packet:", errMsg);
  }

  ctx.bottomPanels.focusCommand();
}

/**
 * Выполняет 10 последовательных записей команды с интервалом 100 мс.
 * Используется для тестирования битовых параметров.
 */
export async function handleMultiplyCommand(
  ctx: CommandContext,
  submitFn: (text: string) => Promise<void>,
): Promise<void> {
  if (!ctx.selectedChannel) {
    console.warn("[Oscilloscope] x10: Нет выбранного канала.");
    return;
  }
  if (!ctx.externalSerial) {
    console.warn("[Oscilloscope] x10: Нет подключения к порту.");
    return;
  }
  const parsedReg = parseModbusReg(ctx.selectedChannel.modbusReg);
  if (!parsedReg || parsedReg.bit === null) {
    console.warn(
      "[Oscilloscope] x10: Выбранный параметр не является битовым.",
    );
    return;
  }

  const commandText = ctx.bottomPanels.getCommandText();
  console.log(
    `[Oscilloscope] x10: Запуск очереди из 10 записей (5 Гц) для "${commandText}"`,
  );

  for (let i = 0; i < 10; i++) {
    console.log(`[Oscilloscope] x10: запись ${i + 1}/10`);
    await submitFn(commandText);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log("[Oscilloscope] x10: Очередь записей завершена.");
}