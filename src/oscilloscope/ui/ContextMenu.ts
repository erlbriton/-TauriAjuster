// src/ui/ContextMenu.ts

export interface ContextMenuItem {
    label: string;
    icon?: string;
    danger?: boolean;
    onClick: () => void;
}

export class ContextMenu {
    private static instance: ContextMenu | null = null;
    private readonly menuElement: HTMLDivElement;

    private constructor() {
        this.menuElement = document.createElement('div');
        this.menuElement.className = 'custom-context-menu';
        this.menuElement.style.display = 'none';
        document.body.appendChild(this.menuElement);

        document.addEventListener('click', (e) => {
            if (!this.menuElement.contains(e.target as Node)) {
                this.hide();
            }
        });

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.hide();
        });

        window.addEventListener('scroll', () => this.hide(), true);
        window.addEventListener('resize', () => this.hide());
    }

    public static getInstance(): ContextMenu {
        if (!ContextMenu.instance) {
            ContextMenu.instance = new ContextMenu();
        }
        return ContextMenu.instance;
    }

    public show(x: number, y: number, items: ContextMenuItem[]): void {
        this.menuElement.innerHTML = '';

        items.forEach(item => {
            const btn = document.createElement('button');
            btn.className = `context-menu-item ${item.danger ? 'danger' : ''}`;

            if (item.icon) {
                const iconSpan = document.createElement('span');
                iconSpan.className = 'context-menu-icon';
                iconSpan.innerHTML = item.icon;
                btn.appendChild(iconSpan);
            }

            const labelSpan = document.createElement('span');
            labelSpan.textContent = item.label;
            btn.appendChild(labelSpan);

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.hide();
                item.onClick();
            });

            this.menuElement.appendChild(btn);
        });

        this.menuElement.style.display = 'flex';

        const menuRect = this.menuElement.getBoundingClientRect();
        const winWidth = window.innerWidth;
        const winHeight = window.innerHeight;

        let left = x;
        let top = y;

        if (x + menuRect.width > winWidth) {
            left = winWidth - menuRect.width - 8;
        }
        if (y + menuRect.height > winHeight) {
            top = winHeight - menuRect.height - 8;
        }

        this.menuElement.style.left = `${Math.max(4, left)}px`;
        this.menuElement.style.top = `${Math.max(4, top)}px`;
    }

    public hide(): void {
        this.menuElement.style.display = 'none';
    }
}
