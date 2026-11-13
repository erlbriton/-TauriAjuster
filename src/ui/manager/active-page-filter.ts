/**
 * Общий фильтр по активной INI-странице ([PAGES]).
 * Используется модулем рендера таблицы #grid-data-rows (src/ui/tree.ts)
 * и (в следующем шаге) осциллографом.
 */

import type { IniPage } from '../../core/ini/index.js';

const PAGE_FILTER_CHANGED = 'ini-page-filter-changed';

let activePage: IniPage | null = null;
let applyingSectionChange = false;

function normSection(s: string | undefined): string {
  return (s ?? '').trim().toUpperCase();
}

function normKey(s: string | undefined): string {
  return (s ?? '').trim().toUpperCase();
}

export function setActiveIniPage(page: IniPage | null): void {
  activePage = page;
  window.dispatchEvent(new CustomEvent(PAGE_FILTER_CHANGED));
}

export function getActiveIniPage(): IniPage | null {
  return activePage;
}

export function clearActiveIniPage(): void {
  setActiveIniPage(null);
}

/** Флаг: смена секции инициирована из pagesMenu, фильтр сбрасывать нельзя. */
export function beginPageSectionChange(): void {
  applyingSectionChange = true;
}

export function endPageSectionChange(): void {
  applyingSectionChange = false;
}

export function isApplyingPageSection(): boolean {
  return applyingSectionChange;
}

export function isParamVisibleByActivePage(
  section: string | undefined,
  paramId: string,
  paramName?: string
): boolean {
  if (!activePage) return true;
  if (activePage.items.length === 0) return true;
  const targetSec = normSection(section);
  const targetId = normKey(paramId);
  const targetName = normKey(paramName);
  return activePage.items.some((item) => {
    if (normSection(item.section) !== targetSec) return false;
    const itemKey = normKey(item.paramName);
    if (!itemKey) return false;
    return itemKey === targetId || (targetName !== '' && itemKey === targetName);
  });
}

/**
 * Отфильтровать IniParameter[] по активной странице.
 * Если активной страницы нет — возвращает исходный массив без изменений.
 */
export function filterIniParamsByActivePage<T extends { id: string; name?: string }>(
  section: string | undefined,
  params: T[]
): T[] {
  if (!activePage) return params;
  const filtered = params.filter((p) =>
    isParamVisibleByActivePage(section, p.id, p.name)
  );
  // ДИАГНОСТИКА — уберём, когда убедимся, что фильтр работает.
  // Открой консоль браузера при выборе страницы и покажи эту строку.
  console.log(
    '[PageFilter] section=', section,
    '| activePage=', activePage.id,
    '| itemsSections=', Array.from(new Set(activePage.items.map((i) => i.section))),
    '| firstItem=', activePage.items[0],
    '| paramsTotal=', params.length,
    '| filtered=', filtered.length,
    '| sampleParam=', params[0] ? { id: params[0].id, name: params[0].name } : null
  );
  return filtered;
}

export function onPageFilterChanged(handler: () => void): () => void {
  const listener = () => handler();
  window.addEventListener(PAGE_FILTER_CHANGED, listener);
  return () => window.removeEventListener(PAGE_FILTER_CHANGED, listener);
}