// src/ini-manager/encoding.ts
/**
 * Кодировки INI-файлов базы: легаси — Windows-1251 (старый аджастер),
 * новые файлы пишем туда же, чтобы база оставалась однородной.
 */

/**
 * Чтение с определением кодировки:
 *  - BOM UTF-8 / UTF-16LE — как есть;
 *  - иначе строгий UTF-8;
 *  - не сложилось — Windows-1251.
 */
export async function readFileWithEncoding(file: File): Promise<string> {
    const buf = new Uint8Array(await file.arrayBuffer());

    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return new TextDecoder('utf-8').decode(buf.subarray(3));
    }
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return new TextDecoder('utf-16le').decode(buf);
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
        return new TextDecoder('windows-1251').decode(buf);
    }
}

let w1251EncodeMap: Map<string, number> | null = null;

/** Обратная таблица символ→байт, строится один раз через TextDecoder. */
function getW1251Map(): Map<string, number> {
    if (w1251EncodeMap) return w1251EncodeMap;
    const dec = new TextDecoder('windows-1251');
    const map = new Map<string, number>();
    const one = new Uint8Array(1);
    for (let b = 0x80; b < 0x100; b++) {
        one[0] = b;
        const ch = dec.decode(one);
        if (ch && ch !== '\uFFFD') map.set(ch, b);
    }
    w1251EncodeMap = map;
    return map;
}

/** Кодирование строки в байты Windows-1251 (символы вне таблицы → '?'). */
export function encodeToWindows1251(text: string): Uint8Array<ArrayBuffer> {
    const map = getW1251Map();
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) {
            out[i] = code;
        } else {
            const mapped = map.get(text[i]);
            out[i] = mapped !== undefined ? mapped : 0x3f;
        }
    }
    return out;
}