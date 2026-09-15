// src/ui/ui.ts

/**
 * Отображает кастомное модальное окно
 */
import { createIniEditor, type IniEditorInstance } from './ini-editor-cm.js';

export function showIdModal(text: string): void {
    const existing = document.querySelector('.id-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'id-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'id-modal';
    
    modal.innerHTML = `
        <div class="id-modal-content">
            <span class="id-modal-text">${text}</span>
            <button class="id-modal-btn">OK</button>
        </div>
    `;
    
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = (): void => overlay.remove();
    const btn = modal.querySelector<HTMLButtonElement>('.id-modal-btn');
    if (btn) {
        btn.addEventListener('click', close);
    }
    
    overlay.addEventListener('click', (e: MouseEvent) => { 
        if (e.target === overlay) close(); 
    });
}

/**
 * Компактное окно ошибки в цветах таблицы.
 * Показывается при проблемах связи независимо от осциллографа.
 */
export function showCompactError(text: string): void {
    const existing = document.querySelector('.compact-error-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'compact-error-overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0, 0, 0, 0.25)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '9999';

    const modal = document.createElement('div');
    modal.style.background = '#ffffff';
    modal.style.border = '2px solid #888';           // Усиленная рамка
    modal.style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)';  // Более выраженная тень
    modal.style.width = 'auto';      // Ширина подстраивается под сообщение в одну строку
    modal.style.fontFamily = 'Segoe UI, Arial, sans-serif';
    modal.style.fontSize = '13px';
    modal.style.color = '#333';
    modal.style.borderRadius = '5px';
    modal.style.overflow = 'hidden';

    // Серая полоса-заголовок (как у таблицы)
    const header = document.createElement('div');
    header.style.background = 'linear-gradient(to bottom, #f0f0f0, #e0e0e0)';
    header.style.borderBottom = '1px solid #999';
    header.style.padding = '8px 12px';
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.gap = '6px';
    header.style.fontWeight = '600';
    header.style.color = '#555';

    const icon = document.createElement('span');
    icon.textContent = '⚠️';
    icon.style.fontSize = '14px';

    const title = document.createElement('span');
    title.textContent = 'Внимание';

    header.appendChild(icon);
    header.appendChild(title);

    const content = document.createElement('div');
    content.style.padding = '14px 16px';
    content.style.textAlign = 'center';

    const msg = document.createElement('div');
    msg.textContent = text;
    msg.style.marginBottom = '12px';
    msg.style.lineHeight = '1.4';
    msg.style.whiteSpace = 'nowrap'; // Сообщение всегда в одну строку

    const btn = document.createElement('button');
    btn.textContent = 'OK';
    btn.style.padding = '4px 20px';
    btn.style.fontSize = '12px';
    btn.style.fontWeight = '500';
    btn.style.cursor = 'pointer';
    btn.style.background = '#f0f0f0';
    btn.style.border = '1px solid #999';
    btn.style.borderRadius = '3px';

    const close = (): void => overlay.remove();
    btn.addEventListener('click', close);
    overlay.addEventListener('click', (e: MouseEvent) => {
        if (e.target === overlay) close();
    });

    content.appendChild(msg);
    content.appendChild(btn);

    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    btn.focus();
}

/**
 * Обновляет текст в верхнем баннере ID (полный) и в шапке осциллографа (урезанный).
 * Урезанный формат: "ID: 00444444 DExS.SMFCB" (только серийный номер и тип устройства).
 */
export function updateIdBanner(idText: string): void {
    // 1. Обновляем основной баннер (полный ID)
    const idSpan = document.querySelector('.id-banner span');
    if (idSpan) {
        idSpan.textContent = idText;
    }

    // 2. Обновляем баннер в шапке осциллографа (урезанный ID)
    const oscIdBanner = document.querySelector('.osc-id-banner');
    if (oscIdBanner) {
        if (!idText || idText === '—') {
            oscIdBanner.textContent = 'Ожидание подключения...';
        } else {
            // Форматируем ID: оставляем только "ID: <серийный> <тип>"
            // Используем ту же логику, что и в parseDeviceIdString из report-data.ts
            let s = idText.trim();
            if (s.toUpperCase().startsWith('ID:')) {
                s = s.substring(3).trim();
            }
            const parts = s.split(/\s+/);
            const serial = parts[0] ?? '';
            const deviceType = parts[1] ?? '';
            
            if (serial && deviceType) {
                oscIdBanner.textContent = `ID: ${serial} ${deviceType}`;
            } else if (serial) {
                oscIdBanner.textContent = `ID: ${serial}`;
            } else {
                oscIdBanner.textContent = '—';
            }
        }
    }
}

/**
 * Закрывает модальное окно ID, если оно открыто
 */
export function closeIdModal(): void {
    const modal = document.querySelector('.id-modal-overlay');
    if (modal) modal.remove();
}

/**
 * Заполняет форму устройства данными из конфигурации
 */
export function populateDeviceForm(devConfig?: Record<string, string | string[] | undefined>): void {
    if (!devConfig) return;
    
    const mechanismInput = document.querySelector<HTMLInputElement>('.mechanism-input');
    const locationInput = document.querySelector<HTMLInputElement>('.location-input');
    const dateInput = document.querySelector<HTMLInputElement>('.date-input');

    if (mechanismInput && devConfig['Description'] !== undefined) {
        mechanismInput.value = String(devConfig['Description']);
    }
    if (locationInput && devConfig['Location'] !== undefined) {
        locationInput.value = String(devConfig['Location']);
    }
    if (dateInput && devConfig['Date'] !== undefined) {
        dateInput.value = String(devConfig['Date']);
    }
}
// ============================================================================
// Встроенный редактор INI-файла
// ============================================================================
/**
 * Открывает встроенный модальный редактор с содержимым INI-файла.
 * Возвращает промис: отредактированный текст при "Сохранить", или null при "Отмена"/Escape.
 */


export function openIniEditor(content: string, title: string): Promise<string | null> {
    const overlay = document.getElementById('iniEditorOverlay');
    const header = document.getElementById('iniEditorTitle');
    const container = document.getElementById('iniEditorContainer') as HTMLElement | null;
    const saveBtn = document.getElementById('iniEditorSave') as HTMLButtonElement | null;
    const cancelBtn = document.getElementById('iniEditorCancel') as HTMLButtonElement | null;
    
    if (!overlay || !container || !saveBtn || !cancelBtn) {
        return Promise.reject(new Error('Элементы редактора не найдены в DOM'));
    }
    
    if (header) header.textContent = title || 'Редактирование файла';
    
    // Создаём instance CodeMirror
    const editor = createIniEditor(container, content);
    
    overlay.classList.remove('hidden');
    // Фокус в редактор сразу после показа
    setTimeout(() => editor.focus(), 0);
    
    return new Promise<string | null>((resolve) => {
        let settled = false;
        
        const finish = (value: string | null): void => {
            if (settled) return;
            settled = true;
            overlay.classList.add('hidden');
            
            // Уничтожаем instance CodeMirror
            editor.destroy();
            
            saveBtn.removeEventListener('click', onSave);
            cancelBtn.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
            resolve(value);
        };
        
        const onSave = (): void => {
            finish(editor.getValue());
        };
        
        const onCancel = (): void => {
            finish(null);
        };
        
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.preventDefault();
                finish(null);
            } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                finish(editor.getValue());
            }
        };
        
        saveBtn.addEventListener('click', onSave);
        cancelBtn.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);
    });
}
