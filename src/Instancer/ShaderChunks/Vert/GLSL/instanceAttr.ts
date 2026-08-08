export default `

    // (id & 0xfffff) | ((opacity & 0xff) << 20) | ((layer & 0xf) << 28)
    attribute uint aInstancerInstance;

    uint getInstanceIdFromAttribute() {
        #if defined(INSTANCER_USE_CROSSFADE) || defined(INSTANCER_USE_LAYERS)
            return aInstancerInstance & 0xfffffu;
        #else
            return aInstancerInstance;
        #endif
    }

    float getInstanceCrossFadeFromAttribute() {
        #ifdef INSTANCER_USE_CROSSFADE
            const float INV_255 = 1.0 / 255.0;
            return float((aInstancerInstance >> 20u) & 0xffu) * INV_255;
        #else
            return 1.0;
        #endif
    }

    uint getInstanceLayerFromAttribute() {
        #ifdef INSTANCER_USE_LAYERS
            return (aInstancerInstance >> 28u) & 0xfu;
        #else
            return 0u;
        #endif
    }
`;