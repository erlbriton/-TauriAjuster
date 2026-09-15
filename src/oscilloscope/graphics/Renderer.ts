// src/oscilloscope/graphics/Renderer.ts

import { Channel } from '../core/Channel';
import { Archive } from '../core/Archive';
import { Settings } from '../config/Settings';
import { PixiView } from './PixiView';
import { WaveformRenderer } from './WaveformRenderer';

export class Renderer {
    private settings: Settings;
    private archive: Archive;

    constructor(settings: Settings, archive: Archive) {
        this.settings = settings;
        this.archive = archive;
    }

    public renderChannelGraph(channel: Channel, view: PixiView): void {
        const { width, height } = view.bounds;
        if (width <= 0 || height <= 0) return;

        const now = this.settings.getCurrentViewTime();
        const spacing = 40 * this.settings.timeScale;
        const duration = (width / spacing) * 1000;

        this.renderGrid(view, width, height);
        this.renderMarkers(view, width, height, now, spacing, duration);

        const samples = this.archive.getRecentSamples(channel.id, duration, now);

        if (samples.length > 0) {
            if (channel.type === 'digital') {
                WaveformRenderer.renderDigitalWaveform(channel, samples, view, width, height, now, duration);
            } else {
                WaveformRenderer.renderAnalogWaveform(channel, samples, view, width, height, now, duration, this.settings, this.archive);
            }
        } else {
            view.waveGraphics.clear();
        }

        // view.present() удалён: PixiJS рендерит сцену автоматически
    }

    private renderGrid(view: PixiView, width: number, height: number): void {
        view.gridGraphics.clear();
    }

        private renderMarkers(view: PixiView, width: number, height: number, now: number, spacing: number, duration: number): void {
        const g = view.markerGraphics;
        g.clear();

        const secPx = (now / 1000) * spacing;
        const offset = (spacing - (secPx % spacing)) % spacing;

        // ВСЕ линии сетки в один путь — один stroke вместо N
        for (let x = offset; x <= width; x += spacing) {
            if (x >= 0) {
                const roundedX = Math.round(x);
                g.moveTo(roundedX, 0);
                g.lineTo(roundedX, height);
            }
        }
        g.stroke({ width: 1, color: '#94a3b8', alpha: 0.5 });

        const startTime = now - duration;

        if (this.settings.isAmplitudeMode && this.settings.amplitudeMarkerTime !== null) {
            const markerTime = this.settings.amplitudeMarkerTime;
            if (markerTime >= startTime && markerTime <= now) {
                const roundedX = Math.round(((markerTime - startTime) / duration) * width);
                g.moveTo(roundedX, 0);
                g.lineTo(roundedX, height);
                g.stroke({ width: 2, color: '#ffffff', alpha: 0.9 });
            }
        }

        if (this.settings.isIntervalMode) {
            let hasPath = false;

            if (this.settings.intervalMarker1Time !== null) {
                const marker1Time = this.settings.intervalMarker1Time;
                if (marker1Time >= startTime && marker1Time <= now) {
                    const roundedX1 = Math.round(((marker1Time - startTime) / duration) * width);
                    g.moveTo(roundedX1, 0);
                    g.lineTo(roundedX1, height);
                    hasPath = true;
                }
            }

            if (this.settings.intervalMarker2Time !== null) {
                const marker2Time = this.settings.intervalMarker2Time;
                if (marker2Time >= startTime && marker2Time <= now) {
                    const roundedX2 = Math.round(((marker2Time - startTime) / duration) * width);
                    g.moveTo(roundedX2, 0);
                    g.lineTo(roundedX2, height);
                    hasPath = true;
                }
            }

            if (hasPath) {
                g.stroke({ width: 2, color: '#dc2626', alpha: 1.0 });
            }
        }
    }

