export default `

    #ifdef INSTANCING

        #if defined(PICK_PASS) && defined(PICK_CUSTOM_ID) && defined(INSTANCER_USE_PICK_ID)
        output.vInstancerInstancePickId = getInstancePickId();
        #endif

        #ifdef INSTANCER_USE_LAYERS
        output.vInstancerInstanceLayer = getInstanceLayer();
        #endif

        #ifdef INSTANCER_USE_CROSSFADE
        output.vInstancerInstanceCrossFade = getInstanceCrossFade();
        #endif

        #ifdef INSTANCER_USE_CUSTOM_COLOR
        output.vInstancerInstanceCutomColor = getInstanceColor();
        #endif

        #include "instancerUserMainEndVS"

    #else

        #if defined(PICK_PASS) && defined(PICK_CUSTOM_ID) && defined(INSTANCER_USE_PICK_ID)
        output.vInstancerInstancePickId = 0u;
        #endif

        #ifdef INSTANCER_USE_LAYERS
        output.vInstancerInstanceLayer = 0u;
        #endif

        #ifdef INSTANCER_USE_CROSSFADE
        output.vInstancerInstanceCrossFade = 1.0;
        #endif

        #ifdef INSTANCER_USE_CUSTOM_COLOR
        output.vInstancerInstanceCutomColor = vec4f(1.0);
        #endif

    #endif
`;
