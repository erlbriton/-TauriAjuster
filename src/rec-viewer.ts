// src/rec-viewer.ts
// Точка входа для страницы просмотра .rec файлов (отдельная вкладка)

import { RecFileReader } from './oscilloscope/core/RecFileReader.js';
import { RecFileWriter } from './oscilloscope/core/RecFileWriter.js';
import { Oscilloscope } from './oscilloscope/Oscilloscope.js';
import { Channel, ChannelConfig } from './oscilloscope/core/Channel.js';

let oscilloscope: Oscilloscope | null = null;
let currentRecData: any = null;
let currentFilename: string = '';

const container = document.getElementById('rec-viewer-container') as HTMLElement;
const filePicker = document.getElementById('filePicker') as HTMLInputElement;

// === Парсинг секции [viewoption] ===
/**
 * Парсит секцию [viewoption] из текстового содержимого .rec файла.
 * Возвращает Map: ID параметра -> { viewScale: number, rowHeight: number }
 */
function parseViewOptionsFromText(fileBytes: Uint8Array): Map<string, { viewScale: number; rowHeight: number }> {
  const options = new Map<string, { viewScale: number; rowHeight: number }>();
  
  try {
    // Декодируем весь файл в строку (используем windows-1251, как при записи)
    const decoder = new TextDecoder('windows-1251');
    const fullText = decoder.decode(fileBytes);
    
    const startMarker = '[viewoption]';
    const endMarker = '[paralist]'; // Секция viewoption идет перед paralist
    
    const startIdx = fullText.indexOf(startMarker);
    if (startIdx === -1) return options; // Секции нет
    
    const endIdx = fullText.indexOf(endMarker, startIdx);
    const sectionText = endIdx !== -1 
      ? fullText.substring(startIdx + startMarker.length, endIdx)
      : fullText.substring(startIdx + startMarker.length);
    
    const lines = sectionText.split(/\r?\n/);
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(';')) continue;
      
      // Формат строки: p03300=0,005/25/
      const eqPos = trimmed.indexOf('=');
      if (eqPos === -1) continue;
      
      const paramId = trimmed.substring(0, eqPos);
      const valuesStr = trimmed.substring(eqPos + 1);
      
      // Разбиваем по слэшу: ["0,005", "25", ""]
      const parts = valuesStr.split('/').filter(p => p.length > 0);
      
      if (parts.length >= 2) {
        // Заменяем запятую на точку для корректного парсинга JS
        const scaleStr = parts[0].replace(',', '.');
        const heightStr = parts[1];
        
        const viewScale = parseFloat(scaleStr);
        const rowHeight = parseInt(heightStr, 10);
        
        if (!isNaN(viewScale) && !isNaN(rowHeight)) {
          options.set(paramId, { viewScale, rowHeight });
        }
      }
    }
  } catch (err) {
    console.warn('[RecViewer] Ошибка при парсинге [viewoption]:', err);
  }
  
  return options;
}

