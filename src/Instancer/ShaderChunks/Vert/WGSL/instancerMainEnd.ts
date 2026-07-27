export default `

    #ifdef INSTANCING

        #ifdef INSTANCER_USE_CROSSFADE
        output.vInstancerCrossFade = getInstanceCrossFade();
        #endif

        #ifdef INSTANCER_USE_CUSTOM_COLOR
        output.vInstancerCutomColor = getInstanceColor();
        #endif

        #include "instancerUserMainEndVS"

    #else

        #ifdef INSTANCER_USE_CROSSFADE
        output.vInstancerCrossFade = 1.0;
        #endif

        #ifdef INSTANCER_USE_CUSTOM_COLOR
        output.vInstancerCutomColor = vec4f(1.0);
        #endif

    #endif
`;