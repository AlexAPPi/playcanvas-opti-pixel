import pc from "../../engine.js";

/**
 * Device-Z pyramid built from the camera depth.
 * Testers compare an AABB's closest device Z with the mip that covers its screen rectangle.
 */
export interface IHierarchicalZBuffer {

    /**
     * One texture per stored mip.
     * WebGL keeps the finest levels outside a single mip chain.
     * WebGPU stores every level on {@link texture} and leaves this unset.
     */
    readonly buffers?: pc.Texture[] | undefined;

    /**
     * Pyramid texture: WebGL's first ping-pong target, or the WebGPU mip chain.
     * Null before the first resize.
     */
    readonly texture: pc.Texture | null;

    /** Width of the depth source the pyramid was built from. */
    readonly screenWidth: number;

    /** Height of the depth source the pyramid was built from. */
    readonly screenHeight: number;

    /** Width of the first stored mip. */
    readonly width: number;

    /** Height of the first stored mip. */
    readonly height: number;

    /** Number of stored mips, including the first. */
    readonly mipLevels: number;

    /**
     * Scale from screen UV to the first stored mip.
     * Testers multiply the screen rectangle by this before sampling.
     */
    uvFactor: readonly [number, number];

    /**
     * When false, {@link update} and {@link updateSceneDepth} do nothing
     * and testers skip the pyramid.
     */
    enabled: boolean;

    /**
     * Pyramid texels are R16F. Sampling reads `.r`.
     */
    isFloat16(): boolean;

    /**
     * Pyramid texels are R32F. Sampling reads `.r`.
     */
    isFloat32(): boolean;

    /**
     * Pyramid is a color texture.
     * The packed RGBA8 path stores device Z and is decoded with `uint2float`.
     * A depth attachment would return false.
     */
    isColor(): boolean;

    /**
     * Max-downsample the hardware depth grab (`requestSceneDepthMap` / `renderPassDepthGrab`)
     * into the pyramid. Device Z is stored as-is. No-op without a grab texture, or when disabled.
     * Call after opaque depth.
     */
    update(camera: pc.Camera): void;

    /**
     * Same pyramid as {@link update}, from `camera.sceneDepthMap`.
     * The encoding comes from `camera.shaderParams` (`sceneDepthMapLinear`,
     * `sceneDepthMapPacked`, `sceneDepthMapReciprocal`): view-space metres, packed RGBA8,
     * or `1 / viewZ`. The first pass point-samples that texture and stores device Z.
     * Later mips and the occlusion test stay in device Z.
     * No-op until the map is published, or when disabled.
     * Call from `postrender` or `frameend`.
     */
    updateSceneDepth(camera: pc.Camera): void;
}
