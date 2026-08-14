export default `

    uniform material_opacity: f32;
    uniform material_alphaDitherScale: f32;

    fn getOpacity() {
        dAlpha = uniform.material_opacity;

        #ifdef INSTANCER_USE_CROSSFADE
        dAlpha *= vInstancerInstanceCrossFade;
        #endif

        #ifdef INSTANCER_USE_CUSTOM_COLOR
            #ifdef INSTANCER_USE_CUSTOM_OPACITY
            dAlpha *= vInstancerInstanceCustomColor.a;
            #endif
        #endif

        #ifdef STD_OPACITY_TEXTURE
        dAlpha = dAlpha * textureSampleBias({STD_OPACITY_TEXTURE_NAME}, {STD_OPACITY_TEXTURE_NAME}Sampler, {STD_OPACITY_TEXTURE_UV}, uniform.textureBias).{STD_OPACITY_TEXTURE_CHANNEL};
        #endif

        #ifdef STD_OPACITY_VERTEX
        dAlpha = dAlpha * clamp(vVertexColor.{STD_OPACITY_VERTEX_CHANNEL}, 0.0, 1.0);
        #endif
    }

`;