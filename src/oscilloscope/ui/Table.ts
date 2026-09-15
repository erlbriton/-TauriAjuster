// src/ui/Table.ts

import { Channel } from '../core/Channel';
import { ChannelRow } from './ChannelRow';

export class Table {
    private readonly container: HTMLElement;
    private readonly rows: Map<string, ChannelRow> = new Map();

    constructor(container: HTMLElement) {
        this.container = container;
    }

    public addChannel(channel: Channel): ChannelRow {
        let row = this.rows.get(channel.id);
        if (row) return row;

        row = new ChannelRow(channel);
        row.attach(this.container);
        this.rows.set(channel.id, row);
        return row;
    }

    public removeChannel(channelId: string): void {
        const row = this.rows.get(channelId);
        if (row) {
            row.remove();
            this.rows.delete(channelId);
        }
    }

    public getRow(channelId: string): ChannelRow | undefined {
        return this.rows.get(channelId);
    }

    public getAllRows(): ChannelRow[] {
        return Array.from(this.rows.values());
    }

    public updateValues(): void {
        this.rows.forEach(row => row.updateValue());
    }

    public clear(): void {
        this.rows.forEach(row => row.remove());
        this.rows.clear();
        this.container.innerHTML = '';
    }
}
