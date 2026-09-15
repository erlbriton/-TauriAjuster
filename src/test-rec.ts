// src/test-rec.ts
import { writeFileSync } from 'node:fs';
import { RecFileWriter } from './oscilloscope/core/RecFileWriter.js';

console.log('🔬 Запуск теста генерации .rec файла...\n');

const testParam = {
  id: 'p04500',
  name: 'DEX_STATE(TEST)',
  description: 'Состояние возбудителя',
  recType: 'TWORD' as const,
  hexAddress: 'x005A',
  modbusReg: 'r002D',
  unit: '--',
  scale: 1,
  byteCount: 2,
  // rawParts не указываем, чтобы RecFileWriter сгенерировал правильную строку с '=' автоматически
};

const N = 10;
const now = Date.now();
const timestamps: number[] = [];
const values: number[][] = [[]];

for (let i = 0; i < N; i++) {
  timestamps.push(now + i * 1000);
  values[0].push(i * 26); // 0, 26, 52, 78, 104...
}

const writer = new RecFileWriter();
const bytes = writer.write({
  params: [testParam],
  timestamps,
  values,
  device: {
    location: 'Home_05',
    description: 'Насос',
    id: 'xxxxxxxx DExS.SMFCB v1.10.9.0 27.07.2024',
    mcu: '1'
  }
});

writeFileSync('test.rec', bytes);
console.log(`✅ Файл test.rec успешно перезаписан! Размер: ${bytes.length} байт`);