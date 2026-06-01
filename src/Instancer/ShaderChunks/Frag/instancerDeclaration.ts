export default `

    #include "instancerUserDeclarationPS"

    #ifdef INSTANCER_USE_CROSSFADE
    varying float vInstancerCrossFade;
    #endif

    #ifdef INSTANCER_USE_CUSTOM_COLOR
    varying vec4 vInstancerCutomColor;
    #endif
`;