// === Сохранение .rec (с обновлением настроек вида из текущего состояния) ===
async function saveRec(): Promise<void> {
  if (!currentRecData || !oscilloscope) {
    alert('Нет данных для сохранения');
    return;
  }

  try {
    // 1. Получаем текущие каналы из осциллографа (они содержат измененные пользователем настройки)
    const currentChannels = oscilloscope.getAllChannels();
    
    if (currentChannels.length === 0) {
      alert('Нет активных каналов для сохранения');
      return;
    }

    // 2. Создаем глубокую копию параметров, чтобы не мутировать исходные данные в просмотрщике
    // Мы обновим только поля scale и добавим rowHeight в объекты параметров
    const updatedParams = currentRecData.params.map((p: any) => {
      // Ищем соответствующий живой канал по ID
      const channel = currentChannels.find((ch) => ch.id === p.id);
      
      if (channel) {
        // Берем актуальный максимум: если пользователь задавал customMax, используем его, иначе стандартный max
        const effectiveMax = channel.customMax !== undefined ? channel.customMax : channel.max;
        const effectiveRowHeight = channel.rowHeight || 25;
        const effectiveScale = channel.scale || 1.0;
        
        // Пересчитываем viewScale по формуле: (Высота / Максимум) * Шкала
        let newViewScale = 0;
        if (effectiveMax > 0) {
          newViewScale = (effectiveRowHeight / effectiveMax) * effectiveScale;
          // Округляем до 5 знаков после запятой для чистоты файла (как при экспорте)
          newViewScale = Math.round(newViewScale * 100000) / 100000;
        }

        // Возвращаем обновленный объект параметра
        return {
          ...p,
          scale: newViewScale,       // Записываем вычисленный визуальный масштаб
          rowHeight: effectiveRowHeight // Записываем текущую высоту строки
        };
      }
      
      // Если канал не найден (теоретически невозможно), возвращаем как есть
      return p;
    });

    // 3. Формируем финальный объект данных для записи
    const dataToSave = {
      ...currentRecData,
      params: updatedParams
    };

    // 4. Записываем файл
    const writer = new RecFileWriter();
    const bytes = writer.write(dataToSave);
    
    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentFilename; // Сохраняем под тем же именем
    a.click();
    URL.revokeObjectURL(url);
    
    console.log('[RecViewer] Файл сохранен с актуальными настройками вида.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[RecViewer] Ошибка сохранения:', err);
    alert(`Ошибка сохранения: ${msg}`);
  }
}

// === Обработчик выбора файла ===
filePicker.addEventListener('change', async () => {
  if (!filePicker.files || filePicker.files.length === 0) return;
  const file = filePicker.files[0];
  try {
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    const reader = new RecFileReader();
    const recData = reader.parse(uint8Array);

    currentRecData = recData;
    currentFilename = file.name;

    // Передаем сырые байты для парсинга настроек вида
    await loadRecData(recData, uint8Array);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[RecViewer] Ошибка:', err);
    alert(`Не удалось открыть файл:\n${message}`);
  }
});

// === Создание просмотрщика (вызывается один раз при старте) ===
async function setupViewer(): Promise<void> {
  container.innerHTML = '';

  oscilloscope = new Oscilloscope({ skipSerial: true, skipRecorder: true, viewerMode: true });
  await oscilloscope.initialize(container);

  // Файловые кнопки в ЕДИНОМ тулбаре осциллографа
  oscilloscope.addViewerButton('✕', 'Закрыть', () => window.close());
  oscilloscope.addViewerButton('📂', 'Открыть .rec', () => filePicker.click());
  oscilloscope.addViewerButton('💾', 'Сохранить .rec', () => { void saveRec(); });

  // Применяем финальное выравнивание и перемещение кнопок в конец
  oscilloscope.finalizeViewerToolbar();
}

