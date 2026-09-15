// src/oscilloscope/ui/TimelineScrollbar.ts

export class TimelineScrollbar {
    private container: HTMLElement;
    private slider: HTMLInputElement;
    private onChangeCallback?: (timestamp: number) => void;
    
    private minTime: number = 0;
    private maxTime: number = 0;
    
    constructor(container: HTMLElement) {
        this.container = container;
        this.slider = document.createElement('input');
        this.slider.type = 'range';
        this.slider.min = '0';
        this.slider.max = '100';
        this.slider.value = '100';
        this.slider.step = '1';
        
        this.slider.className = 'timeline-slider';
        
        this.slider.addEventListener('input', () => {
            this.handleSliderChange();
        });
        
        this.container.appendChild(this.slider);
    }

    public setRange(minTime: number, maxTime: number): void {
        this.minTime = minTime;
        this.maxTime = maxTime;
        
        this.slider.min = String(minTime);
        this.slider.max = String(maxTime);
        
        if (parseInt(this.slider.value) === this.maxTime) {
            this.slider.value = String(maxTime);
        }
    }

        public setPosition(timestamp: number): void {
        // Если диапазон еще не задан или минимальное и максимальное время равны (пустой архив)
        if (this.minTime === this.maxTime) {
            this.slider.value = String(this.maxTime);
            return;
        }
        
        // Ограничиваем timestamp пределами диапазона
        const clampedTime = Math.max(this.minTime, Math.min(this.maxTime, timestamp));
        this.slider.value = String(clampedTime);
    }


    public onChange(callback: (timestamp: number) => void): void {
        this.onChangeCallback = callback;
    }

    private handleSliderChange(): void {
        const timestamp = parseInt(this.slider.value);
        if (this.onChangeCallback) {
            this.onChangeCallback(timestamp);
        }
    }

    public isAtLivePosition(): boolean {
        return parseInt(this.slider.value) >= this.maxTime - 100;
    }

    public destroy(): void {
        this.container.innerHTML = '';
    }
}