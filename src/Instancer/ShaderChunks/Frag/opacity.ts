export default `

    uniform float material_opacity;
    uniform float material_alphaDitherScale;

    void getOpacity() {
        dAlpha = material_opacity;

        #if INSTANCER_USE_CROSSFADE
        dAlpha *= vInstancerCrossFade;
        #endif

        #if INSTANCER_USE_CUSTOM_COLOR
            #if INSTANCER_USE_CUSTOM_OPACITY
            dAlpha *= vInstancerCutomColor.a;
            #endif
        #endif

        #ifdef STD_OPACITY_TEXTURE
        dAlpha *= texture2DBias({STD_OPACITY_TEXTURE_NAME}, {STD_OPACITY_TEXTURE_UV}, textureBias).{STD_OPACITY_TEXTURE_CHANNEL};
        #endif

        #ifdef STD_OPACITY_VERTEX
        dAlpha *= clamp(vVertexColor.{STD_OPACITY_VERTEX_CHANNEL}, 0.0, 1.0);
        #endif
    }

`;