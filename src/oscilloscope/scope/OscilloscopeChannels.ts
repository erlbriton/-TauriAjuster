// src/oscilloscope/scope/OscilloscopeChannels.ts
// ============================================================================
// Каналы: функции, вынесенные из класса Oscilloscope.
// Пока только setChannels (проверена экспериментом в том же файле).
// ============================================================================

import type { Oscilloscope } from "../Oscilloscope";
import { Channel } from "../core/Channel.js";
import type { ChannelConfig } from "../core/Channel.js";
import type { IniFileItem } from "../ui/IniPanel";
import {
  IniParser as CoreIniParser,
  IniConfig,
  iniParamsToChannelConfigs,
} from "../../core/ini/index.js";
import {
  renderVisibleChannels,
  syncViewPositions,
} from "./OscilloscopeRenderer";
import {
  updateGraphColumnOffset as canvasUpdateOffset,
} from "./OscilloscopeCanvas";

export async function setChannels(osc: Oscilloscope, newChannels: Channel[]): Promise<void> {
  if (osc.isDestroyed) return;
  console.log(`[Oscilloscope] Setting channels: ${newChannels.length}`);
  osc.allChannels = Array.isArray(newChannels) ? newChannels : [];
  osc.visibleChannels = [...osc.allChannels];
  try {
    osc.archive.clear();
  } catch (err) {
    console.error("[Oscilloscope] Failed to clear archive:", err);
  }
  if (osc.serial) {
    try {
      osc.serial.setChannels(osc.allChannels);
    } catch (err) {
      console.error("[Oscilloscope] Failed to set serial channels:", err);
    }
  }

  await renderVisibleChannels(osc.getRenderingContext());
  canvasUpdateOffset(osc.getCanvasContext());
  osc.syncCanvasLayout();
  syncViewPositions(osc.getRenderingContext());
  osc.cursorsFooter?.setStats(osc.allChannels.length, osc.lastReportedHz);
  console.log(`[Oscilloscope] Switch complete.`);
}
export async function updateVisibleChannels(
  osc: Oscilloscope,
  newVisibleChannels: Channel[],
): Promise<void> {
  if (osc.isDestroyed) return;
  const validIds = new Set(osc.allChannels.map((ch) => ch.id));
  const filtered = Array.isArray(newVisibleChannels)
    ? newVisibleChannels.filter((ch) => ch && validIds.has(ch.id))
    : [];
  if (
    newVisibleChannels.length > 0 &&
    filtered.length === 0 &&
    osc.allChannels.length > 0
  ) {
    osc.visibleChannels = [...osc.allChannels];
  } else {
    osc.visibleChannels = filtered;
  }
  renderVisibleChannels(osc.getRenderingContext());
}

export function setIniFiles(osc: Oscilloscope, files: IniFileItem[]): void {
  osc.availableIniFiles = Array.isArray(files) ? files : [];
  if (osc.iniPanel) {
    osc.iniPanel.setExternalFiles(osc.availableIniFiles);
  }
}
export async function applyChannelConfigs(osc: Oscilloscope, configs: ChannelConfig[]): Promise<void> {
  if (osc.isDestroyed) return;
  const channels = (Array.isArray(configs) ? configs : [])
    .filter((c) => c && c.id)
    .map((c) => new Channel(c));
  await osc.setChannels(channels);
}
export async function loadIniContent(osc: Oscilloscope, iniContent: string): Promise<void> {
  if (osc.isDestroyed || typeof iniContent !== "string") return;
  if (
    osc.allChannels.length > 0 &&
    iniContent === osc.lastLoadedIniContent
  ) {
    console.log("[Oscilloscope] loadIniContent skipped: same content");
    return;
  }
  try {
    const coreParser = new CoreIniParser();
    const parseResult = coreParser.parse(iniContent);
    const iniConfig = new IniConfig(parseResult);
    const ramParams = iniConfig.getSection("RAM");
    const channelConfigs = iniParamsToChannelConfigs(ramParams);
    await osc.applyChannelConfigs(channelConfigs);
    osc.currentIniConfig = iniConfig;
    osc.lastLoadedIniContent = iniContent;
  } catch (err) {
    console.error("[Oscilloscope] Failed to parse INI content:", err);
  }
}
export function setActiveIni(osc: Oscilloscope, id: string, loadContent: boolean = true): void {
  if (osc.isDestroyed || !id) return;
  if (
    osc.currentIniId === id &&
    osc.allChannels.length > 0 &&
    !loadContent
  ) {
    return;
  }
  osc.currentIniId = id;
  if (osc.iniPanel) {
    osc.iniPanel.selectFileById(id);
  }
  if (loadContent) {
    const file = osc.availableIniFiles.find((f) => f.id === id);
    if (file && typeof file.content === "string") {
      void osc.loadIniContent(file.content);
    }
  }
}