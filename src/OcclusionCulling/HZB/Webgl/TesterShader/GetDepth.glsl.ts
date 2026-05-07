export default `

    #ifndef DEPTH_IS_FLOAT
        #include "floatAsUintPS"
    #endif

    float convertDepth(vec4 data) {

        #ifdef (DEPTH_IS_FLOAT || READ_DEPTH)
            return data.r;
        #else
            return uint2float(data);
        #endif
    }

    uniform highp sampler2D uHZB1;
    uniform highp sampler2D uHZB2;

    float getDepth(vec2 uv, float lod) {
        int mip = int(lod + 0.5);
        int even = 1 - (mip & 1);
        float d1 = convertDepth(textureLod(uHZB1, uv, lod));
        float d2 = convertDepth(textureLod(uHZB2, uv, lod));
        return mix(d2, d1, float(even));
    }

    /*
    return convertDepth(max(
        textureLod(uHZB1, uv, lod),
        textureLod(uHZB2, uv, lod)
    ));
    */
`;