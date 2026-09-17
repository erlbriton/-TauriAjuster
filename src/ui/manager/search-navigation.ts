/**
 * Модуль поиска и навигации.
 * Отвечает за:
 * - Поиск места установки (дерево устройств)
 * - Поиск параметра в таблице Modbus
 * - Кнопку "Сегодня" (дата)
 * - Инициализацию модальных окон (Новое устройство, Резерв, Свойства, Справка)
 */

import type { AppState } from '../../core/app-state.js';
import { getAllDevices, getDeviceGroupKey, currentIniConfig } from '../../ini-manager/tree-core.js';
import { setTreeGroupMode } from '../../ini-manager/tree-core.js';
import { renderDeviceTree } from '../../ini-manager/tree-ui.js';
import { processSingleFileContent } from '../../ini-manager/file-loader.js';
import { showNewDeviceModal, setNewDeviceAddToLoaded, initNewDeviceUI } from '../new-device-ui.js';
import { initBackupUI, setBackupLoadFn } from '../backup-ui.js';
import { initParamPropertiesUI } from '../param-properties-ui.js';
import { initHelpUI, showHelpWindow } from '../help-ui.js';
import { SearchPanel } from '../../oscilloscope/ui/SearchPanel.js';
import { hasAnyDirty } from '../../ini-manager/dirty-tracker.js';

export interface SearchNavigationUIDeps {
  appState: AppState;
  treeSearchOverlay: HTMLElement | null;
  treeSearchInput: HTMLInputElement | null;
  treeSearchStatus: HTMLElement | null;
  treeSearchCloseBtn: HTMLElement | null;
  treeSearchCancelBtn: HTMLElement | null;
  treeSearchFindBtn: HTMLElement | null;
  treeSearchSplit: HTMLElement | null;
  treeSearchMainBtn: HTMLElement | null;
  treeSearchDropdownBtn: HTMLElement | null;
  treeSearchMenu: HTMLElement | null;
  todayBtn: HTMLElement | null;
}

