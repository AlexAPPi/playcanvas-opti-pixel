export default `

    #ifdef INSTANCER_USE_CROSSFADE
    varying vInstancerCrossFade: f32;
    #endif

    #ifdef INSTANCER_USE_CUSTOM_COLOR
    varying vInstancerCutomColor: vec4f;
    #endif

    #ifdef INSTANCING

        #include "instancerInstanceIdVS"

        #ifdef INSTANCER_USE_CROSSFADE
        #include "instancerInstanceCrossFadeVS"
        #endif

        #ifdef INSTANCER_USE_CUSTOM_COLOR
        #include "instancerInstanceColorVS"
        #endif

        #include "instancerInstanceMatrixVS"

    #endif
`;