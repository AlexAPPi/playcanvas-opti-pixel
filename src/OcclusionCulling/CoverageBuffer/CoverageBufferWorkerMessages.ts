/**
 * Shared main <-> worker message shapes for coverage buffer tester.
 * Frame payload lives in the transferable bus (job) and output slot
 * (reprojected + flags). The blob worker cannot import values from this file
 * at runtime (`coverageBufferWorkerMain` is stringified); use `import type` only.
 */

export interface ICoverageBufferReadyMessage {
    t: "ready";
}

export interface ICoverageBufferFrameMessage {
    t: "frame";
    bus: ArrayBuffer;
    out: ArrayBuffer;
}

export interface ICoverageBufferResultMessage {
    t: "result";
    bus: ArrayBuffer;
    out: ArrayBuffer;
}

/** Main-thread handler union (worker → main). */
export type TCoverageBufferMessage =
    | ICoverageBufferReadyMessage
    | ICoverageBufferResultMessage;
