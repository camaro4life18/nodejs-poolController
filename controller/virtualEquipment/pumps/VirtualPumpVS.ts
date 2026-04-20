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
import { Inbound, Outbound } from '../../comms/messages/Messages';
import { VirtualPump } from './VirtualPump';

/**
 * IntelliFlo VS (variable speed) simulator.
 *
 * Action 1 payload shape (from OCP or Nixie):
 *    [2, 196, rpmHi, rpmLo]
 *
 * A real pump acks with the full 4-byte payload echo.  The existing
 * PumpStateMessage.processDirectPumpMessages() decodes it as:
 *    if (payload[2] & 0x20) === 0 then RPM else GPM
 *    setAmount = payload[2]*256 + payload[3]
 */
export class VirtualPumpVS extends VirtualPump {
    public static readonly MAX_RPM = 3450;
    public static readonly NOMINAL_WATTS = 2000;

    protected supportedActions = new Set<number>([1, 4, 6, 7]);

    public get type(): string { return 'vs'; }

    protected processSpeedCommand(msg: Inbound, response: Outbound): boolean {
        if (msg.action !== 1) return false;
        if (msg.payload.length < 4) return false;
        const b0 = msg.extractPayloadByte(0);
        const b1 = msg.extractPayloadByte(1);
        const rpmHi = msg.extractPayloadByte(2);
        const rpmLo = msg.extractPayloadByte(3);
        this._targetRpm = rpmHi * 256 + rpmLo;
        response.appendPayloadByte(b0);
        response.appendPayloadByte(b1);
        response.appendPayloadByte(rpmHi);
        response.appendPayloadByte(rpmLo);
        return true;
    }

    /**
     * Cheap watts curve: power scales with the cube of the speed ratio.
     * At MAX_RPM this returns NOMINAL_WATTS.  Not physically accurate for
     * any specific pump model — just a plausible, deterministic signature
     * that isn't obviously zero.
     */
    protected computeWatts(): number {
        if (this._targetRpm <= 0) return 0;
        const ratio = this._targetRpm / VirtualPumpVS.MAX_RPM;
        return ratio * ratio * ratio * VirtualPumpVS.NOMINAL_WATTS;
    }
}
