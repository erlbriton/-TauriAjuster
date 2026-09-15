// src/ui/Layout.ts

export class Layout {
    public static createSkeleton(rootElement: HTMLElement): {
        toolbarContainer: HTMLElement;
        headerContainer: HTMLElement;
        rowsContainer: HTMLElement;
        footerContainer: HTMLElement;
        iniPanelContainer: HTMLElement;
        splitContainer: HTMLElement;
        bottomPanelsContainer: HTMLElement;
        timelineContainer: HTMLElement;
    } {
        rootElement.innerHTML = `
            <div id="app-viewport">
                <div id="app-split-container" class="half-window-left">
                    <div id="oscilloscope">
                        <div id="toolbar"></div>
                        <div id="header">
                            <div class="col-name">Name</div>
                            <div class="col-description">hex</div>
                            <div class="col-value">Physical</div>
                            <div class="col-unit">Unit</div>
                            <div class="col-graph">Graph</div>
                        </div>
                        <div id="channelRows"></div>
                        <div id="timeline-container" class="timeline-container"></div>
                        <div id="bottom-panels">
                            <div class="bottom-row bottom-row-edit">
                                <input id="bottom-edit-input" class="bottom-edit-input" type="text"
                                       spellcheck="false" autocomplete="off" />
                            </div>
                            <div class="bottom-row bottom-row-read">
                                <div class="read-cell" id="read-cell-1"></div>
                                <div class="read-cell" id="read-cell-2"></div>
                                <div class="read-cell" id="read-cell-3"></div>
                                <div class="read-cell" id="read-cell-4"></div>
                            </div>
                        </div>
                        <div id="footer" style="display: none;">
                            <div class="cursor-stat">
                                <div class="cursor-stat-item">Cursor X1: <span id="cur-x1">25.0%</span></div>
                                <div class="cursor-stat-item">Cursor X2: <span id="cur-x2">75.0%</span></div>
                                <div class="cursor-stat-item">Δt: <span id="cur-dt">1000 ms</span></div>
                                <div class="cursor-stat-item">Frequency f: <span id="cur-freq">1.00 Hz</span></div>
                            </div>
                            <div>Drag graph with mouse wheel to zoom | Cursors enabled</div>
                        </div>
                    </div>
                    <div id="iniPanel" style="display: none;"></div>
                </div>
                <div id="desktop-workspace"></div>
            </div>
        `;

        const bottomPanelsContainer = rootElement.querySelector('#bottom-panels') as HTMLElement | null;
        if (!bottomPanelsContainer) {
            throw new Error('[Layout] Не найден #bottom-panels после создания скелета.');
        }

                const timelineContainer = rootElement.querySelector('#timeline-container') as HTMLElement | null;
        if (!timelineContainer) {
            throw new Error('[Layout] Не найден #timeline-container после создания скелета.');
        }

        return {
            toolbarContainer: rootElement.querySelector('#toolbar') as HTMLElement,
            headerContainer: rootElement.querySelector('#header') as HTMLElement,
            rowsContainer: rootElement.querySelector('#channelRows') as HTMLElement,
            footerContainer: rootElement.querySelector('#footer') as HTMLElement,
            iniPanelContainer: rootElement.querySelector('#iniPanel') as HTMLElement,
            splitContainer: rootElement.querySelector('#app-split-container') as HTMLElement,
            bottomPanelsContainer,
            timelineContainer,
        };
    }
}
