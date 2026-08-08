export default `

    #ifdef INSTANCER_USE_LAYERS

        uniform uInstancerInstanceLayer: u32;

        fn getInstanceLayer() -> u32 {
            return uniform.uInstancerInstanceLayer;
        }

    #endif
`;
