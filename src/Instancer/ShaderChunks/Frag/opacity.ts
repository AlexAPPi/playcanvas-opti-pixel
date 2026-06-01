export default `

    uniform float material_opacity;
    uniform float material_alphaDitherScale;

    const float dither4x4[16] = float[](
        1.0, 9.0, 3.0, 11.0,
        13.0, 5.0, 15.0, 7.0,
        4.0, 12.0, 2.0, 10.0,
        16.0, 8.0, 14.0, 6.0
    );

    float getDither() {
        ivec2 screenPos = ivec2(gl_FragCoord.xy);
        int idx = (screenPos.y & 3) * 4 + (screenPos.x & 3);
        return dither4x4[idx] / 16.0; // 0.0625..1.0
    }

    void getOpacity() {
        dAlpha = material_opacity;

        #if INSTANCER_USE_CROSSFADE
        dAlpha *= vInstancerCrossFade * getDither();
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