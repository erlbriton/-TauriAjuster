// src/serial/ip-utils.ts

/**
 * Преобразует строку IP-адреса в массив из двух 16-битных регистров.
 * Возвращает регистры в порядке для контроллера (младшее слово первым).
 * 
 * Поддерживает форматы:
 * - "192.168.1.10" (десятичный)
 * - "xC0A8010A" или "0xC0A8010A" (шестнадцатеричный)
 * 
 * @returns [lowWord, highWord] или null при неверном формате
 */
export function parseIpToRegisters(ipString: string): [number, number] | null {
  const trimmed = ipString.trim();
  let value: number | null = null;

  // 1. HEX формат (8 hex-символов с префиксом x или 0x)
  if (/^0?x[0-9a-fA-F]{8}$/i.test(trimmed)) {
    const hexPart = trimmed.replace(/^0?x/i, '');
    value = parseInt(hexPart, 16);
  } 
  // 2. Decimal формат (4 октета через точки)
  else if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) {
    const parts = trimmed.split('.').map(Number);
    if (parts.length === 4 && parts.every(p => p >= 0 && p <= 255)) {
      value = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
      value = value >>> 0; // Беззнаковое 32-битное
    }
  }

  if (value === null || value < 0 || value > 0xFFFFFFFF) {
    return null;
  }

  // Разбиваем на два 16-битных слова (Big-Endian порядок байтов)
  const highWord = (value >> 16) & 0xFFFF;
  const lowWord = value & 0xFFFF;

  // Возвращаем в порядке Little-Endian регистров (младшее слово первым)
  return [lowWord, highWord];
}