// oscilloscope/ui/SearchPanel.ts

/** Минимальный контракт элемента поиска (id + имя). */
export interface SearchItem {
    id: string;
    name: string;
}

/**
 * Плавающая панель поиска параметра с живыми подсказками.
 *  - Поиск по номеру: буква "p" и ведущие нули необязательны (35 = 0035 = p0035).
 *  - Поиск по имени: подстрока, без учёта регистра; все похожие имена
 *    (T1000, T1001, ...) показываются списком для выбора.
 *  - Клавиши: ↑/↓ — выбор, Enter — подтвердить, Esc — закрыть.
 */
export class SearchPanel {
    private readonly root: HTMLDivElement;
    private readonly input: HTMLInputElement;
    private readonly list: HTMLDivElement;
    private items: SearchItem[] = [];
    private suggestions: SearchItem[] = [];
    private activeIndex = -1;
    private isOpen = false;

    public onSelect?: (item: SearchItem) => void;

    constructor() {
        this.root = document.createElement('div');
        this.root.style.position = 'fixed';
        this.root.style.top = '70px';
        this.root.style.left = '50%';
        this.root.style.transform = 'translateX(-50%)';
        this.root.style.zIndex = '10000';
        this.root.style.width = '340px';
        this.root.style.background = '#1a1a1d';
        this.root.style.border = '1px solid #00d2ff';
        this.root.style.borderRadius = '6px';
        this.root.style.boxShadow = '0 8px 24px rgba(0,0,0,0.6)';
        this.root.style.display = 'none';
        this.root.style.flexDirection = 'column';

        this.input = document.createElement('input');
        this.input.placeholder = 'Номер (p0035 / 0035 / 35) или имя (FS+)…';
        this.input.style.margin = '8px';
        this.input.style.padding = '6px 8px';
        this.input.style.background = '#0f0f11';
        this.input.style.color = '#e0e0e5';
        this.input.style.border = '1px solid #333';
        this.input.style.borderRadius = '4px';
        this.input.style.fontFamily = 'monospace';
        this.input.style.fontSize = '13px';
        this.input.style.outline = 'none';

        this.list = document.createElement('div');
        this.list.style.maxHeight = '260px';
        this.list.style.overflowY = 'auto';
        this.list.style.borderTop = '1px solid #333';

        this.root.append(this.input, this.list);
        document.body.appendChild(this.root);

        this.input.addEventListener('input', () => this.refresh());
        this.input.addEventListener('keydown', (e) => this.onKeyDown(e));
        document.addEventListener('mousedown', (e) => {
            if (this.isOpen && !this.root.contains(e.target as Node)) this.close();
        });
    }

    public open(items: SearchItem[]): void {
        this.items = items;
        this.suggestions = [];
        this.activeIndex = -1;
        this.input.value = '';
        this.list.innerHTML = '';
        this.root.style.display = 'flex';
        this.isOpen = true;
        this.input.focus();
    }

    public close(): void {
        this.root.style.display = 'none';
        this.isOpen = false;
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (e.key === 'Escape') { this.close(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); this.moveActive(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this.moveActive(-1); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            const item = this.activeIndex >= 0 ? this.suggestions[this.activeIndex] : this.suggestions[0];
            if (item) this.pick(item);
        }
    }

        private moveActive(delta: number): void {
        if (this.suggestions.length === 0) return;
        this.activeIndex = Math.min(this.suggestions.length - 1, Math.max(0, this.activeIndex + delta));
        this.updateHighlight();
    }

    private pick(item: SearchItem): void {
        this.close();
        if (this.onSelect) this.onSelect(item);
    }

    private refresh(): void {
        this.suggestions = this.matchItems(this.input.value).slice(0, 30);
        this.activeIndex = this.suggestions.length > 0 ? 0 : -1;
        this.renderList();
    }

    /** Нормализация номера: убирает букву p и ведущие нули (p0035 -> 35). */
    private static normId(raw: string): string {
        const s = raw.toLowerCase().replace(/^p/, '');
        return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s;
    }

    private matchItems(query: string): SearchItem[] {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        const qId = SearchPanel.normId(q);

        const exact: SearchItem[] = [];
        const prefix: SearchItem[] = [];

        for (const item of this.items) {
            const idN = SearchPanel.normId(item.id);
            const nameL = item.name.toLowerCase();

            // Только точное совпадение или префикс: N-й набранный символ
            // всегда является N-м символом имени/номера.
            if (idN === qId || nameL === q) { exact.push(item); continue; }
            if (idN.startsWith(qId) || nameL.startsWith(q)) { prefix.push(item); continue; }
        }
        return [...exact, ...prefix];
    }

    private rowEls: HTMLDivElement[] = [];

    /** Подсветка активного пункта без пересборки списка. */
    private updateHighlight(): void {
        this.rowEls.forEach((el, i) => {
            el.style.background = i === this.activeIndex ? '#00d2ff' : 'transparent';
            el.style.color = i === this.activeIndex ? '#0f0f11' : '#c8c8cd';
        });
        const active = this.rowEls[this.activeIndex];
        if (active) active.scrollIntoView({ block: 'nearest' });
    }

    private renderList(): void {
        this.list.innerHTML = '';
        this.rowEls = [];
        const q = this.input.value.trim();
        if (!q) return;

        if (this.suggestions.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'Ничего не найдено';
            empty.style.padding = '8px 12px';
            empty.style.color = '#777';
            empty.style.fontSize = '12px';
            this.list.appendChild(empty);
            return;
        }

        this.suggestions.forEach((item, i) => {
            const row = document.createElement('div');
            row.textContent = `${item.id}  ·  ${item.name}`;
            row.style.padding = '6px 12px';
            row.style.cursor = 'pointer';
            row.style.fontFamily = 'monospace';
            row.style.fontSize = '12px';
            row.addEventListener('mouseenter', () => { this.activeIndex = i; this.updateHighlight(); });
            row.addEventListener('click', (e) => { e.stopPropagation(); this.pick(item); });
            this.list.appendChild(row);
            this.rowEls.push(row);
        });
        this.updateHighlight();
    }
}