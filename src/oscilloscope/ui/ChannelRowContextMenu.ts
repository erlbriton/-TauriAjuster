// src/oscilloscope/ui/ChannelRowContextMenu.ts
// Сборка и показ контекстного меню строки канала.
//
// Файл выделен из ChannelRow.ts, чтобы не смешивать жизненный цикл строки
// (DOM-элемент, обновление значений, свойства канала) с конфигурацией
// контекстного меню. Вся логика, связанная с состоянием строки
// (флаг выбора для анализа, счётчики, DOM-подсветка), остаётся
// в ChannelRow — сюда передаются только геттеры и колбэки.

import type { Channel } from '../core/Channel';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

export interface ChannelRowContextMenuOptions {
  /** Канал, для которого открывается меню. */
  channel: Channel;
  /** Событие контекстного меню (для координат). */
  event: MouseEvent;
  /** Текущее состояние флага «выбран для анализа» именно этого канала. */
  isSelectedForAnalysis: boolean;
  /** Текущее количество каналов, выбранных для анализа (из ChannelRow). */
  getSelectedCount: () => number;
  /** Текущий список выбранных каналов (из ChannelRow). */
  getSelectedChannels: () => Channel[];
  /** Открыть окно «Свойства канала». */
  onOpenProperties: () => void;
  /** Открыть окно «Посчитать коэффициент» (только для аналоговых каналов). */
  onCalculateCoefficient: () => void;
  /** Переключить флаг выбора этого канала для анализа (с проверкой лимита). */
  onToggleAnalysisSelection: () => void;
  /** Снять выбор со всех каналов, выбранных для анализа. */
  onClearAllAnalysisSelection: () => void;
  /** Создать совмещённую строку из массива каналов. */
  onCreateComposite: (channels: Channel[]) => void;
  /** Удалить эту строку (с корректной очисткой структур выбора). */
  onDelete: () => void;
}

export function showChannelRowContextMenu(opts: ChannelRowContextMenuOptions): void {
  const { channel, event } = opts;
  const isAnalog = channel.type !== 'digital';

  const menuItems: ContextMenuItem[] = [
    {
      label: 'Свойства',
      icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
      onClick: () => {
        opts.onOpenProperties();
      }
    }
  ];

  if (isAnalog) {
    menuItems.push({
      label: 'Посчитать коэффициент',
      icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="8" y2="10.01"/><line x1="12" y1="10" x2="12" y2="10.01"/><line x1="16" y1="10" x2="16" y2="10.01"/><line x1="8" y1="14" x2="8" y2="14.01"/><line x1="12" y1="14" x2="12" y2="14.01"/><line x1="16" y1="14" x2="16" y2="14.01"/><line x1="8" y1="18" x2="8" y2="18.01"/><line x1="12" y1="18" x2="12" y2="18.01"/><line x1="16" y1="18" x2="16" y2="18.01"/></svg>`,
      onClick: () => {
        opts.onCalculateCoefficient();
      }
    });
  }

  // Пункт меню «Выбрать для анализа / Убрать из анализа».
  // Текст и иконка пункта меняются динамически в зависимости от того,
  // выбран ли данный канал для анализа в текущий момент.
  // Если канал ещё не выбран — показываем «Выбрать для анализа» и иконку графика.
  // Если уже выбран — показываем «Убрать из анализа» и иконку крестика.
  menuItems.push({
    label: opts.isSelectedForAnalysis ? 'Убрать из анализа' : 'Выбрать для анализа',
    icon: opts.isSelectedForAnalysis
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    onClick: () => {
      opts.onToggleAnalysisSelection();
    }
  });

  // Пункт меню «Удалить все из анализа».
  // Показывается только в том случае, если выбран хотя бы один канал.
  // Позволяет пользователю одним кликом сбросить выбор всех каналов,
  // если он передумал делать совмещение. Это удобнее, чем убирать
  // каждый канал по отдельности.
  if (opts.getSelectedCount() > 0) {
    menuItems.push({
      label: 'Удалить все из анализа',
      icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
      onClick: () => {
        opts.onClearAllAnalysisSelection();
      }
    });
  }

  // ==========================================================================
  // ПУНКТ МЕНЮ «СОВМЕСТИТЬ» (Объединение графиков в одну строку)
  // ==========================================================================
  // Этот пункт появляется в контекстном меню ТОЛЬКО тогда, когда пользователь
  // выбрал для анализа 2 или более каналов. Если выбран 0 или 1 канал, пункт
  // полностью скрыт (а не просто неактивен). Это позволяет не перегружать меню
  // недоступными действиями и избавляет нас от необходимости модифицировать
  // сам компонент ContextMenu для поддержки состояния 'disabled'.
  // Совмещение имеет смысл только при сравнении нескольких сигналов.
  const selectedCount = opts.getSelectedCount();
  if (selectedCount >= 2) {
    menuItems.push({
      label: `Совместить (${selectedCount})`,
      // Иконка: несколько наложенных друг на друга слоев (графиков)
      icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
      onClick: () => {
        // Собираем массив объектов Channel из всех выбранных строк.
        // Это нужно передать в обработчик onCreateComposite, чтобы
        // внешний код (OscilloscopeBindings) мог создать совмещённую
        // строку с этими каналами.
        const selectedChannels = opts.getSelectedChannels();

        // Логируем действие для отладки.
        console.log(`[Oscilloscope] Запрошено совмещение ${selectedCount} каналов.`);
        console.log('[Oscilloscope] Список каналов для совмещения:', selectedChannels.map(ch => ch.name));

        opts.onCreateComposite(selectedChannels);
      }
    });
  }

  menuItems.push({
    label: 'Удалить',
    danger: true,
    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`,
    onClick: () => {
      opts.onDelete();
    }
  });

  ContextMenu.getInstance().show(event.clientX, event.clientY, menuItems);
}