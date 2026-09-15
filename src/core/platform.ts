// src/core/platform.ts

/**
 * Определение платформы для UI-решений (например, доступности открытия папки).
 *
 * Бизнес-логика эту функцию НЕ использует — она остаётся платформо-независимой
 * и готовой к Tauri, где платформы определяются на стороне Rust.
 */

export function isLinux(): boolean {
    const ua = navigator.userAgent.toLowerCase();
    const platform = (navigator.platform || '').toLowerCase();
    return ua.includes('linux') || platform.includes('linux');
}

export function supportsDirectoryPicker(): boolean {
    return isLinux() && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/** Работаем ли мы внутри нативной оболочки (Tauri) */
export function isNativeApp(): boolean {
    return typeof (window as unknown as { __TAURI__?: unknown }).__TAURI__ !== 'undefined';
}