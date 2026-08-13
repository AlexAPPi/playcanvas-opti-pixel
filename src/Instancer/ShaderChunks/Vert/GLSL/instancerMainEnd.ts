export default `

    #ifdef INSTANCING

        #if defined(PICK_PASS) && defined(PICK_CUSTOM_ID) && defined(INSTANCER_USE_PICK_ID)
        vInstancerInstancePickId = getInstancePickId();
        #endif

        #ifdef INSTANCER_USE_LAYERS
        vInstancerInstanceLayer = getInstanceLayer();
        #endif

        #ifdef INSTANCER_USE_CROSSFADE
        vInstancerInstanceCrossFade = getInstanceCrossFade();
        #endif

        #ifdef INSTANCER_USE_CUSTOM_COLOR
        vInstancerInstanceCutomColor = getInstanceColor();
        #endif

        #include "instancerUserMainEndVS"

    #else

        #if defined(PICK_PASS) && defined(PICK_CUSTOM_ID) && defined(INSTANCER_USE_PICK_ID)
        vInstancerInstancePickId = 0u;
        #endif

        #ifdef INSTANCER_USE_LAYERS
        vInstancerInstanceLayer = 0u;
        #endif

        #ifdef INSTANCER_USE_CROSSFADE
        vInstancerInstanceCrossFade = 1.0;
        #endif

        #ifdef INSTANCER_USE_CUSTOM_COLOR
        vInstancerInstanceCutomColor = vec4(1.0);
        #endif

    #endif
`;