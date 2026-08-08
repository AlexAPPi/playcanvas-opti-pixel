export default `

    // (id & 0xfffff) | ((opacity & 0xff) << 20) | ((layer & 0xf) << 28)
    attribute aInstancerInstance: u32;

    fn getInstanceIdFromAttribute() -> u32 {
        #if defined(INSTANCER_USE_CROSSFADE) || defined(INSTANCER_USE_LAYERS)
            return aInstancerInstance & 0xfffffu;
        #else
            return aInstancerInstance;
        #endif
    }

    fn getInstanceCrossFadeFromAttribute() -> f32 {
        #ifdef INSTANCER_USE_CROSSFADE
            const INV_255: f32 = 1.0 / 255.0;
            return f32((aInstancerInstance >> 20u) & 0xffu) * INV_255;
        #else
            return 1.0;
        #endif
    }

    fn getInstanceLayerFromAttribute() -> u32 {
        #ifdef INSTANCER_USE_LAYERS
            return (aInstancerInstance >> 28u) & 0xfu;
        #else
            return 0u;
        #endif
    }
`;
