export default `

    #if INSTANCER_USE_CROSSFADE
    varying float vInstancerCrossFade;
    #endif

    #if INSTANCER_USE_CUSTOM_COLOR
    varying vec4 vInstancerCutomColor;
    #endif

    #if INSTANCING

        attribute uint aInstanceIndex;

        uint getInstanceId() {

            #if INSTANCER_USE_CROSSFADE
                return aInstanceIndex & 0xfffffu;
            #else
                return aInstanceIndex;
            #endif
        }

        #if INSTANCER_USE_CROSSFADE
        #include "instancerInstanceCrossFadeVS"
        #endif

        #if INSTANCER_USE_CUSTOM_COLOR
        #include "instancerInstanceColorVS"
        #endif

        #include "instancerInstanceMatrixVS"

    #endif
`;