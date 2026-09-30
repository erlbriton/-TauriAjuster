// src/ui/report-ui.ts
/**
 * UI для отчётов: окно создания, предпросмотр, сохранение .xlsx.
 * Не зависит от serial — готово к Tauri.
 */
import { collectReportData, collectCsvData } from '../core/report-data.js';
import { buildReportBlob } from '../core/excel-report.js';
import { buildCsvBlob } from '../core/csv-export.js';
import type { ReportData } from '../core/excel-report.js';
import { showToast } from './ui.js';


const LS_KEY_ORG = 'report:organization';
const LS_KEY_NUM = 'report:lastNumber';
const LS_KEY_AUTO = 'report:autoIncrement';
const DEFAULT_FILE_NAME = 'template.xlsx';
import { writeFile } from '@tauri-apps/plugin-fs';

interface ReportUIDeps {
    /** Возвращает appState для доступа к currentIniConfig */
    getAppState: () => { currentIniConfig: unknown };
    /** Возвращает fileStore (Map ключ -> {file, handle, ...}) */
    getFileStore: () => Map<string, { file: File; handle?: unknown }>;
    /** Возвращает экземпляр осциллографа (или null) */
    getOscilloscope?: () => {
        settings: { amplitudeMarkerTime: number | null };
        archive: { getRawAtTime: (id: string, t: number) => number | null; getValueAtTime: (id: string, t: number) => number | null };
        allChannels: Array<{ id: string; modbusReg?: string }>;
    } | null;
}

let deps: ReportUIDeps | null = null;
let lastGeneratedBlob: Blob | null = null;
let lastGeneratedData: ReportData | null = null;

export function initReportUI(uiDeps: ReportUIDeps): void {
    deps = uiDeps;

    // Кнопка 📋 (открыть окно создания отчёта)
    document.getElementById('clipboardBtn')?.addEventListener('click', () => {
        openCreateWindow();
    });

    // Кнопка 💾 в осциллографе → экспорт CSV (секция RAM, значения на момент маркера)
    window.addEventListener('oscilloscope-export-csv', () => {
        void exportCsv();
    });

    // Кнопка "Создать отчёт"
    document.getElementById('reportCreateBtn')?.addEventListener('click', () => {
        void createReport();
    });

    // Кнопка "Закрыть" в окне создания
    document.getElementById('reportCreateCloseBtn')?.addEventListener('click', () => {
        hideOverlay('reportCreateOverlay');
    });

    // Восстановить предыдущие значения
    restoreSavedValues();
}

function restoreSavedValues(): void {
    const org = localStorage.getItem(LS_KEY_ORG);
    const num = localStorage.getItem(LS_KEY_NUM);
    const auto = localStorage.getItem(LS_KEY_AUTO);
    const orgInput = document.getElementById('reportOrgInput') as HTMLInputElement | null;
    const numInput = document.getElementById('reportNumInput') as HTMLInputElement | null;
    const autoCheck = document.getElementById('reportAutoIncCheck') as HTMLInputElement | null;

    if (orgInput && org) orgInput.value = org;
    if (numInput && num) {
        // Показываем сохранённый номер как есть. Инкремент делается
        // не здесь, а в createReport — после успешной генерации отчёта,
        // чтобы номер увеличивался именно на использованных отчётах,
        // а не при каждом открытии окна и не при каждом перезапуске.
        numInput.value = num;
    }
    if (autoCheck && auto === '1') autoCheck.checked = true;
}

function openCreateWindow(): void {
    resetProgress();
    showOverlay('reportCreateOverlay');
    const orgInput = document.getElementById('reportOrgInput') as HTMLInputElement | null;
    setTimeout(() => orgInput?.focus(), 0);
}

function showOverlay(id: string): void {
    document.getElementById(id)?.classList.remove('hidden');
}

function hideOverlay(id: string): void {
    document.getElementById(id)?.classList.add('hidden');
}

function setStatus(text: string): void {
    const el = document.getElementById('reportStatus');
    if (el) el.textContent = text;
}

