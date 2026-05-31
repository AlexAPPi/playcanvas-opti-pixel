export default `

    #if INSTANCER_USE_CUSTOM_COLOR
    varying vec4 vInstancerCutomColor;
    #endif

    #if INSTANCING

        attribute uint aInstanceIndex;

        #if INSTANCER_USE_CUSTOM_COLOR
        #include "instancerInstanceColorVS"
        #endif

        #include "instancerInstanceMatrixVS"

    #endif
`;