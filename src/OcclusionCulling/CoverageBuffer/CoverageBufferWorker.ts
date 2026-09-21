/**
 * Self-contained worker entry. Stringified into a Blob so the library
 * does not need a separate worker asset. Do not close over module scope.
 *
 * Receives a transferable job bus plus a ping-pong output slot (reprojected +
 * flags), reprojects depth, and tests queued AABBs into the slot.
 *
 * Types are `import type` only — erased at compile time and safe with Blob stringify.
 */
import { defineCoverageCpuBuffer } from "./CoverageCpuBuffer.js";
import type { ICoverageCpuBuffer } from "./ICoverageCpuBuffer.js";
import type { ICoverageBufferFrameMessage } from "./CoverageBufferWorkerMessages.js";

export function coverageBufferWorkerMain(
    CoverageCpuBuffer: new () => ICoverageCpuBuffer
) {

    const ctx = self as unknown as {
        onmessage: ((event: MessageEvent) => void) | null;
        postMessage: (message: unknown, transfer?: Transferable[]) => void;
    };

    const cpu = new CoverageCpuBuffer();
    const transfer: Transferable[] = [];
    const result = {
        t: "result",
        bus: new ArrayBuffer(0),
        out: new ArrayBuffer(0)
    };

    ctx.onmessage = function (event: MessageEvent<ICoverageBufferFrameMessage>) {
        runFrame(event.data);
    };

    function runFrame(msg: ICoverageBufferFrameMessage) {

        const bus = msg.bus;
        const outBuf = msg.out;

        try {
            cpu.bind(bus, outBuf);
            cpu.update();
            cpu.test();
        }
        catch {
            // Return the slots even if bind/update/test throws.
            // Otherwise the tester keeps `_bus` / `_writeOut` null forever.
        }

        result.bus = bus;
        result.out = outBuf;
        transfer.length = 0;
        transfer.push(bus, outBuf);
        ctx.postMessage(result, transfer);
        transfer.length = 0;
    }

    ctx.postMessage({ t: "ready" });
}

export function spawnCoverageBufferWorker(): { worker: Worker; url: string } {
    const defineCoverageCpuBufferString = defineCoverageCpuBuffer.toString();
    const coverageBufferWorkerMainString = coverageBufferWorkerMain.toString();
    const url = URL.createObjectURL(new Blob([`
        "use strict";
        (function(){
            var CoverageCpuBuffer=(${defineCoverageCpuBufferString})();
            (${coverageBufferWorkerMainString})(CoverageCpuBuffer);
        })();
        `],
        { type: "application/javascript" }
    ));
    return { worker: new Worker(url), url };
}