export function initSearchNavigationUI(deps: SearchNavigationUIDeps): void {
  const {
    appState,
    treeSearchOverlay,
    treeSearchInput,
    treeSearchStatus,
    treeSearchCloseBtn,
    treeSearchCancelBtn,
    treeSearchFindBtn,
    treeSearchSplit,
    treeSearchMainBtn,
    treeSearchDropdownBtn,
    treeSearchMenu,
    todayBtn
  } = deps;

  // --- Панель поиска параметра в таблице Modbus ---
  const searchPanel = new SearchPanel();
  searchPanel.onSelect = (item) => {
    console.log('[SearchNav] searchPanel.onSelect: item.id =', item.id);
    
    // Убираем выделение со ВСЕХ строк в таблице Modbus
    const allSelected = document.querySelectorAll('#grid-data-rows tr[data-key].selected');
    allSelected.forEach((el) => {
      el.classList.remove('selected');
    });
    
    // Ищем строку по data-key и выделяем
    const row = document.querySelector<HTMLTableRowElement>(`#grid-data-rows tr[data-key="${CSS.escape(item.id)}"]`);
    if (row) {
      row.classList.add('selected');
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      console.log('[SearchNav] Строка выделена:', item.id);
    } else {
      console.warn('[SearchNav] Строка не найдена:', item.id);
    }
  };

  // --- Логика поиска места установки (дерево) ---
  const hideTreeSearch = (): void => {
    treeSearchOverlay?.classList.add('hidden');
  };

  const doTreeSearch = (): void => {
    const query = (treeSearchInput?.value ?? '').trim();
    if (!query) {
      if (treeSearchStatus) treeSearchStatus.textContent = 'Введите название места.';
      return;
    }
    const queryLower = query.toLowerCase();

    // Уникальные имена групп ("Место установки") в порядке загрузки.
    const all = getAllDevices();
    const keys: string[] = [];
    for (const d of all) {
      const k = getDeviceGroupKey(d, 'location');
      if (!keys.includes(k)) keys.push(k);
    }

    // Точный поиск: сначала полное совпадение, затем начало строки, затем вхождение.
    const matchedKey =
      keys.find((k) => k.toLowerCase() === queryLower) ??
      keys.find((k) => k.toLowerCase().startsWith(queryLower)) ??
      keys.find((k) => k.toLowerCase().includes(queryLower));

    if (!matchedKey) {
      if (treeSearchStatus) treeSearchStatus.textContent = `Не найдено: ${query}`;
      return;
    }

    setTreeGroupMode('location');
    renderDeviceTree();

    // Раскрываем найденную группу и выделяем первый файл в ней.
    const detailsList = document.querySelectorAll('details.tree-location');
    for (const details of detailsList) {
      const summary = details.querySelector('summary');
      if ((summary?.textContent ?? '').trim() !== matchedKey) continue;
      (details as HTMLDetailsElement).open = true;
      const firstLeaf = details.querySelector<HTMLLIElement>('.tree-id-item.is-leaf');
      if (firstLeaf) firstLeaf.click();
      break;
    }
    hideTreeSearch();
  };

  const openTreeSearchOverlay = (): void => {
    if (!treeSearchOverlay) return;
    if (treeSearchInput) treeSearchInput.value = '';
    if (treeSearchStatus) treeSearchStatus.textContent = '';
    treeSearchOverlay.classList.remove('hidden');
    treeSearchInput?.focus();
  };

  // Клик по основной части (знак вопроса) — сразу "Поиск места установки"
  treeSearchMainBtn?.addEventListener('click', openTreeSearchOverlay);

  // Клик по треугольнику — показать/скрыть меню
  treeSearchDropdownBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    treeSearchMenu?.classList.toggle('show');
  });

  // Клик по пункту меню
  treeSearchMenu?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const action = target.getAttribute('data-action');
    if (!action) return;

    treeSearchMenu.classList.remove('show');

    if (action === 'location') {
      openTreeSearchOverlay();
    } else if (action === 'param') {
      // Собираем список параметров из текущей секции таблицы
      const modeSelect = document.querySelector<HTMLSelectElement>('.toolbar-device-mode-select');
      const selectedMode = modeSelect && modeSelect.value ? modeSelect.value : 'FLASH';
      
      if (currentIniConfig) {
        const params = currentIniConfig.getSection(selectedMode);
        const items = params.map((p) => ({ id: p.id, name: p.name }));
        searchPanel.open(items);
      } else {
        console.warn('[SearchNav] Нет загруженного INI для поиска параметра');
      }
    }
  });

  // Закрыть меню при клике вне его
  document.addEventListener('click', (e) => {
    if (treeSearchMenu && treeSearchMenu.classList.contains('show')) {
      if (treeSearchSplit && !treeSearchSplit.contains(e.target as Node)) {
        treeSearchMenu.classList.remove('show');
      }
    }
  });

  // Обработчики кнопок оверлея поиска
  treeSearchCloseBtn?.addEventListener('click', hideTreeSearch);
  treeSearchCancelBtn?.addEventListener('click', hideTreeSearch);
  treeSearchFindBtn?.addEventListener('click', doTreeSearch);
  
  treeSearchOverlay?.addEventListener('click', (e: MouseEvent) => {
    if (e.target === treeSearchOverlay) hideTreeSearch();
  });
  
  treeSearchInput?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); doTreeSearch(); }
    if (e.key === 'Escape') { e.preventDefault(); hideTreeSearch(); }
  });

  // --- Кнопка "Сегодня" ---
  todayBtn?.addEventListener('click', () => {
    const dateInput = document.querySelector('.date-input') as HTMLInputElement | null;
    if (!dateInput) return;
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    dateInput.value = `${dd}.${mm}.${now.getFullYear()}`;
  });

  // --- Инициализация модальных окон и UI ---
  // Эти функции просто настраивают обработчики, логика внутри них
  initHelpUI();
  initNewDeviceUI();
  initBackupUI();
  initParamPropertiesUI();

  // Установка колбэков для загрузки файлов (из новых устройств или резервных копий)
  setNewDeviceAddToLoaded((content, fileName, file, handle) =>
    processSingleFileContent(content, fileName, appState, file, handle)
  );
  
  setBackupLoadFn((content, fileName, file, handle) => 
    processSingleFileContent(content, fileName, appState, file, handle)
  );

  // Глобальный обработчик F1 для справки
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'F1') {
      e.preventDefault();
      showHelpWindow();
    }
  });

  console.log("[SearchNavigationUI] Инициализирован.");
}