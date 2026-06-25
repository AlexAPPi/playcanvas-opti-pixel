export default `

    #if INSTANCING

        #if INSTANCER_USE_CROSSFADE
        vInstancerCrossFade = getInstanceCrossFade();
        #endif

        #if INSTANCER_USE_CUSTOM_COLOR
        vInstancerCutomColor = getInstanceColor();
        #endif

        #include "instancerUserMainEndVS"

    #else

        #if INSTANCER_USE_CROSSFADE
        vInstancerCrossFade = 1.0;
        #endif

        #if INSTANCER_USE_CUSTOM_COLOR
        vInstancerCutomColor = vec4(1.0);
        #endif

    #endif
`;