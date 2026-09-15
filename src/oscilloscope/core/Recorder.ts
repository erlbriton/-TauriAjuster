// src/oscilloscope/core/Recorder.ts
import { Archive, Sample } from './Archive';
import { Channel } from './Channel';
import type { IFileSaver } from '../../core/platform/fs.js';
import type { IniDeviceInfo } from '../../core/ini/types.js';
import {
  RecFileWriter,
  mapToRecDataType,
  recTypeByteCount,
  type RecDataType,
  type RecParam,
} from './RecFileWriter';

export type RecordState = 'idle' | 'recording' | 'paused';

function pickSampleValue(value: number, raw: number, recType: RecDataType): number {
  switch (recType) {
    case 'TFloat':
      return value;
    case 'TBit':
      return Math.round(value);
    case 'TWORD':
      return Math.round(raw) & 0xFFFF;
    default:
      // TInteger, TIPAddr и все остальные — целое сырое значение
      return Math.round(raw);
  }
}

export class Recorder {
  private state: RecordState = 'idle';
  private startTime: number = 0;
  private endTime: number = 0;
  private pauseTime: number = 0;
  private totalPausedDuration: number = 0;
  private archive: Archive;
  private fileSaver: IFileSaver;

  constructor(archive: Archive, fileSaver: IFileSaver) {
    this.archive = archive;
    this.fileSaver = fileSaver;
  }

  public start(): void {
    this.state = 'recording';
    this.startTime = Date.now();
    this.endTime = 0;
    this.totalPausedDuration = 0;
  }

  public pause(): void {
    if (this.state === 'recording') {
      this.state = 'paused';
      this.pauseTime = Date.now();
    }
  }

  public resume(): void {
    if (this.state === 'paused') {
      this.totalPausedDuration += (Date.now() - this.pauseTime);
      this.state = 'recording';
    }
  }

  public stop(): void {
    this.endTime = Date.now();
    this.state = 'idle';
  }

  public getState(): RecordState {
    return this.state;
  }

  public getElapsedMs(): number {
    if (this.state === 'idle') return 0;
    if (this.state === 'paused') {
      return this.pauseTime - this.startTime - this.totalPausedDuration;
    }
    return Date.now() - this.startTime - this.totalPausedDuration;
  }

    public async exportREC(
    channels: Channel[],
    startTime: number | null,
    endTime: number | null,
    device: IniDeviceInfo | null,
  ): Promise<void> {
    const supported = channels.filter((ch) => mapToRecDataType(ch.dataType) !== null);
    if (supported.length === 0) {
      throw new Error('Нет параметров с типами TWORD/TFloat/TBit/TInteger для записи .rec');
    }

    // ОТЛАДКА: сколько сэмплов у каждого канала в архиве
    console.log(`[Recorder] ОТЛАДКА: передано ${channels.length} каналов, поддерживаемых: ${supported.length}`);
    const sampleCounts: { id: string; count: number }[] = [];
    for (const ch of supported) {
      const samples = this.archive.getAllSamples(ch.id);
      sampleCounts.push({ id: ch.id, count: samples.length });
    }
    const withData = sampleCounts.filter(s => s.count > 0);
    const withoutData = sampleCounts.filter(s => s.count === 0);
    console.log(`[Recorder] Каналов с данными: ${withData.length}`);
    console.log(`[Recorder] Каналов БЕЗ данных: ${withoutData.length}`);
    if (withoutData.length > 0) {
      console.log(`[Recorder] Первые 10 каналов БЕЗ данных:`, withoutData.slice(0, 10).map(s => s.id));
    }

    const base = supported[0];
    const allBase = this.archive.getAllSamples(base.id);

    let filtered: Sample[] = allBase;
    if (startTime !== null && endTime !== null) {
      filtered = allBase.filter((s) => s.time >= startTime && s.time <= endTime);
    }
    if (filtered.length === 0) {
      throw new Error('Нет данных в выбранном интервале времени');
    }

    const timestamps = filtered.map((s) => s.time);
    const params: RecParam[] = [];
    const values: number[][] = [];

    for (const ch of supported) {
      const recType = mapToRecDataType(ch.dataType)!;
      let chValues: number[];

      if (ch.id === base.id) {
        chValues = filtered.map((s) => pickSampleValue(s.value, s.raw, recType));
      } else {
        chValues = timestamps.map((t) => {
          if (recType === 'TFloat' || recType === 'TBit') {
            return this.archive.getValueAtTime(ch.id, t) ?? 0;
          }
          return this.archive.getRawAtTime(ch.id, t) ?? 0;
        });
      }

           // 1. Определяем актуальный максимум (пользовательский или стандартный)
      const currentMax = ch.customMax !== undefined ? ch.customMax : ch.max;
      
      // 2. Вычисляем первое число по формуле: (Высота / Максимум) * Шкала
      // Защита от деления на ноль
            // 2. Вычисляем первое число по формуле: (Высота / Максимум) * Шкала
      let rawViewScale = 0;
      if (currentMax > 0) {
        rawViewScale = (ch.rowHeight / currentMax) * ch.scale;
      }
      
      // Округляем до 5 знаков после запятой, чтобы убрать артефакты плавающей точки
      const viewScale = Math.round(rawViewScale * 100000) / 100000;

      params.push({
        id: ch.id,
        name: ch.name,
        description: ch.description,
        recType,
        hexAddress: '',
        modbusReg: ch.modbusReg,
        unit: ch.unit || '--',
        scale: viewScale,       // Записываем ВЫЧИСЛЕННОЕ значение
        byteCount: recTypeByteCount(recType),
        rowHeight: ch.rowHeight, // Записываем ТЕКУЩУЮ высоту строки
        rawParts: ch.recRawParts,
      });
      values.push(chValues);
    }

    const writer = new RecFileWriter();
    const bytes = writer.write({
      params,
      timestamps,
      values,
      device: device
        ? {
            id: device.id,
            location: device.location || 'Home_05',
            description: device.description || '',
            mcu: '1',
          }
        : undefined,
    });

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const filename =
      `oscilloscope_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.rec`;

    await this.fileSaver.saveBinaryFile(filename, bytes, 'application/octet-stream');
  }

  public exportCSV(channels: Channel[]): string {
    const lines: string[] = [];
    const header = ['Time_ms', ...channels.map(c => `"${c.name} (${c.unit})"` )].join(',');
    lines.push(header);

    if (channels.length === 0) return lines.join('\n');

    const samplesMap = new Map<string, { time: number; value: number }[]>();
    let maxLen = 0;
    channels.forEach(ch => {
      const allSamples = this.archive.getAllSamples(ch.id);
      const filteredSamples = allSamples.filter(s => s.time >= this.startTime && s.time <= this.endTime);
      samplesMap.set(ch.id, filteredSamples);
      if (filteredSamples.length > maxLen) maxLen = filteredSamples.length;
    });

    const firstChSamples = samplesMap.get(channels[0].id) || [];
    for (let i = 0; i < firstChSamples.length; i++) {
      const rowTime = firstChSamples[i].time;
      const rowValues = channels.map(ch => {
        const sList = samplesMap.get(ch.id) || [];
        const item = sList[i];
        return item !== undefined ? item.value.toFixed(4) : '';
      });
      lines.push([rowTime.toFixed(0), ...rowValues].join(','));
    }

    return lines.join('\n');
  }

  public async downloadCSV(channels: Channel[], filename: string = 'oscilloscope_record.csv'): Promise<void> {
    const csvContent = this.exportCSV(channels);
    await this.fileSaver.saveTextFile(filename, csvContent, 'text/csv;charset=utf-8');
  }
}