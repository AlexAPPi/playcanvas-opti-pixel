export default `

    #include "instancerUserDeclarationPS"
    #include "instancerInstancePickIdPS"

    #ifdef INSTANCER_USE_LAYERS
    flat varying uint vInstancerInstanceLayer;
    #endif

    #ifdef INSTANCER_USE_CROSSFADE
    varying float vInstancerInstanceCrossFade;
    #endif

    #ifdef INSTANCER_USE_CUSTOM_COLOR
    varying vec4 vInstancerInstanceCutomColor;
    #endif
`;