function setProgress(percent: number): void {
    const bar = document.getElementById('reportProgressBar');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function resetProgress(): void {
    setStatus('');
    setProgress(0);
}

function setButtonsLocked(locked: boolean): void {
    const createBtn = document.getElementById('reportCreateBtn') as HTMLButtonElement | null;
    const closeBtn = document.getElementById('reportCreateCloseBtn') as HTMLButtonElement | null;
    if (createBtn) createBtn.disabled = locked;
    if (closeBtn) closeBtn.disabled = locked;
}

async function createReport(): Promise<void> {
    if (!deps) return;

    const orgInput = document.getElementById('reportOrgInput') as HTMLInputElement | null;
    const numInput = document.getElementById('reportNumInput') as HTMLInputElement | null;
    const autoCheck = document.getElementById('reportAutoIncCheck') as HTMLInputElement | null;

    const organization = (orgInput?.value ?? '').trim() || 'ООО Интеллектуальные машины';
    const reportNumber = (numInput?.value ?? '1').trim() || '1';
    const autoInc = !!autoCheck?.checked;

    // Сохраняем настройки в localStorage.
    // LS_KEY_NUM здесь НЕ сохраняем: он будет обновлён после успешной
    // генерации отчёта — с учётом автоинкремента. Иначе при ошибке
    // генерации номер «сгорит» без создания отчёта.
    localStorage.setItem(LS_KEY_ORG, organization);
    localStorage.setItem(LS_KEY_AUTO, autoInc ? '1' : '0');

    setButtonsLocked(true);
    try {
        setStatus('Сбор данных отчёта...');
        setProgress(10);

        const data = await collectReportData({
            appState: deps.getAppState() as never,
            fileStore: deps.getFileStore(),
            organization,
            reportNumber,
        });

        setProgress(40);
        setStatus('Формирование файла xlsx...');

        const blob = await buildReportBlob(data);

        setProgress(100);
        setStatus('Готово.');

        lastGeneratedBlob = blob;
        lastGeneratedData = data;

        // Автоинкремент: если галочка стоит, сохраняем N+1 для следующего
        // отчёта и сразу обновляем поле ввода — при следующем открытии окна
        // (без перезапуска приложения) пользователь увидит увеличенный номер.
        // Если галочка снята — сохраняем использованный номер как есть.
        if (autoInc) {
            const nextNum = String((parseInt(reportNumber, 10) || 0) + 1);
            localStorage.setItem(LS_KEY_NUM, nextNum);
            if (numInput) numInput.value = nextNum;
        } else {
            localStorage.setItem(LS_KEY_NUM, reportNumber);
        }

        // Закрываем окно создания и сразу сохраняем файл на диск.
        // Промежуточное окно предпросмотра убрано: пользователь получает
        // только короткое уведомление об успешной записи (showToast).
        setTimeout(() => {
            hideOverlay('reportCreateOverlay');
            resetProgress();
            void saveReport();
        }, 250);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus('Ошибка: ' + msg);
        setProgress(0);
        console.error('[report-ui] createReport error:', err);
    } finally {
        setButtonsLocked(false);
    }
}

async function saveReport(): Promise<void> {
    if (!lastGeneratedBlob) {
        setStatus('Нет данных для сохранения.');
        return;
    }

    // Генерируем имя файла по шаблону otchet_<серийный>_<дата_время>.xlsx
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const dateStr = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const serial = lastGeneratedData?.serialNumber || 'unknown';
    const fileName = `otchet_${serial}_${dateStr}.xlsx`;

    try {
        const { invoke } = await import('@tauri-apps/api/core');
      //  const { writeFile } = await import('@tauri-apps/plugin-fs');

        // Путь к папке XLT рядом с exe (создаётся автоматически).
        const xltDir = await invoke<string>('ensure_xlt_dir');
        const fullPath = `${xltDir}/${fileName}`;

        // Blob → Uint8Array<ArrayBuffer>, чтобы writeFile принял его без ошибок типов.
        const buffer = await lastGeneratedBlob.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        await writeFile(fullPath, bytes);

        showToast(`Файл сохранён: ${fileName}`);
        console.log(`[report-ui] XLSX сохранён: ${fullPath}`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[report-ui] Ошибка сохранения XLSX:', err);
        showToast(`Ошибка сохранения: ${msg}`);
    }
}
/**
 * Экспорт CSV-отчёта: секция RAM, значения на момент стопа/маркера.
 * Берёт те же organization и reportNumber, что и обычный отчёт (из localStorage).
 */
async function exportCsv(): Promise<void> {
    if (!deps) return;

    const org = localStorage.getItem(LS_KEY_ORG) ?? 'ООО Интеллектуальные машины';
    const num = localStorage.getItem(LS_KEY_NUM) ?? '1';

    const osc = deps.getOscilloscope?.() ?? null;
    if (!osc) {
        alert('Осциллограф не инициализирован.');
        return;
    }

    const markerTime = osc.settings.amplitudeMarkerTime;
    if (markerTime === null) {
        alert('Сначала установите маркер измерения величины сигнала.');
        return;
    }

    try {
        const data = await collectCsvData(
            {
                appState: deps.getAppState() as never,
                fileStore: deps.getFileStore(),
                organization: org,
                reportNumber: num,
            },
            markerTime,
            osc.archive,
            osc.allChannels,
        );

                const blob = buildCsvBlob(data);

        // Имя файла по шаблону: otchet_<серийный>_<дата_время>.csv
        const now = new Date();
        const pad = (n: number): string => String(n).padStart(2, '0');
        const dateStr = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${pad(now.getFullYear())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
        const serial = data.serialNumber || 'unknown';
        const fileName = `otchet_${serial}_${dateStr}.csv`;

        const { invoke } = await import('@tauri-apps/api/core');
      //  const { writeFile } = await import('@tauri-apps/plugin-fs');

        // Путь к папке XLT рядом с exe (создаётся автоматически).
        const xltDir = await invoke<string>('ensure_xlt_dir');
        const fullPath = `${xltDir}/${fileName}`;

        // Blob → Uint8Array<ArrayBuffer>, чтобы writeFile принял его без ошибок типов.
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        await writeFile(fullPath, bytes);

        console.log(`[report-ui] CSV сохранён: ${fullPath}`);
        showToast(`Файл сохранён: ${fileName}`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[report-ui] exportCsv error:', msg);
        alert('Ошибка при экспорте CSV: ' + msg);
    }
}
