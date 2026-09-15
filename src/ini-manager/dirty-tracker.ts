// src/ini-manager/dirty-tracker.ts

/**
 * Отслеживание несохранённых изменений параметров INI-файла.
 * Хранит Set идентификаторов параметров, которые были изменены
 * в таблице или модальном окне свойств, но ещё не сохранены на диск.
 * Также рисует красную звёздочку в колонке «№» таблицы.
 */

const dirtyParams = new Set<string>();

/** Обновляет красную звёздочку в колонке «№» строки таблицы */
function updateStar(paramId: string, dirty: boolean): void {
  const row = document.querySelector<HTMLTableRowElement>(
    `#grid-data-rows tr[data-key="${CSS.escape(paramId)}"]`,
  );
  if (!row) return;
  const firstTd = row.querySelector('td');
  if (!firstTd) return;

  let star = firstTd.querySelector<HTMLSpanElement>('.dirty-star');
  if (dirty && !star) {
    star = document.createElement('span');
    star.className = 'dirty-star';
    star.textContent = ' *';
    star.title = 'Есть несохранённые изменения';
    firstTd.appendChild(star);
  } else if (!dirty && star) {
    star.remove();
  }
}

/** Пометить параметр как изменённый (несохранённый) */
export function markDirty(paramId: string): void {
  dirtyParams.add(paramId);
  updateStar(paramId, true);
  console.log(`[DirtyTracker] Параметр помечен как изменённый: ${paramId}`);
}

/** Снять пометку с одного параметра */
export function clearDirty(paramId: string): void {
  dirtyParams.delete(paramId);
  updateStar(paramId, false);
}

/** Очистить все пометки (обычно после сохранения файла) */
export function clearAllDirty(): void {
  dirtyParams.clear();
  document.querySelectorAll('.dirty-star').forEach((el) => el.remove());
  console.log('[DirtyTracker] Все пометки сняты.');
}

/** Проверить, изменён ли конкретный параметр */
export function isDirty(paramId: string): boolean {
  return dirtyParams.has(paramId);
}

/** Есть ли хотя бы один несохранённый параметр */
export function hasAnyDirty(): boolean {
  return dirtyParams.size > 0;
}

/** Получить список всех несохранённых параметров (для диагностики) */
export function getDirtyParams(): string[] {
  return Array.from(dirtyParams);
}