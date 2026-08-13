export default `

    #if defined(PICK_PASS) && defined(PICK_CUSTOM_ID) && defined(INSTANCER_USE_PICK_ID)
    flat varying uint vInstancerInstancePickId;
    #endif

    #ifdef INSTANCER_USE_LAYERS
    flat varying uint vInstancerInstanceLayer;
    #endif

    #ifdef INSTANCER_USE_CROSSFADE
    varying float vInstancerInstanceCrossFade;
    #endif

    #ifdef INSTANCER_USE_CUSTOM_COLOR
    varying vec4 vInstancerInstanceCutomColor;
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
        #include "instancerInstancePickIdVS"

    #endif
`;