// === Загрузка данных .rec в уже созданный осциллограф ===
async function loadRecData(recData: any, fileBytes: Uint8Array): Promise<void> {
  if (!oscilloscope) return;

  const PALETTE = [
    '#00d2ff', '#ff0055', '#00ff88', '#ffaa00', '#aa00ff', 
    '#00ffcc', '#ff5500', '#55ff00', '#0055ff', '#ff00aa'
  ];
  let bitIndex = 0;
  let paletteIdx = 0;

  // 1. Парсим настройки вида из файла
  const viewOptions = parseViewOptionsFromText(fileBytes);

  const channels: Channel[] = recData.params.map((p: any) => {
    const isBit = p.recType === 'TBit';
    
    // Алгоритм цветов точно как в ini-to-channels.ts
    let color: string;
    if (isBit) {
      color = (bitIndex % 2 === 0) ? '#00d2ff' : '#d2a679';
      bitIndex++;
    } else {
      color = PALETTE[paletteIdx % PALETTE.length];
      paletteIdx++;
    }

    // Базовые значения (дефолтные, если в файле нет настроек)
    let rowHeight = 25;
    let max = isBit ? 1 : 500;
    let scale = 1.0;
    let customMax: number | undefined = undefined;

    // 2. Применяем настройки из [viewoption], если они есть для этого ID
    const opts = viewOptions.get(p.id);
    if (opts) {
      rowHeight = opts.rowHeight;
      
      // Восстанавливаем параметры по формуле: viewScale = (rowHeight / max) * scale
      // Стратегия: фиксируем scale = 1.0 и вычисляем max, чтобы график соответствовал высоте.
      // max = (rowHeight * scale) / viewScale
      if (opts.viewScale > 0) {
        const calculatedMax = (rowHeight * 1.0) / opts.viewScale;
        // Округляем до разумного значения
        max = Math.round(calculatedMax);
        if (max === 0) max = 1; // Защита от деления на ноль
        customMax = max; // Помечаем как пользовательский максимум
        scale = 1.0;
      }
    }

    const config: ChannelConfig = {
      id: p.id,
      name: p.name,
      description: p.description,
      dataType: p.recType,
      // Жёстко убираем UNIT для бинарных параметров
      unit: isBit ? '' : (p.unit || ''),
      scale: scale,           // Используем восстановленное или дефолтное
      isBit: isBit,
      modbusReg: p.modbusReg,
      rawDecValue: 0,
      hexValue: 'x0000',
      min: isBit ? 0 : -50,
      max: max,               // Используем восстановленное или дефолтное
      customMax: customMax,   // Передаем пользовательский максимум
      autoScale: true,        // Включаем автомасштаб, чтобы синхронизировать с кнопкой тулбара
      rowHeight: rowHeight,   // Используем восстановленную высоту
      color: color,
      recRawParts: p.rawParts,
    };
    return new Channel(config);
  });

  await oscilloscope.setChannels(channels);

  const archive = oscilloscope.getArchive();
  const N = recData.timestamps.length;
  
  // Сортируем все данные по времени (старый аджастер делает то же самое)
  const indices = Array.from({ length: N }, (_, i) => i);
  indices.sort((a, b) => recData.timestamps[a] - recData.timestamps[b]);
  
  // Добавляем в архив в отсортированном порядке
  for (let idx = 0; idx < N; idx++) {
    const i = indices[idx];
    const time = recData.timestamps[i];
    for (let pIdx = 0; pIdx < recData.params.length; pIdx++) {
      const val = recData.values[pIdx][i];
      archive.addSample(channels[pIdx].id, time, val, val);
    }
  }

  const range = oscilloscope.getArchive().getTimeRange();
  console.log(`[RecViewer] range.min=${range.min.toFixed(0)}, range.max=${range.max.toFixed(0)}`);
  console.log(`[RecViewer] range: min=${range.min.toFixed(0)}, max=${range.max.toFixed(0)}, duration=${(range.max - range.min).toFixed(0)}ms`);
  oscilloscope.setViewTime(range.max);
  console.log(`[RecViewer] frozenTime after setViewTime: ${oscilloscope.getArchive().getTimeRange().max.toFixed(0)}`);

  console.log(`[RecViewer] Загружено сэмплов: ${N}`);

  // ОТЛАДКА: статистика по каждому каналу после загрузки файла
  const arch = oscilloscope.getArchive();
  let emptyCount = 0;
  for (const ch of channels) {
    const s = arch.getAllSamples(ch.id);
    if (s.length === 0) {
      emptyCount++;
      console.log(`[RecViewer] КАНАЛ ПУСТ: ${ch.id}`);
      continue;
    }
    console.log(
      `[RecViewer] ${ch.id}: сэмплов=${s.length}, first=${s[0].time.toFixed(0)}, last=${s[s.length - 1].time.toFixed(0)}`,
    );
  }
  console.log(`[RecViewer] Итого пустых каналов: ${emptyCount} из ${channels.length}`);
  (window as unknown as { viewerOsc?: unknown }).viewerOsc = oscilloscope;
}

// При старте создаем просмотрщик с тулбаром (файл открываем по клику на 📂)
void setupViewer();

console.log('[RecViewer] Страница просмотра загружена');