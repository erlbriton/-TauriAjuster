// src/ui/confirm-dialog.ts
// UI-слой: построение диалоговых окон.
// В нативном приложении этот модуль будет заменён на нативные диалоги —
// логика (table-editor) при этом не меняется, т.к. только вызывает эти функции.

/**
 * Универсальное окно подтверждения с большим зелёным "?".
 * Возвращает true при "Yes", false при "No"/закрытии.
 * Стили — инлайн, чтобы не зависеть от кэша CSS.
 */
export function showConfirmDialog(message: string): Promise<boolean> {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.background = 'rgba(0, 0, 0, 0.35)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.zIndex = '10000';

        const dialog = document.createElement('div');
        dialog.style.background = '#f0f0f0';
        dialog.style.border = '1px solid #888';
        dialog.style.boxShadow = '0 4px 16px rgba(0,0,0,0.4)';
        dialog.style.width = 'auto';
        dialog.style.minWidth = '380px';
        dialog.style.fontFamily = 'Segoe UI, Arial, sans-serif';
        dialog.style.color = '#000';

        // Заголовок окна + крестик
        const titleBar = document.createElement('div');
        titleBar.style.display = 'flex';
        titleBar.style.justifyContent = 'space-between';
        titleBar.style.alignItems = 'center';
        titleBar.style.padding = '6px 10px';
        titleBar.style.background = '#fff';
        titleBar.style.borderBottom = '1px solid #ddd';
        const titleText = document.createElement('span');
        titleText.textContent = 'Confirm';
        titleText.style.fontWeight = '600';
        const closeX = document.createElement('span');
        closeX.textContent = '×';
        closeX.style.cursor = 'pointer';
        closeX.style.fontWeight = '700';
        titleBar.appendChild(titleText);
        titleBar.appendChild(closeX);

        // Контент: зелёная иконка "?" + текст
        const content = document.createElement('div');
        content.style.display = 'flex';
        content.style.alignItems = 'center';
        content.style.gap = '14px';
        content.style.padding = '20px 16px';

        const icon = document.createElement('div');
        icon.textContent = '?';
        icon.style.width = '44px';
        icon.style.height = '44px';
        icon.style.borderRadius = '50%';
        icon.style.background = 'radial-gradient(circle at 35% 30%, #4dd24d, #009000)';
        icon.style.color = '#fff';
        icon.style.fontWeight = '700';
        icon.style.fontSize = '28px';
        icon.style.display = 'flex';
        icon.style.alignItems = 'center';
        icon.style.justifyContent = 'center';
        icon.style.flex = '0 0 auto';

        const text = document.createElement('div');
        text.textContent = message;
        text.style.fontSize = '14px';
        text.style.whiteSpace = 'nowrap';

        content.appendChild(icon);
        content.appendChild(text);

        // Кнопки Yes / No
        const buttons = document.createElement('div');
        buttons.style.display = 'flex';
        buttons.style.justifyContent = 'center';
        buttons.style.gap = '16px';
        buttons.style.padding = '0 16px 18px';

        const mkBtn = (label: string): HTMLButtonElement => {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.minWidth = '80px';
            b.style.padding = '5px 12px';
            b.style.fontSize = '14px';
            return b;
        };
        const yesBtn = mkBtn('Yes');
        const noBtn = mkBtn('No');
        buttons.appendChild(yesBtn);
        buttons.appendChild(noBtn);

        dialog.appendChild(titleBar);
        dialog.appendChild(content);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const close = (result: boolean): void => {
            overlay.remove();
            resolve(result);
        };

        yesBtn.addEventListener('click', () => close(true));
        noBtn.addEventListener('click', () => close(false));
        closeX.addEventListener('click', () => close(false));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(false);
        });
    });
}

/** Окно "Копировать параметры базы в контроллер?" */
export function showCopyBaseConfirm(): Promise<boolean> {
    return showConfirmDialog('Копировать параметры базы в контроллер?');
}

/** Окно "Копировать параметры контроллера в базу?" */
export function showCopyControllerConfirm(): Promise<boolean> {
    return showConfirmDialog('Копировать параметры контроллера в базу?');
}

/**
 * Окно со списком параметров, которые не записались в контроллер.
 * Если список длинный — включается скроллинг. Одна кнопка OK.
 */
export function showFailedParamsList(items: { id: string; name: string }[]): void {
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0, 0, 0, 0.35)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '10000';

    const dialog = document.createElement('div');
    dialog.style.background = '#f0f0f0';
    dialog.style.border = '1px solid #888';
    dialog.style.boxShadow = '0 4px 16px rgba(0,0,0,0.4)';
    dialog.style.width = '440px';
    dialog.style.fontFamily = 'Segoe UI, Arial, sans-serif';
    dialog.style.color = '#000';

    const titleBar = document.createElement('div');
    titleBar.textContent = 'Не записались параметры';
    titleBar.style.padding = '6px 10px';
    titleBar.style.background = '#fff';
    titleBar.style.borderBottom = '1px solid #ddd';
    titleBar.style.fontWeight = '600';

    // Скроллируемый список
    const list = document.createElement('div');
    list.style.margin = '14px 12px';
    list.style.maxHeight = '240px';
    list.style.overflowY = 'auto';
    list.style.background = '#fff';
    list.style.border = '1px solid #ccc';
    list.style.padding = '8px 10px';
    list.style.fontSize = '13px';
    list.style.lineHeight = '1.6';

    for (const item of items) {
        const row = document.createElement('div');
        row.textContent = `${item.id}  ${item.name}`;
        row.style.whiteSpace = 'nowrap';
        list.appendChild(row);
    }

    const buttons = document.createElement('div');
    buttons.style.display = 'flex';
    buttons.style.justifyContent = 'center';
    buttons.style.padding = '0 16px 16px';
    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    okBtn.style.minWidth = '80px';
    okBtn.style.padding = '5px 12px';
    buttons.appendChild(okBtn);

    dialog.appendChild(titleBar);
    dialog.appendChild(list);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = (): void => overlay.remove();
    okBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
}

