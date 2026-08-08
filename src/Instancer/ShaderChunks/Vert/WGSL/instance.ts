export default `

    #ifdef INSTANCER_USE_LAYERS
    varying @interpolate(flat) vInstancerLayer: u32;
    #endif

    #ifdef INSTANCER_USE_CROSSFADE
    varying vInstancerCrossFade: f32;
    #endif

    #ifdef INSTANCER_USE_CUSTOM_COLOR
    varying vInstancerCutomColor: vec4f;
    #endif

    #ifdef INSTANCING

        #include "instancerInstanceAttrVS"
        #include "instancerInstanceIdVS"

        #ifdef INSTANCER_USE_LAYERS
        #include "instancerInstanceLayerVS"
        #endif

        #ifdef INSTANCER_USE_CROSSFADE
        #include "instancerInstanceCrossFadeVS"
        #endif

        #ifdef INSTANCER_USE_CUSTOM_COLOR
        #include "instancerInstanceColorVS"
        #endif

        #include "instancerInstanceMatrixVS"

    #endif
`;
