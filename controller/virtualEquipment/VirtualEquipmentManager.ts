/*  nodejs-poolController.  An application to control pool equipment.
Copyright (C) 2016, 2017, 2018, 2019, 2020, 2021, 2022.
Russell Goldin, tagyoureit.  russ.goldin@gmail.com

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
import * as path from 'path';
import * as fs from 'fs';
import { Inbound, Message, Protocol } from '../comms/messages/Messages';
import { logger } from '../../logger/Logger';
import { webApp } from '../../web/Server';
import { VirtualPump } from './pumps/VirtualPump';
import { VirtualPumpVS } from './pumps/VirtualPumpVS';

/**
 * VirtualEquipmentManager
 *
 * Simulates downstream bus-attached equipment (pumps, etc.) that an upstream
 * master (real OCP or njsPC/Nixie) believes is physically present.
 *
 * This is NOT configured in poolConfig.json and does NOT appear anywhere in
 * sys.* or state.* equipment collections.  It is a wire-level impersonator
 * controlled via REST endpoints under /config/virtualEquipment and persisted
 * in its own file (data/virtualEquipment.json).
 *
 * Terminology:
 *  - "intent"        — what the user asked for via REST (enabled=true/false)
 *  - "autoDisabled"  — set true when a collision with a real device is
 *                      detected on the bus.  Requires an explicit REST
 *                      re-enable to clear.
 *  - "effective"     — enabled && !autoDisabled
 */
export class VirtualEquipmentManager {
    public static readonly CONFLICT_WINDOW_MS = 1000;
    private _pumps: VirtualPump[] = [];
    private _filePath: string;
    private _loaded = false;

    constructor(dataDir?: string) {
        this._filePath = path.posix.join(dataDir || path.posix.join(process.cwd(), 'data'), 'virtualEquipment.json');
    }

    public get pumps(): VirtualPump[] { return this._pumps; }
    public get filePath(): string { return this._filePath; }

    /**
     * Load the persisted virtualEquipment.json file and construct in-memory
     * virtual devices.  Missing file is a no-op (first run).
     */
    public async loadAsync(): Promise<void> {
        try {
            if (!fs.existsSync(this._filePath)) {
                this._loaded = true;
                return;
            }
            const raw = fs.readFileSync(this._filePath, 'utf8') || '{}';
            const parsed = JSON.parse(raw);
            const pumpDefs: any[] = Array.isArray(parsed.pumps) ? parsed.pumps : [];
            for (const def of pumpDefs) {
                try {
                    const pump = this._constructPump(def);
                    if (pump) this._pumps.push(pump);
                } catch (err) {
                    logger.warn(`VirtualEquipment: skipping bad pump definition ${JSON.stringify(def)}: ${(err as Error).message}`);
                }
            }
            this._loaded = true;
            const effective = this._pumps.filter(p => p.isEffective).length;
            logger.info(`VirtualEquipment: loaded ${this._pumps.length} pump definitions (${effective} effective)`);
        } catch (err) {
            logger.error(`VirtualEquipment: failed to load ${this._filePath}: ${(err as Error).message}`);
        }
    }

    private _constructPump(def: any): VirtualPump | null {
        if (typeof def.address !== 'number') throw new Error('address is required');
        const type = (def.type || 'vs').toLowerCase();
        switch (type) {
            case 'vs':
                return new VirtualPumpVS({
                    address: def.address,
                    portId: typeof def.portId === 'number' ? def.portId : 0,
                    enabled: def.enabled !== false,
                    autoDisabled: def.autoDisabled === true,
                    autoDisabledAt: def.autoDisabledAt || null,
                    autoDisabledReason: def.autoDisabledReason || null,
                    wattModel: def.wattModel || 'cheap'
                });
            default:
                throw new Error(`unsupported virtual pump type "${type}"`);
        }
    }

    /**
     * Gate: should we synthesize a response for this inbound packet?
     * All four conditions must hold:
     *  - Protocol is Pump
     *  - dest matches an effective (enabled and not auto-disabled) virtual pump
     *  - source is a recognized master (real OCP = 16, or njsPC/Nixie = Message.pluginAddress)
     *  - action is one we implement
     */
    public shouldAnswer(msg: Inbound): boolean {
        if (msg.protocol !== Protocol.Pump) return false;
        const pump = this.findEffectivePumpByAddress(msg.dest);
        if (!pump) return false;
        if (msg.source !== 16 && msg.source !== Message.pluginAddress) return false;
        return pump.supportsAction(msg.action);
    }

