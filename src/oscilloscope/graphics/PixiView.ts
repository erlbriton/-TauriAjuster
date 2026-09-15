// src/oscilloscope/graphics/PixiView.ts

import { Container, Graphics, Application } from 'pixi.js';

export interface ViewportBounds {
    width: number;
    height: number;
}

export interface StrokeOptions {
    width?: number;
    color?: number | string;
    alpha?: number;
}

export class PixiView {
    public container: Container;
    public gridGraphics: Graphics;
    public waveGraphics: Graphics;
    public markerGraphics: Graphics;
    public cursorGraphics: Graphics;
    public bounds: ViewportBounds;
    private app: Application;

    constructor(app: Application, x: number, y: number, width: number, height: number) {
        this.app = app;
        this.bounds = { width, height };

        this.container = new Container();
        this.container.x = x;
        this.container.y = y;

        this.gridGraphics = new Graphics();
        this.waveGraphics = new Graphics();
        this.markerGraphics = new Graphics();
        this.cursorGraphics = new Graphics();

        this.container.addChild(this.gridGraphics);
        this.container.addChild(this.waveGraphics);
        this.container.addChild(this.markerGraphics);
        this.container.addChild(this.cursorGraphics);

        this.app.stage.addChild(this.container);
    }

    public updateLayout(x: number, y: number, width: number, height: number): void {
        this.container.x = x;
        this.container.y = y;
        this.bounds = { width, height };
    }

    public destroy(): void {
        this.gridGraphics.destroy();
        this.waveGraphics.destroy();
        this.markerGraphics.destroy();
        this.cursorGraphics.destroy();
        this.container.destroy({ children: true });
    }
}