    // ========================================================================
    // ОТРИСОВКА СОВМЕЩЁННОГО ГРАФИКА (НЕСКОЛЬКО КАНАЛОВ НА ОДНОМ ХОЛСТЕ)
    // ========================================================================
    // Этот метод предназначен для отрисовки нескольких каналов (от 2 до 5)
    // в одной системе координат на одном PixiView. Используется совмещённой
    // строкой (CompositeChannelRow) для детального анализа амплитудных и
    // временных соотношений между сигналами.
    //
    // ЛОГИКА РАБОТЫ:
    // 1) Метод принимает массив каналов и один общий PixiView.
    // 2) Сначала очищаются сетка и маркеры (один раз для всей строки).
    // 3) Затем метод проходит по всем каналам массива последовательно.
    // 4) Для каждого канала получаются сэмплы из архива за текущий период.
    // 5) Вызывается соответствующий метод отрисовки (аналоговый или битовый):
    //    - Для ПЕРВОГО канала передаётся clearCanvas = true (очищаем холст
    //      от старого кадра перед началом отрисовки нового).
    //    - Для ВСЕХ ОСТАЛЬНЫХ каналов передаётся clearCanvas = false
    //      (рисуем поверх уже нарисованных линий, не стирая их).
    // 6) Каждый канал рисуется своим цветом, что обеспечивает визуальное
    //    различение сигналов на общем графике.
    //
    // АВТОМАСШТАБИРОВАНИЕ:
    // Каждый канал масштабируется независимо (нормализация по максимуму,
    // минимум остаётся реальным). Это позволяет корректно отображать
    // сигналы с разными амплитудами на одном холсте.
    //
    // ПРИМЕЧАНИЕ:
    // На данном шаге метод является заготовкой и просто логирует вызов.
    // Реальная логика отрисовки будет добавлена в следующем шаге.
    // ========================================================================
        public renderCompositeGraph(channels: Channel[], view: PixiView): void {
        const { width, height } = view.bounds;
        if (width <= 0 || height <= 0) return;

        // Получаем текущее время отображения и параметры масштабирования времени.
        // Эти значения нужны для вычисления длительности видимого окна
        // и правильного позиционирования маркеров сетки.
        const now = this.settings.getCurrentViewTime();
        const spacing = 40 * this.settings.timeScale;
        const duration = (width / spacing) * 1000;

        // Отрисовываем сетку один раз для всей совмещённой строки.
        // Сетка общая для всех каналов, поэтому её не нужно рисовать повторно
        // для каждого канала.
        this.renderGrid(view, width, height);

        // Отрисовываем вертикальные маркеры (курсоры измерения) один раз.
        // Маркеры тоже общие для всей строки.
        this.renderMarkers(view, width, height, now, spacing, duration);

        // Проходим по всем каналам и отрисовываем их последовательно.
        // Параметр clearCanvas управляет очисткой холста:
        // - Для первого канала (i === 0) передаём true, чтобы очистить холст
        //   от старого кадра перед началом отрисовки нового.
        // - Для всех остальных каналов передаём false, чтобы рисовать поверх
        //   уже нарисованных линий, не стирая их.
        for (let i = 0; i < channels.length; i++) {
            const channel = channels[i];
            const isFirst = (i === 0);

            // Получаем сэмплы для текущего канала за видимый период времени.
            const samples = this.archive.getRecentSamples(channel.id, duration, now);

            // Если сэмплов нет, пропускаем этот канал (нечего рисовать).
            if (samples.length === 0) continue;

            // Отрисовываем канал в зависимости от его типа.
            // Для битовых каналов используем renderDigitalWaveform,
            // для аналоговых — renderAnalogWaveform.
            //
            // ВАЖНО: Параметр clearCanvas передаётся как isFirst:
            // - ПЕРВЫЙ канал (isFirst = true) очищает холст от старого кадра.
            // - ВСЕ ОСТАЛЬНЫЕ (isFirst = false) рисуют поверх, не стирая
            //   уже нарисованные линии. Это позволяет видеть ВСЕ каналы
            //   группы одновременно, а не только последний.
            if (channel.type === 'digital') {
                WaveformRenderer.renderDigitalWaveform(
                    channel, samples, view, width, height, now, duration, isFirst
                );
            } else {
                WaveformRenderer.renderAnalogWaveform(
                    channel, samples, view, width, height, now, duration, this.settings, this.archive, isFirst
                );
            }
        }
    }
}