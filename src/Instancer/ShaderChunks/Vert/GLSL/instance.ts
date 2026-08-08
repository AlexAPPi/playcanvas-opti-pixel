export default `

    #ifdef INSTANCER_USE_LAYERS
    flat varying uint vInstancerLayer;
    #endif

    #ifdef INSTANCER_USE_CROSSFADE
    varying float vInstancerCrossFade;
    #endif

    #ifdef INSTANCER_USE_CUSTOM_COLOR
    varying vec4 vInstancerCutomColor;
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