    /**
     * Synthesize and queue a response.  Caller must only invoke this after
     * shouldAnswer() returned true.
     */
    public process(msg: Inbound): void {
        const pump = this.findEffectivePumpByAddress(msg.dest);
        if (!pump) return;
        try {
            pump.process(msg);
            // Emit live runtime state after any mutation.
            this.emit();
        } catch (err) {
            logger.error(`VirtualEquipment: pump at address ${pump.address} failed to process action ${msg.action}: ${(err as Error).message}`);
        }
    }

    /**
     * Observe every inbound packet for collision detection.  If two or more
     * inbound packets with source=<ourVirtualAddress> appear within
     * CONFLICT_WINDOW_MS, a real pump must be answering on the bus too.
     * Auto-disable the virtual pump and persist that flag.
     *
     * One inbound per window is expected: it's our own loopback/echo.
     */
    public observe(msg: Inbound): void {
        if (msg.protocol !== Protocol.Pump) return;
        const pump = this.findPumpByAddress(msg.source);
        if (!pump || !pump.isEffective) return;

        const now = Date.now();
        pump.pushRecentInboundEcho(now);
        const windowStart = now - VirtualEquipmentManager.CONFLICT_WINDOW_MS;
        const echoes = pump.recentEchoes.filter(t => t >= windowStart);
        if (echoes.length >= 2) {
            const reason = `Collision: ${echoes.length} inbound packets with source=${pump.address} within ${VirtualEquipmentManager.CONFLICT_WINDOW_MS}ms — a real pump is likely on the bus.`;
            pump.setAutoDisabled(true, reason);
            logger.warn(`VirtualEquipment: auto-disabling pump at address ${pump.address}. ${reason}`);
            this.saveAsync().catch(e => logger.error(`VirtualEquipment: save after auto-disable failed: ${e.message}`));
            this.emit();
        }
    }

    public findPumpByAddress(address: number): VirtualPump | undefined {
        return this._pumps.find(p => p.address === address);
    }
    public findEffectivePumpByAddress(address: number): VirtualPump | undefined {
        const p = this.findPumpByAddress(address);
        return p && p.isEffective ? p : undefined;
    }

    /**
     * Upsert a pump definition.  Called by the REST PUT handler.  Clears any
     * prior autoDisabled flag because the user is explicitly re-asserting
     * intent.
     */
    public async upsertPumpAsync(def: any): Promise<VirtualPump> {
        if (typeof def.address !== 'number') throw new Error('address is required');
        const type = (def.type || 'vs').toLowerCase();
        let pump = this.findPumpByAddress(def.address);
        if (pump) {
            if (pump.type !== type) {
                this._pumps = this._pumps.filter(p => p !== pump);
                pump = null;
            } else {
                pump.applyUserConfig({
                    enabled: def.enabled !== false,
                    portId: typeof def.portId === 'number' ? def.portId : pump.portId,
                    wattModel: def.wattModel || pump.wattModel
                });
                pump.clearAutoDisabled();
            }
        }
        if (!pump) {
            pump = this._constructPump({ ...def, autoDisabled: false });
            this._pumps.push(pump);
        }
        await this.saveAsync();
        this.emit();
        return pump;
    }

    public async deletePumpAsync(address: number): Promise<void> {
        const before = this._pumps.length;
        this._pumps = this._pumps.filter(p => p.address !== address);
        if (this._pumps.length !== before) {
            await this.saveAsync();
            this.emit();
        }
    }

    public async reenablePumpAsync(address: number): Promise<VirtualPump | undefined> {
        const pump = this.findPumpByAddress(address);
        if (!pump) return undefined;
        pump.clearAutoDisabled();
        await this.saveAsync();
        this.emit();
        return pump;
    }

    public getSnapshot(): any {
        return {
            filePath: this._filePath,
            pumps: this._pumps.map(p => p.toSnapshot())
        };
    }

    /**
     * Persist the current set of pump definitions.  Only intent + auto-disable
     * fields are written; runtime state (rpm, running, etc.) is not persisted.
     */
    public async saveAsync(): Promise<void> {
        const data = {
            pumps: this._pumps.map(p => p.toPersisted())
        };
        const dir = path.dirname(this._filePath);
        try {
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.writeFile(this._filePath, JSON.stringify(data, null, 2), 'utf8');
        } catch (err) {
            logger.error(`VirtualEquipment: failed to write ${this._filePath}: ${(err as Error).message}`);
            throw err;
        }
    }

    /** Emit the current snapshot on the "virtualEquipment" socket event. */
    public emit(): void {
        try {
            webApp.emitToClients('virtualEquipment', this.getSnapshot());
        } catch { /* webApp may not be initialized during unit tests */ }
    }
}

export const virtualEquipmentManager: VirtualEquipmentManager = new VirtualEquipmentManager();