/**
 * Окно ввода нового адреса устройства в сети Modbus.
 * Возвращает адрес (1–247) при "Применить"/Enter, null при отмене/закрытии.
 * Принимает десятичную ("5") или шестнадцатеричную ("x05") форму.
 */
export function showAddressDialog(currentAddr: number): Promise<number | null> {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.background = 'rgba(0, 0, 0, 0.35)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.zIndex = '10000';

        const dialog = document.createElement('div');
        dialog.style.background = '#f0f0f0';
        dialog.style.border = '1px solid #888';
        dialog.style.boxShadow = '0 4px 16px rgba(0,0,0,0.4)';
        dialog.style.width = '340px';
        dialog.style.fontFamily = 'Segoe UI, Arial, sans-serif';
        dialog.style.color = '#000';

        // Заголовок + крестик
        const titleBar = document.createElement('div');
        titleBar.style.display = 'flex';
        titleBar.style.justifyContent = 'space-between';
        titleBar.style.alignItems = 'center';
        titleBar.style.padding = '6px 10px';
        titleBar.style.background = '#fff';
        titleBar.style.borderBottom = '1px solid #ddd';
        const titleText = document.createElement('span');
        titleText.textContent = 'Адрес устройства в сети Modbus';
        titleText.style.fontWeight = '600';
        const closeX = document.createElement('span');
        closeX.textContent = '×';
        closeX.style.cursor = 'pointer';
        closeX.style.fontWeight = '700';
        titleBar.appendChild(titleText);
        titleBar.appendChild(closeX);

        // Контент: подпись + поле ввода + строка ошибки
        const content = document.createElement('div');
        content.style.padding = '16px 16px 8px';
        content.style.display = 'flex';
        content.style.flexDirection = 'column';
        content.style.gap = '8px';

        const label = document.createElement('div');
        label.textContent = 'Новый адрес (1–247, можно в формате x0A):';
        label.style.fontSize = '13px';

        const input = document.createElement('input');
        input.type = 'text';
        input.value = 'x' + currentAddr.toString(16).toUpperCase().padStart(2, '0');
        input.style.padding = '4px 8px';
        input.style.fontSize = '14px';

        const err = document.createElement('div');
        err.style.fontSize = '12px';
        err.style.color = '#c00000';
        err.style.minHeight = '16px';

        content.appendChild(label);
        content.appendChild(input);
        content.appendChild(err);

        // Кнопки
        const buttons = document.createElement('div');
        buttons.style.display = 'flex';
        buttons.style.justifyContent = 'center';
        buttons.style.gap = '16px';
        buttons.style.padding = '0 16px 16px';

        const mkBtn = (lbl: string): HTMLButtonElement => {
            const b = document.createElement('button');
            b.textContent = lbl;
            b.style.minWidth = '90px';
            b.style.padding = '5px 12px';
            b.style.fontSize = '14px';
            return b;
        };
        const applyBtn = mkBtn('Применить');
        const cancelBtn = mkBtn('Отмена');
        buttons.appendChild(applyBtn);
        buttons.appendChild(cancelBtn);

        dialog.appendChild(titleBar);
        dialog.appendChild(content);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const close = (result: number | null): void => {
            overlay.remove();
            resolve(result);
        };

        const parseAddr = (raw: string): number | null => {
            const s = raw.trim();
            if (!s) return null;
            let n: number;
            if (/^x[0-9a-fA-F]+$/.test(s)) {
                n = parseInt(s.substring(1), 16);
            } else if (/^\d+$/.test(s)) {
                n = parseInt(s, 10);
            } else {
                return null;
            }
            if (isNaN(n) || n < 1 || n > 247) return null;
            return n;
        };

        const apply = (): void => {
            const n = parseAddr(input.value);
            if (n === null) {
                err.textContent = 'Неверный адрес. Пример: 5 или x05 (диапазон 1–247).';
                input.focus();
                return;
            }
            close(n);
        };

        applyBtn.addEventListener('click', apply);
        cancelBtn.addEventListener('click', () => close(null));
        closeX.addEventListener('click', () => close(null));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(null);
        });
        // Enter (в т.ч. на дополнительной клавиатуре) = Применить, Escape = Отмена
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                apply();
            } else if (e.key === 'Escape') {
                close(null);
            }
        });

        setTimeout(() => {
            input.focus();
            input.select();
        }, 0);
    });
}