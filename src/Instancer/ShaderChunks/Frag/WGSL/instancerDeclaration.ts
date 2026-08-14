export default `

    #include "instancerUserDeclarationPS"
    #include "instancerInstancePickIdPS"

    #ifdef INSTANCER_USE_LAYERS
    varying @interpolate(flat) vInstancerInstanceLayer: u32;
    #endif

    #ifdef INSTANCER_USE_CROSSFADE
    varying vInstancerInstanceCrossFade: f32;
    #endif

    #ifdef INSTANCER_USE_CUSTOM_COLOR
    varying vInstancerInstanceCustomColor: vec4f;
    #endif
`;
