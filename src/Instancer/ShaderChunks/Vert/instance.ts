export default `

    #if INSTANCER_USE_CROSSFADE
    varying float vInstancerCrossFade;
    #endif

    #if INSTANCER_USE_CUSTOM_COLOR
    varying vec4 vInstancerCutomColor;
    #endif

    #if INSTANCING

        #include "instancerInstanceIdVS"

        #if INSTANCER_USE_CROSSFADE
        #include "instancerInstanceCrossFadeVS"
        #endif

        #if INSTANCER_USE_CUSTOM_COLOR
        #include "instancerInstanceColorVS"
        #endif

        #include "instancerInstanceMatrixVS"

    #endif
`;