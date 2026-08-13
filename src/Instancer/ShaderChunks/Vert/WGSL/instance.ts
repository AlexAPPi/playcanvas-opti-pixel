export default `

    #if defined(PICK_PASS) && defined(PICK_CUSTOM_ID) && defined(INSTANCER_USE_PICK_ID)
    varying @interpolate(flat) vInstancerInstancePickId: u32;
    #endif

    #ifdef INSTANCER_USE_LAYERS
    varying @interpolate(flat) vInstancerInstanceLayer: u32;
    #endif

    #ifdef INSTANCER_USE_CROSSFADE
    varying vInstancerInstanceCrossFade: f32;
    #endif

    #ifdef INSTANCER_USE_CUSTOM_COLOR
    varying vInstancerInstanceCutomColor: vec4f;
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
