export default `

    #include "instancerUserDeclarationPS"
    #include "instancerInstancePickIdPS"

    #ifdef INSTANCER_USE_LAYERS
    varying @interpolate(flat) vInstancerInstanceLayer: u32;
    #endif

    #ifdef INSTANCER_USE_CROSSFADE
    varying vInstancerCrossFade: f32;
    #endif

    #ifdef INSTANCER_USE_CUSTOM_COLOR
    varying vInstancerCutomColor: vec4f;
    #endif
`;
