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
        out: new ArrayBuffer(0),
        workerMs: 0,
        reprojectMs: 0,
        mipMs: 0,
        aabbTestMs: 0,
        aabbCount: 0,
        occludedCount: 0
    };

    function runFrame(msg: ICoverageBufferFrameMessage) {

        const bus = msg.bus;
        const outBuf = msg.out;
        const t0 = performance.now();

        try {
            cpu.bind(bus, outBuf);
            cpu.update();
            cpu.test();
            const job = cpu.job;
            result.reprojectMs = job.reprojectMs;
            result.mipMs = job.mipMs;
            result.aabbTestMs = job.aabbTestMs;
            result.aabbCount = job.aabbCount;
            result.occludedCount = job.occludedCount;
        }
        catch {
            // Return the slots even if bind/update/test throws.
            // Otherwise the tester keeps `_bus` / `_writeOut` null forever.
            result.reprojectMs = 0;
            result.mipMs = 0;
            result.aabbTestMs = 0;
            result.aabbCount = 0;
            result.occludedCount = 0;
        }

        result.workerMs = performance.now() - t0;
        result.bus = bus;
        result.out = outBuf;
        transfer.length = 0;
        transfer.push(bus, outBuf);
        ctx.postMessage(result, transfer);
        transfer.length = 0;
    }

    ctx.onmessage = function (event: MessageEvent<ICoverageBufferFrameMessage>) {
        runFrame(event.data);
    };

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
