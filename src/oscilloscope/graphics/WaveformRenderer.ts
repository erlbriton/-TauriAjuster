// src/graphics/WaveformRenderer.ts
import { Channel } from '../core/Channel';
import { Archive, Sample } from '../core/Archive';
import { Settings } from '../config/Settings';
import { PixiView } from './PixiView';

export class WaveformRenderer {  
    // ========================================================================
    // ОТРИСОВКА АНАЛОГОВОГО СИГНАЛА
    // ========================================================================
    // Рисует график аналогового канала на холсте (view.waveGraphics).
    //
    // НОВЫЙ ПАРАМЕТР: clearCanvas (по умолчанию = true)
    // ---------------------------------------------------------
    // Этот параметр управляет тем, нужно ли очищать холст перед отрисовкой.
    //
    // - Для обычных одиночных строк каналов (как было раньше):
    //   Вызывается с clearCanvas = true (значение по умолчанию).
    //   Холст очищается перед каждым обновлением, чтобы старый график не
    //   оставался на экране. Ничего не меняется в существующей логике.
    //
    // - Для совмещённой строки (несколько каналов на одном графике):
    //   Вызывается с clearCanvas = false для всех каналов, кроме первого.
    //   Это позволяет рисовать несколько линий на одном холсте последовательно,
    //   не стирая предыдущие. Первый канал рисуется с clearCanvas = true,
    //   чтобы очистить холст от старого кадра.
    //
    // Автомасштабирование (нормализация по максимуму, минимум реальный)
    // работает независимо для каждого канала, так как используются
    // channel.min, channel.max, channel.autoScale конкретного канала.
    // ========================================================================
    public static renderAnalogWaveform(
        channel: Channel,
        samples: Sample[],
        view: PixiView,
        width: number,
        height: number,
        currentTime: number,
        duration: number,
        settings: Settings,
        archive: Archive,
        clearCanvas: boolean = true
    ): void {
        const g = view.waveGraphics;
        
        // Очищаем холст только если это разрешено параметром.
        // Для совмещённой строки первый канал очистит холст, а остальные
        // будут рисовать поверх него, не стирая предыдущие линии.
        if (clearCanvas) {
            g.clear();
        }
        
        if (samples.length < 1) return;
        let min = channel.min;
        let max = channel.autoScale ? channel.max : channel.customMax;

        if (channel.autoScale) {
            const range = archive.getMinMax(channel.id, duration, currentTime);
            if (range.min !== range.max) {
                const margin = (range.max - range.min) * 0.1 || 1;
                const targetMin = 0;
                const targetMax = range.max + margin;

                const prevMin = channel.currentDisplayMin;
                const prevMax = channel.currentDisplayMax;

                if (prevMin === undefined || prevMax === undefined || isNaN(prevMin) || isNaN(prevMax)) {
                    channel.currentDisplayMin = targetMin;
                    channel.currentDisplayMax = targetMax;
                } else {
                    channel.currentDisplayMin = prevMin + (targetMin - prevMin) * 0.1;
                    channel.currentDisplayMax = prevMax + (targetMax - prevMax) * 0.1;
                }

                min = channel.currentDisplayMin ?? targetMin;
                max = channel.currentDisplayMax ?? targetMax;
            }
        } else {
            channel.currentDisplayMin = undefined;
            channel.currentDisplayMax = undefined;
        }

        const vRange = max - min || 1;
        const startTime = currentTime - duration;
        const waveColor = channel.color;
        const getX = (t: number) => ((t - startTime) / duration) * width;
        const getY = (val: number) => {
            const y = height - ((val - min) / vRange) * height;
            return Math.max(0, Math.min(height, y));
        };

        // Децимация: не более ~2 точек на пиксель, пики сохраняются (min/max)
        const maxPoints = Math.max(64, Math.floor(width) * 2);
        let draw: Sample[] = samples;
        if (samples.length > maxPoints) {
            const bucketCount = Math.max(1, Math.floor(maxPoints / 2));
            const bucketSize = samples.length / bucketCount;
            const decimated: Sample[] = [];
            for (let b = 0; b < bucketCount; b++) {
                const start = Math.floor(b * bucketSize);
                const end = Math.min(samples.length, Math.floor((b + 1) * bucketSize) + 1);
                let minS = samples[start];
                let maxS = samples[start];
                for (let i = start; i < end; i++) {
                    if (samples[i].value < minS.value) minS = samples[i];
                    if (samples[i].value > maxS.value) maxS = samples[i];
                }
                if (minS.time <= maxS.time) {
                    decimated.push(minS);
                    if (maxS !== minS) decimated.push(maxS);
                } else {
                    decimated.push(maxS);
                    if (minS !== maxS) decimated.push(minS);
                }
            }
            draw = decimated;
        }

        const startX = getX(draw[0].time);
        const startY = getY(draw[0].value);
        g.moveTo(Math.max(0, Math.min(width, startX)), startY);

        for (let i = 1; i < draw.length; i++) {
            const x = getX(draw[i].time);
            const y = getY(draw[i].value);
            g.lineTo(x, y);
        }

        g.stroke({ width: 2, color: waveColor, alpha: 0.95 });
    }

