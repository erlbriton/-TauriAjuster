// src-tauri/src/state.rs
// Глобальное состояние приложения, доступное во всех Tauri-командах.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

/// Общее состояние последовательного порта:
/// - port: Mutex-защищённый опциональный порт (None — не открыт).
/// - reader_stop: личный флаг ТЕКУЩЕГО читающего потока.
///   Именно `Mutex<Option<Arc<AtomicBool>>>`, а не `Arc<AtomicBool>`:
///   при каждом новом открытии порта старый флаг «забирается» через take(),
///   а в состояние кладётся новый Arc. Старый поток держит свою копию Arc
///   и гарантированно не может быть «воскрешён» новым открытием.
pub struct SerialState {
    pub port: Mutex<Option<Box<dyn serialport::SerialPort>>>,
    pub reader_stop: Mutex<Option<Arc<AtomicBool>>>,
}

impl Default for SerialState {
    fn default() -> Self {
        Self {
            port: Mutex::new(None),
            reader_stop: Mutex::new(None),
        }
    }
}