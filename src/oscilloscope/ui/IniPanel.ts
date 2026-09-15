// src/ui/IniPanel.ts

import { IniPanelRenderer } from './IniPanelRenderer';

export interface IniFileItem {
    id: string;
    name: string;
    size: number;
    lastModified: number;
    file?: File;
    content: string;
}

export class IniPanel {
    private container: HTMLElement;
    private files: IniFileItem[] = [];
    private selectedFileId: string | null = null;
    private onFileSelectCallback?: (file: IniFileItem) => void;
    private fileInput: HTMLInputElement;

    constructor(container: HTMLElement) {
        this.container = container;
        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.ini, .txt, *';
        this.fileInput.multiple = true;
        this.fileInput.style.display = 'none';
        document.body.appendChild(this.fileInput);

        this.fileInput.addEventListener('change', async (e) => {
            const fileList = (e.target as HTMLInputElement).files;
            if (fileList && fileList.length > 0) {
                await this.addFiles(Array.from(fileList));
            }
            this.fileInput.value = '';
        });
    }

    // public selectFileById(id: string): void {//////////////////////////////////////////////
    //     const file = this.files.find(f => f.id === id);
    //     if (file) {
    //         this.selectedFileId = id;
    //         this.render();
    //         if (this.onFileSelectCallback) {
    //             this.onFileSelectCallback(file);
    //         }
    //     }
    // }

    // public setExternalFiles(files: IniFileItem[]): void {
    //     this.files = files;
    //     if (this.files.length > 0 && !this.selectedFileId) {
    //         this.selectedFileId = this.files[0].id;
    //     }
    //     this.render();
    //     const selected = this.getSelectedFile();
    //     if (selected && this.onFileSelectCallback) {
    //         this.onFileSelectCallback(selected);
    //     }
    // }///////////////////////////////////////////////////////////////////////

    /**/////////////////////////////////////////////////////////////////////////////////////////////////////////
//  * Программный выбор файла в панели.
//  * Только подсвечивает файл в UI.
//  * НЕ вызывает onFileSelectCallback.
//  */
public selectFileById(id: string): void {
    const file = this.files.find(f => f.id === id);

    if (!file) {
        return;
    }

    this.selectedFileId = id;
    this.render();
}

/**
 * Программное обновление списка файлов из внешнего проекта.
 * Только обновляет список и выделяет текущий файл.
 * НЕ вызывает onFileSelectCallback.
 */
public setExternalFiles(files: IniFileItem[]): void {
    this.files = files;

    if (this.files.length > 0 && !this.selectedFileId) {
        this.selectedFileId = this.files[0].id;
    }

    this.render();
}

    public openFilePicker(): void {
        this.fileInput.click();
    }

    public addVirtualFile(name: string, content: string): void {
        const item: IniFileItem = {
            id: `virtual-${name}-${Date.now()}`,
            name,
            size: new Blob([content]).size,
            lastModified: Date.now(),
            content
        };
        this.files.push(item);
        if (!this.selectedFileId) {
            this.selectedFileId = item.id;
        }
        this.render();
        if (this.onFileSelectCallback && this.selectedFileId === item.id) {
            this.onFileSelectCallback(item);
        }
    }

    public async addFiles(fileList: FileList | File[]): Promise<void> {
        const filesArray = Array.from(fileList);
        const newFiles: IniFileItem[] = [];

        for (const file of filesArray) {
            try {
                const buffer = await file.arrayBuffer();
                let content: string;
                
                try {
                    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
                } catch (e) {
                    try {
                        content = new TextDecoder('windows-1251', { fatal: true }).decode(buffer);
                    } catch (e2) {
                        content = new TextDecoder('utf-8').decode(buffer);
                    }
                }

                const item: IniFileItem = {
                    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).substring(2, 7)}`,
                    name: file.name,
                    size: file.size,
                    lastModified: file.lastModified,
                    file,
                    content
                };
                newFiles.push(item);
            } catch (err) {
                console.error('Failed to read file:', file.name, err);
            }
        }

        if (newFiles.length > 0) {
            this.files.push(...newFiles);
            const lastAdded = newFiles[newFiles.length - 1];
            this.selectedFileId = lastAdded.id;
            this.render();
            if (this.onFileSelectCallback) {
                this.onFileSelectCallback(lastAdded);
            }
        }
    }

    public clearFiles(): void {
        this.files = [];
        this.selectedFileId = null;
        this.render();
    }

    public removeFile(id: string): void {
        this.files = this.files.filter(f => f.id !== id);
        if (this.selectedFileId === id) {
            this.selectedFileId = this.files.length > 0 ? this.files[this.files.length - 1].id : null;
        }
        this.render();
        if (this.onFileSelectCallback && this.selectedFileId) {
            const sel = this.getSelectedFile();
            if (sel) this.onFileSelectCallback(sel);
        }
    }

    public onFileSelect(cb: (file: IniFileItem) => void): void {
        this.onFileSelectCallback = cb;
    }

    public getSelectedFile(): IniFileItem | null {
        return this.files.find(f => f.id === this.selectedFileId) || null;
    }

    public render(): void {
        this.container.innerHTML = IniPanelRenderer.renderTemplate(this.files, this.selectedFileId);

        this.container.querySelector('#ini-add-btn')?.addEventListener('click', () => this.openFilePicker());
        this.container.querySelector('#ini-empty-add-btn')?.addEventListener('click', () => this.openFilePicker());
        this.container.querySelector('#ini-clear-btn')?.addEventListener('click', () => this.clearFiles());

        const bodyElem = this.container.querySelector('.ini-panel-body');
        if (bodyElem) {
            bodyElem.addEventListener('dragover', (e) => {
                e.preventDefault();
                (bodyElem as HTMLElement).style.borderColor = '#38bdf8';
            });
            bodyElem.addEventListener('dragleave', () => {
                (bodyElem as HTMLElement).style.borderColor = '';
            });
            bodyElem.addEventListener('drop', async (e) => {
                const dragEvent = e as DragEvent;
                dragEvent.preventDefault();
                (bodyElem as HTMLElement).style.borderColor = '';
                if (dragEvent.dataTransfer && dragEvent.dataTransfer.files.length > 0) {
                    await this.addFiles(dragEvent.dataTransfer.files);
                }
            });
        }

        this.container.querySelectorAll('.ini-file-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const target = e.target as HTMLElement;
                if (target.classList.contains('ini-file-remove-btn') || target.closest('.ini-file-remove-btn')) return;
                const id = item.getAttribute('data-id');
                if (id) {
                    this.selectedFileId = id;
                    this.render();
                    const sel = this.getSelectedFile();
                    if (sel && this.onFileSelectCallback) this.onFileSelectCallback(sel);
                }
            });
        });

        this.container.querySelectorAll('.ini-file-remove-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = (btn as HTMLElement).getAttribute('data-remove-id');
                if (id) this.removeFile(id);
            });
        });
    }
}
