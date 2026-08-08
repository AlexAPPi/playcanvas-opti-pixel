export default `

    #ifdef INSTANCER_USE_LAYERS

        uniform uint uInstancerInstanceLayer;

        uint getInstanceLayer() {
            return uInstancerInstanceLayer;
        }

    #endif
`;