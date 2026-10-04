// src/serial/ip-utils.ts

/**
 * Преобразует строку IP-адреса в массив из двух 16-битных регистров.
 * Возвращает регистры в порядке для контроллера: [младшее слово, старшее слово].
 *
 * Поддерживаемые форматы:
 * - десятичный:        "192.168.1.10"
 * - шестнадцатеричный: "xC0A8010A" или "0xC0A8010A"
 *
 * @returns [lowWord, highWord] или null, если формат неверный.
 */
export function parseIpToRegisters(ipString: string): [number, number] | null {
  const trimmed = ipString.trim();
  let value: number | null = null;

  // 1. Шестнадцатеричный формат: 8 hex-символов с префиксом x или 0x.
  if (/^0?x[0-9a-fA-F]{8}$/i.test(trimmed)) {
    const hexPart = trimmed.replace(/^0?x/i, '');
    value = parseInt(hexPart, 16);
  }
  // 2. Десятичный формат: 4 октета через точки.
  //    Порядок октетов — как в стандартной записи IPv4 (старший октет первый),
  //    он же big-endian для 32-битного значения.
  else if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) {
    const parts = trimmed.split('.').map(Number);
    if (parts.length === 4 && parts.every(p => p >= 0 && p <= 255)) {
      // >>> 0 превращает результат в беззнаковое 32-битное число
      // (иначе parts[0] << 24 даст отрицательное значение при старшем бите = 1).
      value = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    }
  }

  if (value === null || value < 0 || value > 0xFFFFFFFF) {
    return null;
  }

  // 3. Разбиваем 32-битное значение на два 16-битных слова.
  //    Возвращаем [младшее, старшее] — так требует контроллер:
  //    младший регистр идёт первым в списке регистров Modbus.
  const highWord = (value >> 16) & 0xFFFF;
  const lowWord = value & 0xFFFF;
  return [lowWord, highWord];
}

/**
 * Преобразует два 16-битных регистра Modbus в точечный IP-адрес.
 *
 * @param lowWord  Младшее 16-битное слово (первый регистр в списке Modbus).
 * @param highWord Старшее 16-битное слово (второй регистр в списке Modbus).
 * @returns Строка вида "192.168.1.10".
 */
export function registersToIp(lowWord: number, highWord: number): string {
  const value = ((highWord << 16) | lowWord) >>> 0;
  return `${(value >>> 24) & 0xFF}.${(value >>> 16) & 0xFF}.${(value >>> 8) & 0xFF}.${value & 0xFF}`;
}