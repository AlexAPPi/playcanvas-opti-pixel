import { ILODLevel } from "./ILODLevel";
import { ILODState } from "./ILODState";

export class FadeDistanceLODState {

    public get(lods: ILODLevel[], distance: number, out: ILODState): void {

        for (let i = 1, l = lods.length; i < l; i++) {

            const level = lods[i];

            if (distance < level.distance) {

                const distanceOffset = level.distance * level.hysteresis;
                const levelDistance = level.distance - distanceOffset;

                if (distance < levelDistance) {

                    out.current = i - 1;
                    out.weight = 1;
                    out.nextWeight = 0;
                    out.next = null;
                    return;
                }

                const t = (distance - levelDistance) / distanceOffset;
                const weight = Math.min(Math.max(0, t), 1);

                out.current = i - 1;
                out.weight = 1 - weight;
                out.nextWeight = weight;
                out.next = i;
                return;
            }
        }

        out.current = lods.length - 1;
        out.next = null;
        out.weight = 1;
        out.nextWeight = 0;
    }
}