       // ========================================================================
    // ОТРИСОВКА БИТОВОГО (ДИСКРЕТНОГО) СИГНАЛА
    // ========================================================================
    // Рисует график битового канала (прямоугольные импульсы) на холсте.
    //
    // НОВЫЙ ПАРАМЕТР: clearCanvas (по умолчанию = true)
    // ---------------------------------------------------------
    // Аналогично методу renderAnalogWaveform, этот параметр управляет тем,
    // нужно ли очищать холст перед отрисовкой.
    //
    // - Для обычных одиночных строк битовых каналов (как было раньше):
    //   Вызывается с clearCanvas = true (значение по умолчанию).
    //   Холст очищается перед каждым обновлением.
    //
    // - Для совмещённой строки (несколько каналов на одном графике):
    //   Вызывается с clearCanvas = false, если битовый канал рисуется
    //   поверх уже нарисованных аналоговых или других битовых каналов.
    //   Это позволяет совмещать аналоговые и битовые сигналы в одной
    //   системе координат, как и было задумано.
    //
    // Примечание: битовые каналы в совмещённой строке имеют фиксированную
    // высоту 25 пикселей (как в обычных одиночных строках), что обеспечивает
    // визуальную консистентность. Высота аналоговых каналов настраивается.
    // ========================================================================
    public static renderDigitalWaveform(
        channel: Channel,
        samples: Sample[],
        view: PixiView,
        width: number,
        height: number,
        currentTime: number,
        duration: number,
        clearCanvas: boolean = true
    ): void {
        const g = view.waveGraphics;
        
        // Очищаем холст только если это разрешено параметром.
        // Для совмещённой строки первый канал очистит холст, а остальные
        // будут рисовать поверх него, не стирая предыдущие линии.
        if (clearCanvas) {
            g.clear();
        }

        if (samples.length < 1) return;

        const startTime = currentTime - duration;
        const waveColor = channel.color;
        const getX = (t: number) => ((t - startTime) / duration) * width;

        const margin = 2; 
        const barHeight = height - (margin * 2);
        const lineY = height - margin - 1;

        let lastValue = samples[0].value;
        let segmentStartX = Math.max(0, getX(samples[0].time));

        for (let i = 1; i <= samples.length; i++) {
            const currentT = i < samples.length ? samples[i].time : currentTime;
            const currentValue = i < samples.length ? samples[i].value : lastValue;
            const currentX = getX(currentT);

            if (currentValue !== lastValue || i === samples.length) {
                const endX = Math.min(width, currentX);
                if (endX > segmentStartX) {
                    if (lastValue >= 0.5) {
                        g.rect(segmentStartX, margin, endX - segmentStartX, barHeight);
                    }
                }
                segmentStartX = Math.max(0, currentX);
                lastValue = currentValue;
            }
        }

        g.fill({ color: waveColor, alpha: 0.7 });

        lastValue = samples[0].value;
        segmentStartX = Math.max(0, getX(samples[0].time));

        for (let i = 1; i <= samples.length; i++) {
            const currentT = i < samples.length ? samples[i].time : currentTime;
            const currentValue = i < samples.length ? samples[i].value : lastValue;
            const currentX = getX(currentT);

            if (currentValue !== lastValue || i === samples.length) {
                const endX = Math.min(width, currentX);
                if (endX > segmentStartX) {
                    if (lastValue < 0.5) {
                        g.moveTo(segmentStartX, lineY);
                        g.lineTo(endX, lineY);
                    }
                }
                segmentStartX = Math.max(0, currentX);
                lastValue = currentValue;
            }
        }

        g.stroke({ width: 2, color: waveColor, alpha: 0.9 });
    }

    public static renderVerticalMarker(
        view: PixiView,
        markerTime: number | null,
        currentTime: number,
        duration: number,
        width: number,
        height: number
    ): void {
        const mg = view.markerGraphics;
        mg.clear();

        if (markerTime === null) return;

        const startTime = currentTime - duration;
        const endTime = currentTime;

        if (markerTime < startTime || markerTime > endTime) return;

        const x = ((markerTime - startTime) / duration) * width;

        mg.moveTo(x, 0);
        mg.lineTo(x, height);
        mg.stroke({ width: 1, color: '#ffffff', alpha: 0.9 });
    }
}