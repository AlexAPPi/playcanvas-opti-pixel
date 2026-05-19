export default `

    #ifndef DEPTH_IS_FLOAT
        #include "floatAsUintPS"
    #endif

    float convertDepth(vec4 data) {

        #ifdef (DEPTH_IS_FLOAT || DEPTH_IS_FLOAT16 || READ_DEPTH)
            return data.r;
        #else
            return uint2float(data);
        #endif
    }

    float getDepth(vec2 uv, float lod) {
        // Convert from screen uv to hzb mips uv
        vec2 factoredUv = uHZBUvFactor.xy * uv;
        return max(
            convertDepth(textureLod(uHZB1, factoredUv, lod)),
            convertDepth(textureLod(uHZB2, factoredUv, lod))
        );
    }
`;