// oscilloscope/index.ts
// Главный файл экспорта модуля Осциллографа для внедрения в сторонние TypeScript-проекты

export { Oscilloscope } from './Oscilloscope';
export { Channel, type ChannelConfig } from './core/Channel';
export { Settings } from './config/Settings';
export { Archive } from './core/Archive';
export { Recorder } from './core/Recorder';
export { Serial } from './comm/Serial';
//export { IniParser, type ParsedRamParam, type ParsedIniResult } from './core/IniParser';
export { type IniFileItem } from './ui/IniPanel';

// Импорт стилей модуля
import './styles/oscilloscope.css';
