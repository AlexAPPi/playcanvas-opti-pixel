export default `

    #include "instancerUserDeclarationPS"

    #ifdef INSTANCER_USE_CROSSFADE
    varying vInstancerCrossFade: f32;
    #endif

    #ifdef INSTANCER_USE_CUSTOM_COLOR
    varying vInstancerCutomColor: vec4f;
    #endif
`;