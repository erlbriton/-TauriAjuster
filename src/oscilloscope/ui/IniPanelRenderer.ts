// src/ui/IniPanelRenderer.ts

import { IniFileItem } from './IniPanel';

export class IniPanelRenderer {
    public static formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    public static renderTemplate(files: IniFileItem[], selectedFileId: string | null): string {
        return `
            <div class="ini-panel-header">
                <div class="ini-panel-title">
                    <span>📑 Выбранные INI файлы</span>
                    <span class="ini-count-badge">${files.length} файлов</span>
                </div>
            </div>

            <div class="ini-panel-body">
                <div class="ini-file-list-container">
                    ${files.length === 0 ? `
                        <div class="ini-empty-state">
                            <div style="font-size: 44px; margin-bottom: 16px;">📂</div>
                            <div style="font-weight: 600; font-size: 15px; margin-bottom: 8px; color: #f1f5f9;">Список файлов пуст</div>
                            <div style="font-size: 13px; color: #94a3b8; max-width: 320px; line-height: 1.5; margin: 0 auto 20px;">
                                Ожидание загрузки файлов из основного проекта...
                            </div>
                        </div>
                    ` : `
                        <div class="ini-file-list">
                            ${files.map((f, idx) => `
                                <div class="ini-file-item ${f.id === selectedFileId ? 'selected' : ''}" data-id="${f.id}">
                                    <div class="ini-file-index">${idx + 1}</div>
                                    <div class="ini-file-icon">📄</div>
                                    <div class="ini-file-info">
                                        <div class="ini-file-name" title="${f.name}">${f.name}</div>
                                        <div class="ini-file-meta">${this.formatBytes(f.size)} • ${new Date(f.lastModified).toLocaleTimeString()}</div>
                                    </div>
                                    ${f.id === selectedFileId ? '<div class="ini-file-active-badge">Выбран</div>' : ''}
                                    <button class="ini-file-remove-btn" data-remove-id="${f.id}" title="Удалить из списка">✕</button>
                                </div>
                            `).join('')}
                        </div>
                    `}
                </div>
            </div>
        `;
    }
}
