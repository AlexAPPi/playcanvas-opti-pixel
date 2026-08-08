export default `

    #ifdef INSTANCING

        #ifdef INSTANCER_USE_LAYERS
        vInstancerLayer = getInstanceLayer();
        #endif

        #ifdef INSTANCER_USE_CROSSFADE
        vInstancerCrossFade = getInstanceCrossFade();
        #endif

        #ifdef INSTANCER_USE_CUSTOM_COLOR
        vInstancerCutomColor = getInstanceColor();
        #endif

        #include "instancerUserMainEndVS"

    #else

        #ifdef INSTANCER_USE_LAYERS
        vInstancerLayer = 0u;
        #endif

        #ifdef INSTANCER_USE_CROSSFADE
        vInstancerCrossFade = 1.0;
        #endif

        #ifdef INSTANCER_USE_CUSTOM_COLOR
        vInstancerCutomColor = vec4(1.0);
        #endif

    #endif
`;