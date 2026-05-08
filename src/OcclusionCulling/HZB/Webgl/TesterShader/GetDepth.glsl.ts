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
        float even = float((mip & 1) == 0);
        return mix(
            convertDepth(textureLod(uHZB2, uv, lod)),
            convertDepth(textureLod(uHZB1, uv, lod)),
            even
        );
    }
`;