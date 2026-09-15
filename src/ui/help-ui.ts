// src/ui/help-ui.ts

/**
 * Кнопка Help (книжка) и выпадающее меню "Помощь" / "О программе".
 */

/** Универсальное информационное окно в стиле программы */
function showInfoWindow(title: string, text: string): void {
    const existing = document.querySelector('.help-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'help-modal-overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0, 0, 0, 0.25)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '10000';

    const modal = document.createElement('div');
    modal.style.background = '#ffffff';
    modal.style.border = '2px solid #888';
    modal.style.borderRadius = '5px';
    modal.style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)';
    modal.style.minWidth = '320px';
    modal.style.maxWidth = '520px';
    modal.style.overflow = 'hidden';
    modal.style.fontFamily = 'Segoe UI, Arial, sans-serif';
    modal.style.color = '#333';

    const header = document.createElement('div');
    header.style.background = 'linear-gradient(to bottom, #f0f0f0, #e0e0e0)';
    header.style.borderBottom = '1px solid #999';
    header.style.padding = '8px 12px';
    header.style.fontWeight = '600';
    header.style.color = '#555';
    header.textContent = title;

    const content = document.createElement('div');
    content.style.padding = '14px 16px';
    content.style.fontSize = '13px';
    content.style.lineHeight = '1.5';
    content.style.whiteSpace = 'pre-line';
    content.textContent = text;

    const footer = document.createElement('div');
    footer.style.padding = '10px 16px';
    footer.style.textAlign = 'center';
    const btn = document.createElement('button');
    btn.textContent = 'OK';
    btn.style.padding = '4px 24px';
    btn.style.fontSize = '12px';
    btn.style.border = '1px solid #999';
    btn.style.borderRadius = '3px';
    btn.style.background = '#f0f0f0';
    btn.style.cursor = 'pointer';
    footer.appendChild(btn);

    const close = (): void => overlay.remove();
    btn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });

    modal.appendChild(header);
    modal.appendChild(content);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    btn.focus();
}

/** Окно "О программе" */
export function showAboutWindow(): void {
    showInfoWindow(
        'О программе',
        'WEB Ajuster v0.1\ninfo@intmash.ru   www.intmash.ru\nБердск 2026',
    );
}

/** Пункт "Помощь": открывает справку в новой вкладке браузера */
export function showHelpWindow(): void {
    window.open(import.meta.env.BASE_URL + 'help/index.html', '_blank');
}

/** Привязка обработчиков к кнопке Help и её меню */
export function initHelpUI(): void {
    const helpMainBtn = document.getElementById('helpMainBtn');
    const helpDropdownBtn = document.getElementById('helpDropdownBtn');
    const helpMenu = document.getElementById('helpMenu');

    if (!helpDropdownBtn || !helpMenu) return;

    // Открытие/закрытие меню по клику на треугольничек
    helpDropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        helpMenu.classList.toggle('show');
    });

    // Закрытие по клику вне меню
    document.addEventListener('click', (e) => {
        if (
            helpMenu.classList.contains('show') &&
            !helpMenu.contains(e.target as Node) &&
            e.target !== helpDropdownBtn
        ) {
            helpMenu.classList.remove('show');
        }
    });

    // Закрытие по Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') helpMenu.classList.remove('show');
    });

    // Основная кнопка (книжка) — открывает "Помощь"
    helpMainBtn?.addEventListener('click', () => showHelpWindow());

    // Пункты меню
    helpMenu.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const action = target.getAttribute('data-action');
        if (!action) return;
        helpMenu.classList.remove('show');
        if (action === 'help') showHelpWindow();
        else if (action === 'about') showAboutWindow();
    });
}